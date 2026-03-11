/**
 * Nexus data provider for the TUI.
 *
 * Wraps NexusContributionStore, NexusClaimStore, NexusOutcomeStore,
 * and NexusCas to implement TuiDataProvider + TuiOutcomeProvider +
 * TuiArtifactProvider + TuiVfsProvider. Used when running `grove tui --nexus <url>`.
 */

import type { Frontier, FrontierQuery } from "../core/frontier.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import type { Contribution } from "../core/models.js";
import type { OutcomeRecord, OutcomeStatus } from "../core/outcome.js";
import type { ContributionQuery, ThreadSummary } from "../core/store.js";
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
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  FsEntry,
  GroveMetadata,
  OperatorStats,
  PaginatedQuery,
  ProviderCapabilities,
  TuiArtifactProvider,
  TuiDataProvider,
  TuiOutcomeProvider,
  TuiVfsProvider,
} from "./provider.js";
import { buildFrontierSummary } from "./provider-utils.js";

/** Configuration for the Nexus provider. */
export interface NexusProviderConfig {
  readonly nexusConfig: NexusConfig;
  readonly groveName?: string | undefined;
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

  constructor(config: NexusProviderConfig) {
    this.store = new NexusContributionStore(config.nexusConfig);
    this.claims = new NexusClaimStore(config.nexusConfig);
    this.outcomes = new NexusOutcomeStore(config.nexusConfig);
    this.frontier = new DefaultFrontierCalculator(this.store);
    this.name = config.groveName ?? "nexus";

    const resolved = resolveConfig(config.nexusConfig);
    this.client = resolved.client;
    this.zoneId = resolved.zoneId;
  }

  // ---------------------------------------------------------------------------
  // TuiDataProvider
  // ---------------------------------------------------------------------------

  async getDashboard(): Promise<DashboardData> {
    const [contributionCount, activeClaims, recentContributions, frontier] = await Promise.all([
      this.store.count(),
      this.claims.activeClaims(),
      this.store.list({ limit: 10 }),
      this.frontier.compute({ limit: 3 }),
    ]);

    const metadata: GroveMetadata = {
      name: this.name,
      contributionCount,
      activeClaimCount: activeClaims.length,
      mode: "nexus",
    };

    return {
      metadata,
      activeClaims,
      recentContributions,
      frontierSummary: buildFrontierSummary(frontier),
    };
  }

  async getContributions(
    query?: ContributionQuery & PaginatedQuery,
  ): Promise<readonly Contribution[]> {
    return this.store.list(query);
  }

  async getContribution(cid: string): Promise<ContributionDetail | undefined> {
    const contribution = await this.store.get(cid);
    if (!contribution) return undefined;

    const [ancestors, children, thread] = await Promise.all([
      this.store.ancestors(cid),
      this.store.children(cid),
      this.store.thread(cid, { maxDepth: 20, limit: 50 }),
    ]);

    return { contribution, ancestors, children, thread };
  }

  async getClaims(query?: ClaimsQuery): Promise<readonly import("../core/models.js").Claim[]> {
    if (!query || query.status === "active") {
      if (query?.agentId) {
        return this.claims.listClaims({ status: "active", agentId: query.agentId });
      }
      return this.claims.activeClaims();
    }
    return this.claims.listClaims({ agentId: query.agentId });
  }

  async getFrontier(query?: FrontierQuery): Promise<Frontier> {
    return this.frontier.compute(query);
  }

  async getActivity(query?: ActivityQuery): Promise<readonly Contribution[]> {
    return this.store.list({
      kind: query?.kind,
      tags: query?.tags ? [...query.tags] : undefined,
      agentId: query?.agentId,
      limit: query?.limit ?? 100,
      offset: query?.offset,
    });
  }

  async getDag(rootCid?: string): Promise<DagData> {
    if (rootCid) {
      const visited = new Set<string>();
      const queue: string[] = [rootCid];
      const result: Contribution[] = [];

      while (queue.length > 0 && result.length < 200) {
        const cid = queue.shift();
        if (cid === undefined) break;
        if (visited.has(cid)) continue;
        visited.add(cid);

        const contribution = await this.store.get(cid);
        if (!contribution) continue;
        result.push(contribution);

        const children = await this.store.children(cid);
        for (const child of children) {
          if (!visited.has(child.cid)) {
            queue.push(child.cid);
          }
        }
      }

      return { contributions: result };
    }

    const contributions = await this.store.list({ limit: 200 });
    return { contributions };
  }

  async getHotThreads(limit = 20): Promise<readonly ThreadSummary[]> {
    return this.store.hotThreads({ limit });
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
    const stats = await this.outcomes.getStats();
    return {
      totalContributions: stats.total,
      outcomeBreakdown: {
        accepted: stats.accepted,
        rejected: stats.rejected,
        crashed: stats.crashed,
        invalidated: stats.invalidated,
      },
      acceptanceRate: stats.acceptanceRate,
      byAgent: [],
    };
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
    return { parent: parentBuf.toString("utf-8"), child: childBuf.toString("utf-8") };
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
  }
}
