/**
 * Nexus data provider for the TUI.
 *
 * Wraps NexusContributionStore, NexusClaimStore, NexusOutcomeStore,
 * and NexusCas to implement TuiDataProvider + TuiOutcomeProvider +
 * TuiArtifactProvider + TuiVfsProvider. Used when running `grove tui --nexus <url>`.
 */

import type { Frontier, FrontierQuery } from "../core/frontier.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import type { AgentIdentity, Claim, Contribution } from "../core/models.js";
import type { OutcomeRecord, OutcomeStatus } from "../core/outcome.js";
import type { ContributionQuery, ThreadSummary } from "../core/store.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type { NexusClient } from "../nexus/client.js";
import type { NexusConfig } from "../nexus/config.js";
import { resolveConfig } from "../nexus/config.js";
import { NexusClaimStore } from "../nexus/nexus-claim-store.js";
import { NexusContributionStore } from "../nexus/nexus-contribution-store.js";
import { NexusOutcomeStore } from "../nexus/nexus-outcome-store.js";
import { casMetaPath, casPath } from "../nexus/vfs-paths.js";
import type {
  ActivityQuery,
  ArtifactMeta,
  ClaimInput,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  FsEntry,
  OperatorStats,
  PaginatedQuery,
  ProviderCapabilities,
  TuiArtifactProvider,
  TuiDataProvider,
  TuiOutcomeProvider,
  TuiVfsProvider,
} from "./provider.js";
import {
  activityFromStore,
  claimsFromStore,
  contributionDetailFromStore,
  dagFromStore,
  dashboardFromStores,
  diffArtifactsFromBuffers,
  outcomeStatsFromStore,
} from "./provider-shared.js";

/** Configuration for the Nexus provider. */
export interface NexusProviderConfig {
  readonly nexusConfig: NexusConfig;
  readonly groveName?: string | undefined;
  /** Optional workspace manager for local workspace lifecycle (hybrid mode). */
  readonly workspaceManager?: WorkspaceManager | undefined;
}

/** TUI data provider backed by Nexus VFS. */
export class NexusDataProvider
  implements TuiDataProvider, TuiOutcomeProvider, TuiArtifactProvider, TuiVfsProvider
{
  readonly capabilities: ProviderCapabilities = {
    outcomes: true,
    artifacts: true,
    vfs: true,
  };

  private readonly store: NexusContributionStore;
  private readonly claims: NexusClaimStore;
  private readonly outcomes: NexusOutcomeStore;
  private readonly frontier: DefaultFrontierCalculator;
  private readonly client: NexusClient;
  private readonly zoneId: string;
  private readonly name: string;
  private readonly workspace: WorkspaceManager | undefined;

  constructor(config: NexusProviderConfig) {
    this.store = new NexusContributionStore(config.nexusConfig);
    this.claims = new NexusClaimStore(config.nexusConfig);
    this.outcomes = new NexusOutcomeStore(config.nexusConfig);
    this.frontier = new DefaultFrontierCalculator(this.store);
    this.name = config.groveName ?? "nexus";
    this.workspace = config.workspaceManager;

    const resolved = resolveConfig(config.nexusConfig);
    this.client = resolved.client;
    this.zoneId = resolved.zoneId;
  }

  // ---------------------------------------------------------------------------
  // TuiDataProvider
  // ---------------------------------------------------------------------------

  async getDashboard(): Promise<DashboardData> {
    return dashboardFromStores(this.store, this.claims, this.frontier, this.name, "nexus");
  }

  async getContributions(
    query?: ContributionQuery & PaginatedQuery,
  ): Promise<readonly Contribution[]> {
    return this.store.list(query);
  }

  async getContribution(cid: string): Promise<ContributionDetail | undefined> {
    return contributionDetailFromStore(this.store, cid);
  }

  async getClaims(query?: ClaimsQuery): Promise<readonly Claim[]> {
    return claimsFromStore(this.claims, query);
  }

  async getFrontier(query?: FrontierQuery): Promise<Frontier> {
    return this.frontier.compute(query);
  }

  async getActivity(query?: ActivityQuery): Promise<readonly Contribution[]> {
    return activityFromStore(this.store, query);
  }

  async getDag(rootCid?: string): Promise<DagData> {
    return dagFromStore(this.store, rootCid);
  }

  async getHotThreads(limit = 20): Promise<readonly ThreadSummary[]> {
    return this.store.hotThreads({ limit });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle (spawn / kill)
  // ---------------------------------------------------------------------------

  async createClaim(input: ClaimInput): Promise<Claim> {
    const now = new Date();
    const claim: Claim = {
      claimId: crypto.randomUUID(),
      targetRef: input.targetRef,
      agent: input.agent,
      status: "active",
      intentSummary: input.intentSummary,
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs).toISOString(),
      ...(input.context !== undefined ? { context: input.context } : {}),
    };
    return this.claims.claimOrRenew(claim);
  }

  async checkoutWorkspace(targetRef: string, agent: AgentIdentity): Promise<string> {
    if (!this.workspace) {
      throw new Error("Workspace manager not available");
    }
    try {
      const info = await this.workspace.checkout(targetRef, { agent });
      return info.workspacePath;
    } catch {
      // For TUI-spawned agents, targetRef is a spawnId (not a contribution CID).
      // Fall back to a bare workspace directory.
      const info = await this.workspace.createBareWorkspace(targetRef, { agent });
      return info.workspacePath;
    }
  }

  async heartbeatClaim(claimId: string, leaseDurationMs?: number): Promise<Claim> {
    return this.claims.heartbeat(claimId, leaseDurationMs);
  }

  async releaseClaim(claimId: string): Promise<void> {
    await this.claims.release(claimId);
  }

  async cleanWorkspace(targetRef: string, agentId: string): Promise<void> {
    if (!this.workspace) return;
    try {
      await this.workspace.cleanWorkspace(targetRef, agentId);
    } catch {
      // Workspace might already be cleaned or not exist
    }
  }

  // ---------------------------------------------------------------------------
  // TuiOutcomeProvider
  // ---------------------------------------------------------------------------

  async getOutcome(cid: string): Promise<OutcomeRecord | undefined> {
    return this.outcomes.get(cid);
  }

  async getOutcomes(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    return this.outcomes.getBatch(cids);
  }

  async getOutcomeStats(): Promise<OperatorStats> {
    return outcomeStatsFromStore(this.outcomes);
  }

  async listOutcomes(query?: { status?: OutcomeStatus }): Promise<readonly OutcomeRecord[]> {
    return this.outcomes.list(query);
  }

  // ---------------------------------------------------------------------------
  // TuiArtifactProvider
  // ---------------------------------------------------------------------------

  async getArtifact(cid: string, name: string): Promise<Buffer> {
    const contribution = await this.store.get(cid);
    if (!contribution) {
      throw new Error(`Contribution not found: ${cid}`);
    }

    const contentHash = contribution.artifacts[name];
    if (contentHash === undefined) {
      throw new Error(`Artifact '${name}' not found on contribution ${cid}`);
    }

    const blobPath = casPath(this.zoneId, contentHash);
    const data = await this.client.read(blobPath);
    if (data === undefined) {
      throw new Error(
        `Artifact blob not found in Nexus CAS for contribution ${cid}, artifact '${name}' (hash: ${contentHash})`,
      );
    }

    return Buffer.from(data);
  }

  async getArtifactMeta(cid: string, name: string): Promise<ArtifactMeta> {
    const contribution = await this.store.get(cid);
    if (!contribution) {
      throw new Error(`Contribution not found: ${cid}`);
    }

    const contentHash = contribution.artifacts[name];
    if (contentHash === undefined) {
      throw new Error(`Artifact '${name}' not found on contribution ${cid}`);
    }

    const blobPath = casPath(this.zoneId, contentHash);
    const meta = await this.client.stat(blobPath);
    if (meta) {
      // Try reading the sidecar .meta file for media type
      const metaFilePath = casMetaPath(this.zoneId, contentHash);
      const metaData = await this.client.read(metaFilePath).catch(() => undefined);
      let mediaType: string | undefined;
      if (metaData !== undefined) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(metaData)) as {
            mediaType?: string;
          };
          mediaType = parsed.mediaType;
        } catch {
          // Ignore malformed sidecar
        }
      }

      return {
        sizeBytes: meta.size,
        mediaType: mediaType ?? meta.contentType,
      };
    }

    return { sizeBytes: 0 };
  }

  async diffArtifacts(
    parentCid: string,
    childCid: string,
    name: string,
  ): Promise<{ readonly parent: string; readonly child: string }> {
    const [parentBuf, childBuf] = await Promise.all([
      this.getArtifact(parentCid, name),
      this.getArtifact(childCid, name),
    ]);
    return diffArtifactsFromBuffers(parentBuf, childBuf);
  }

  async search(query: string): Promise<readonly Contribution[]> {
    return this.store.search(query);
  }

  // ---------------------------------------------------------------------------
  // TuiVfsProvider
  // ---------------------------------------------------------------------------

  async listPath(path: string): Promise<readonly FsEntry[]> {
    const vfsPath = `/zones/${this.zoneId}${path.startsWith("/") ? path : `/${path}`}`;
    const result = await this.client.list(vfsPath, { details: true });

    return result.files.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory ? ("directory" as const) : ("file" as const),
      sizeBytes: entry.size,
    }));
  }

  close(): void {
    this.store.close();
    this.claims.close();
    this.outcomes.close();
    this.workspace?.close();
  }
}
