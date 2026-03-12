/**
 * Local data provider for the TUI.
 *
 * Wraps the local SQLite stores and frontier calculator to implement
 * the TuiDataProvider + TuiOutcomeProvider interfaces. Used when
 * running `grove tui` against a local .grove directory.
 */

import type { ContentStore } from "../core/cas.js";
import type { Frontier, FrontierCalculator, FrontierQuery } from "../core/frontier.js";
import type { AgentIdentity, Claim, Contribution } from "../core/models.js";
import type { OutcomeRecord, OutcomeStatus, OutcomeStore } from "../core/outcome.js";
import type {
  ClaimStore,
  ContributionQuery,
  ContributionStore,
  ThreadSummary,
} from "../core/store.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type {
  ActivityQuery,
  ArtifactMeta,
  ClaimInput,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  OperatorStats,
  PaginatedQuery,
  ProviderCapabilities,
  TuiArtifactProvider,
  TuiDataProvider,
  TuiOutcomeProvider,
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

/** Configuration for the local provider. */
export interface LocalProviderDeps {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: FrontierCalculator;
  readonly groveName: string;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly cas?: ContentStore | undefined;
  readonly workspace?: WorkspaceManager | undefined;
}

/** TUI data provider backed by local SQLite stores. */
export class LocalDataProvider implements TuiDataProvider, TuiOutcomeProvider, TuiArtifactProvider {
  readonly capabilities: ProviderCapabilities;
  private readonly store: ContributionStore;
  private readonly claims: ClaimStore;
  private readonly calc: FrontierCalculator;
  private readonly name: string;
  private readonly outcomes: OutcomeStore | undefined;
  private readonly cas: ContentStore | undefined;
  private readonly workspace: WorkspaceManager | undefined;

  constructor(deps: LocalProviderDeps) {
    this.store = deps.contributionStore;
    this.claims = deps.claimStore;
    this.calc = deps.frontier;
    this.name = deps.groveName;
    this.outcomes = deps.outcomeStore;
    this.cas = deps.cas;
    this.workspace = deps.workspace;
    this.capabilities = {
      outcomes: deps.outcomeStore !== undefined,
      artifacts: deps.cas !== undefined,
      vfs: false,
    };
  }

  async getDashboard(): Promise<DashboardData> {
    return dashboardFromStores(this.store, this.claims, this.calc, this.name, "local");
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
      // Fall back to a bare workspace directory so the agent gets an isolated
      // working directory that the reconciler can still track.
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

  async getFrontier(query?: FrontierQuery): Promise<Frontier> {
    return this.calc.compute(query);
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
  // TuiOutcomeProvider
  // ---------------------------------------------------------------------------

  async getOutcome(cid: string): Promise<OutcomeRecord | undefined> {
    return this.outcomes?.get(cid);
  }

  async getOutcomes(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    if (!this.outcomes) return new Map();
    return this.outcomes.getBatch(cids);
  }

  async getOutcomeStats(): Promise<OperatorStats> {
    return outcomeStatsFromStore(this.outcomes);
  }

  async listOutcomes(query?: { status?: OutcomeStatus }): Promise<readonly OutcomeRecord[]> {
    if (!this.outcomes) return [];
    return this.outcomes.list(query);
  }

  // ---------------------------------------------------------------------------
  // TuiArtifactProvider
  // ---------------------------------------------------------------------------

  async getArtifact(cid: string, name: string): Promise<Buffer> {
    const contribution = await this.store.get(cid);
    if (!contribution) throw new Error(`Contribution not found: ${cid}`);

    const contentHash = contribution.artifacts[name];
    if (contentHash === undefined) {
      throw new Error(`Artifact '${name}' not found on contribution ${cid}`);
    }

    if (this.cas) {
      const data = await this.cas.get(contentHash);
      if (data) return Buffer.from(data);
    }

    // Fallback: return the content hash as a buffer
    return Buffer.from(contentHash, "utf-8");
  }

  async getArtifactMeta(cid: string, name: string): Promise<ArtifactMeta> {
    const contribution = await this.store.get(cid);
    if (!contribution) throw new Error(`Contribution not found: ${cid}`);

    const contentHash = contribution.artifacts[name];
    if (contentHash === undefined) {
      throw new Error(`Artifact '${name}' not found on contribution ${cid}`);
    }

    if (this.cas) {
      const stat = await this.cas.stat(contentHash);
      if (stat) {
        return { sizeBytes: stat.sizeBytes, mediaType: stat.mediaType };
      }
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
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.store.close();
    this.claims.close();
    this.outcomes?.close();
    this.cas?.close();
    this.workspace?.close();
  }
}
