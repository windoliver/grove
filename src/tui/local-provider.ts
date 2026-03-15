/**
 * Local data provider for the TUI.
 *
 * Wraps the local SQLite stores and frontier calculator to implement
 * the TuiDataProvider + TuiOutcomeProvider interfaces. Used when
 * running `grove tui` against a local .grove directory.
 */

import type { Bounty } from "../core/bounty.js";
import type { BountyQuery, BountyStore } from "../core/bounty-store.js";
import type { ContentStore } from "../core/cas.js";
import type { Frontier, FrontierCalculator, FrontierQuery } from "../core/frontier.js";
import { computeCid } from "../core/manifest.js";
import type { AgentIdentity, Claim, Contribution } from "../core/models.js";
import {
  answerQuestion as answerQuestionOp,
  listPendingQuestions,
} from "../core/operations/ask-user-bus.js";
import { getSessionCosts as getSessionCostsOp } from "../core/operations/cost-tracking.js";
import { readInbox } from "../core/operations/messaging.js";
import type { OutcomeRecord, OutcomeStatus, OutcomeStore } from "../core/outcome.js";
import type {
  ClaimStore,
  ContributionQuery,
  ContributionStore,
  ThreadSummary,
} from "../core/store.js";
import type { WorkspaceManager } from "../core/workspace.js";
import { getActivePR } from "../github/active-pr.js";
import type {
  ActivityQuery,
  ArtifactMeta,
  ClaimInput,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  GitHubPRSummary,
  GroveMetadata,
  InboxMessage,
  OperatorStats,
  PaginatedQuery,
  PendingQuestion,
  ProviderCapabilities,
  SessionCostSummary,
  TuiArtifactProvider,
  TuiAskUserProvider,
  TuiCostProvider,
  TuiDataProvider,
  TuiGitHubProvider,
  TuiMessagingProvider,
  TuiOutcomeProvider,
} from "./provider.js";
import {
  activityFromStore,
  claimsFromStore,
  contributionDetailFromStore,
  dagFromStore,
  diffArtifactsFromBuffers,
  outcomeStatsFromStore,
} from "./provider-shared.js";
import { buildFrontierSummary } from "./provider-utils.js";

/** Configuration for the local provider. */
export interface LocalProviderDeps {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: FrontierCalculator;
  readonly groveName: string;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly bountyStore?: BountyStore | undefined;
  readonly cas?: ContentStore | undefined;
  readonly workspace?: WorkspaceManager | undefined;
  readonly backendLabel?: string | undefined;
}

/** TUI data provider backed by local SQLite stores. */
export class LocalDataProvider
  implements
    TuiDataProvider,
    TuiOutcomeProvider,
    TuiArtifactProvider,
    TuiMessagingProvider,
    TuiCostProvider,
    TuiAskUserProvider,
    TuiGitHubProvider
{
  readonly capabilities: ProviderCapabilities;
  private readonly store: ContributionStore;
  private readonly claims: ClaimStore;
  private readonly calc: FrontierCalculator;
  private readonly name: string;
  private readonly outcomes: OutcomeStore | undefined;
  private readonly bounties: BountyStore | undefined;
  private readonly cas: ContentStore | undefined;
  private readonly workspace: WorkspaceManager | undefined;
  private readonly label: string;

  constructor(deps: LocalProviderDeps) {
    this.store = deps.contributionStore;
    this.claims = deps.claimStore;
    this.calc = deps.frontier;
    this.name = deps.groveName;
    this.outcomes = deps.outcomeStore;
    this.bounties = deps.bountyStore;
    this.cas = deps.cas;
    this.workspace = deps.workspace;
    this.label = deps.backendLabel ?? "local (.grove/)";
    this.capabilities = {
      outcomes: deps.outcomeStore !== undefined,
      artifacts: deps.cas !== undefined,
      vfs: false,
      messaging: true,
      costTracking: true,
      askUser: true,
      github: true,
    };
  }

  async getDashboard(): Promise<DashboardData> {
    const [contributionCount, activeClaims, recentContributions, frontier] = await Promise.all([
      this.store.count(),
      this.claims.activeClaims(),
      this.store.list({ limit: 10 }),
      this.calc.compute({ limit: 3 }),
    ]);

    const metadata: GroveMetadata = {
      name: this.name,
      contributionCount,
      activeClaimCount: activeClaims.length,
      mode: "local",
      backendLabel: this.label,
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
  // TuiMessagingProvider
  // ---------------------------------------------------------------------------

  async getInboxMessages(query?: {
    recipient?: string;
    limit?: number;
  }): Promise<readonly InboxMessage[]> {
    const messages = await readInbox(this.store, {
      recipient: query?.recipient,
      limit: query?.limit,
    });
    return messages.map((m) => ({
      cid: m.cid,
      from: {
        agentId: m.from.agentId,
        ...(m.from.agentName !== undefined ? { agentName: m.from.agentName } : {}),
      },
      body: m.body,
      recipients: m.recipients,
      createdAt: m.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // TuiCostProvider
  // ---------------------------------------------------------------------------

  async getSessionCosts(): Promise<SessionCostSummary> {
    const costs = await getSessionCostsOp(this.store);
    return {
      totalCostUsd: costs.totalCostUsd,
      totalTokens: costs.totalInputTokens + costs.totalOutputTokens,
      byAgent: costs.byAgent.map((a) => ({
        agentId: a.agentId,
        ...(a.agentName !== undefined ? { agentName: a.agentName } : {}),
        costUsd: a.totalCostUsd,
        tokens: a.totalInputTokens + a.totalOutputTokens,
        ...(a.latestContextPercent !== undefined ? { contextPercent: a.latestContextPercent } : {}),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // TuiAskUserProvider
  // ---------------------------------------------------------------------------

  async getPendingQuestions(): Promise<readonly PendingQuestion[]> {
    const questions = await listPendingQuestions(this.store);
    return questions.map((q) => ({
      cid: q.cid,
      ...(q.agent.agentName !== undefined ? { agentName: q.agent.agentName } : {}),
      question: q.question,
      ...(q.options !== undefined ? { options: q.options } : {}),
      createdAt: q.createdAt,
    }));
  }

  async answerQuestion(questionCid: string, answer: string): Promise<void> {
    const operator = { agentId: "tui-operator", agentName: "operator" };
    await answerQuestionOp(this.store, { questionCid, answer, operator }, computeCid);
  }

  // ---------------------------------------------------------------------------
  // TuiGitHubProvider
  // ---------------------------------------------------------------------------

  async getActivePR(): Promise<GitHubPRSummary | undefined> {
    return getActivePR();
  }

  // ---------------------------------------------------------------------------
  // Bounties (duck-typed — detected by bounties-panel.tsx at runtime)
  // ---------------------------------------------------------------------------

  async listBounties(query?: BountyQuery): Promise<readonly Bounty[]> {
    if (!this.bounties) return [];
    return this.bounties.listBounties(query);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.store.close();
    this.claims.close();
    this.outcomes?.close();
    this.bounties?.close();
    this.cas?.close();
    this.workspace?.close();
  }
}
