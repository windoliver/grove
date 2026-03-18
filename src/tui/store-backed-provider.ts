/**
 * Store-backed base class for TUI data providers.
 *
 * Extracts the shared implementation that is identical between
 * {@link LocalDataProvider} and {@link NexusDataProvider}. Subclasses
 * only need to supply the concrete store instances, set the `mode`
 * property, and override any methods whose behaviour diverges
 * (e.g. artifacts, VFS, search).
 */

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
import type { GoalSessionStore } from "../local/sqlite-goal-session-store.js";
import type {
  ActivityQuery,
  ArtifactMeta,
  ClaimInput,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  GitHubPRSummary,
  GoalData,
  GroveMetadata,
  InboxMessage,
  OperatorStats,
  PaginatedQuery,
  PendingQuestion,
  ProviderCapabilities,
  SessionCostSummary,
  SessionInput,
  SessionRecord,
  TuiArtifactProvider,
  TuiAskUserProvider,
  TuiCostProvider,
  TuiDataProvider,
  TuiGitHubProvider,
  TuiGoalProvider,
  TuiMessagingProvider,
  TuiOutcomeProvider,
  TuiSessionProvider,
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

// ---------------------------------------------------------------------------
// Dependency bundle accepted by the constructor
// ---------------------------------------------------------------------------

/** Dependencies required to construct a {@link StoreBackedProvider}. */
export interface StoreBackedProviderDeps {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: FrontierCalculator;
  readonly groveName: string;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly workspace?: WorkspaceManager | undefined;
  readonly backendLabel?: string | undefined;
  readonly goalSessionStore?: GoalSessionStore | undefined;
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

/**
 * Abstract base class that implements every TUI provider method whose
 * logic is identical between the local and Nexus backends.
 *
 * Subclasses must:
 *  - Set {@link mode} to a short identifier (e.g. `"local"` or `"nexus"`).
 *  - Set {@link capabilities} to declare which optional interfaces are available.
 *  - Override {@link closeExtra} if they own additional closeable resources.
 */
export abstract class StoreBackedProvider
  implements
    TuiDataProvider,
    TuiOutcomeProvider,
    TuiArtifactProvider,
    TuiMessagingProvider,
    TuiCostProvider,
    TuiAskUserProvider,
    TuiGitHubProvider,
    TuiGoalProvider,
    TuiSessionProvider
{
  /** Declares which optional provider interfaces this instance supports. */
  abstract readonly capabilities: ProviderCapabilities;

  /**
   * Short mode identifier surfaced in {@link GroveMetadata.mode}.
   * Subclasses set this to `"local"`, `"nexus"`, etc.
   */
  protected abstract readonly mode: string;

  protected readonly store: ContributionStore;
  protected readonly claims: ClaimStore;
  protected readonly calc: FrontierCalculator;
  protected readonly name: string;
  protected readonly outcomes: OutcomeStore | undefined;
  protected readonly workspace: WorkspaceManager | undefined;
  protected readonly label: string;
  protected readonly goalSession: GoalSessionStore | undefined;

  constructor(deps: StoreBackedProviderDeps) {
    this.store = deps.contributionStore;
    this.claims = deps.claimStore;
    this.calc = deps.frontier;
    this.name = deps.groveName;
    this.outcomes = deps.outcomeStore;
    this.workspace = deps.workspace;
    this.label = deps.backendLabel ?? this.name;
    this.goalSession = deps.goalSessionStore;
  }

  // ---------------------------------------------------------------------------
  // TuiDataProvider — dashboard
  // ---------------------------------------------------------------------------

  /** Fetch aggregated dashboard data. */
  async getDashboard(): Promise<DashboardData> {
    const [
      contributionCount,
      activeClaims,
      recentContributions,
      frontier,
      goalData,
      activeSessions,
    ] = await Promise.all([
      this.store.count(),
      this.claims.activeClaims(),
      this.store.list({ limit: 10 }),
      this.calc.compute({ limit: 3 }),
      this.goalSession ? this.goalSession.getGoal() : Promise.resolve(undefined),
      this.goalSession ? this.goalSession.listSessions({ status: "active" }) : Promise.resolve([]),
    ]);

    const metadata: GroveMetadata = {
      name: this.name,
      contributionCount,
      activeClaimCount: activeClaims.length,
      mode: this.mode,
      backendLabel: this.label,
      ...(goalData ? { goal: goalData.goal } : {}),
      ...(activeSessions.length > 0 ? { activeSessionId: activeSessions[0]?.sessionId } : {}),
    };

    return {
      metadata,
      activeClaims,
      recentContributions,
      frontierSummary: buildFrontierSummary(frontier),
    };
  }

  // ---------------------------------------------------------------------------
  // TuiDataProvider — contributions
  // ---------------------------------------------------------------------------

  /** List contributions with optional pagination and filters. */
  async getContributions(
    query?: ContributionQuery & PaginatedQuery,
  ): Promise<readonly Contribution[]> {
    return this.store.list(query);
  }

  /** Fetch full contribution detail including ancestors, children, and thread. */
  async getContribution(cid: string): Promise<ContributionDetail | undefined> {
    return contributionDetailFromStore(this.store, cid);
  }

  // ---------------------------------------------------------------------------
  // TuiDataProvider — claims
  // ---------------------------------------------------------------------------

  /** List claims with optional status / agent filters. */
  async getClaims(query?: ClaimsQuery): Promise<readonly Claim[]> {
    return claimsFromStore(this.claims, query);
  }

  /** Create a new claim for an agent. */
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

  /** Check out (or create) a workspace for an agent. Returns the workspace path. */
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

  /** Renew a claim's lease via heartbeat. */
  async heartbeatClaim(claimId: string, leaseDurationMs?: number): Promise<Claim> {
    return this.claims.heartbeat(claimId, leaseDurationMs);
  }

  /** Release a claim by transitioning it to "released" status. */
  async releaseClaim(claimId: string): Promise<void> {
    await this.claims.release(claimId);
  }

  /** Clean up a workspace directory by targetRef and agentId. */
  async cleanWorkspace(targetRef: string, agentId: string): Promise<void> {
    if (!this.workspace) return;
    try {
      await this.workspace.cleanWorkspace(targetRef, agentId);
    } catch {
      // Workspace might already be cleaned or not exist
    }
  }

  // ---------------------------------------------------------------------------
  // TuiDataProvider — frontier, activity, DAG, threads
  // ---------------------------------------------------------------------------

  /** Compute frontier. */
  async getFrontier(query?: FrontierQuery): Promise<Frontier> {
    return this.calc.compute(query);
  }

  /** Recent contributions as an activity stream. */
  async getActivity(query?: ActivityQuery): Promise<readonly Contribution[]> {
    return activityFromStore(this.store, query);
  }

  /** Get contributions for DAG rendering. */
  async getDag(rootCid?: string): Promise<DagData> {
    return dagFromStore(this.store, rootCid);
  }

  /** Hot discussion threads. */
  async getHotThreads(limit = 20): Promise<readonly ThreadSummary[]> {
    return this.store.hotThreads({ limit });
  }

  // ---------------------------------------------------------------------------
  // TuiArtifactProvider — subclasses must implement getArtifact, getArtifactMeta,
  // and search. The diffArtifacts default delegates to getArtifact.
  // ---------------------------------------------------------------------------

  /** Retrieve artifact content. Subclasses implement based on their storage backend. */
  abstract getArtifact(cid: string, name: string): Promise<Buffer>;

  /** Retrieve artifact metadata. Subclasses implement based on their storage backend. */
  abstract getArtifactMeta(cid: string, name: string): Promise<ArtifactMeta>;

  /** Full-text search over contributions. Subclasses implement based on their storage backend. */
  abstract search(query: string): Promise<readonly Contribution[]>;

  /**
   * Compute a diff between two artifact versions.
   *
   * Default implementation fetches both artifacts via {@link getArtifact}
   * and converts them to UTF-8 strings. Subclasses can override if they
   * have a more efficient diff mechanism.
   */
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

  // ---------------------------------------------------------------------------
  // TuiOutcomeProvider
  // ---------------------------------------------------------------------------

  /** Get the outcome record for a single contribution CID. */
  async getOutcome(cid: string): Promise<OutcomeRecord | undefined> {
    return this.outcomes?.get(cid);
  }

  /** Get outcome records for multiple CIDs in a single batch. */
  async getOutcomes(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    if (!this.outcomes) return new Map();
    return this.outcomes.getBatch(cids);
  }

  /** Get aggregated outcome statistics. */
  async getOutcomeStats(): Promise<OperatorStats> {
    return outcomeStatsFromStore(this.outcomes);
  }

  /** List outcome records with optional status filter. */
  async listOutcomes(query?: { status?: OutcomeStatus }): Promise<readonly OutcomeRecord[]> {
    if (!this.outcomes) return [];
    return this.outcomes.list(query);
  }

  // ---------------------------------------------------------------------------
  // TuiMessagingProvider
  // ---------------------------------------------------------------------------

  /** Read inbox messages with optional recipient / limit filters. */
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

  /** Get session cost summary aggregated across all agents. */
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

  /** List pending ask-user questions. */
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

  /** Answer a pending ask-user question. */
  async answerQuestion(questionCid: string, answer: string): Promise<void> {
    const operator = { agentId: "tui-operator", agentName: "operator" };
    await answerQuestionOp(this.store, { questionCid, answer, operator }, computeCid);
  }

  // ---------------------------------------------------------------------------
  // TuiGitHubProvider
  // ---------------------------------------------------------------------------

  /** Get the active GitHub PR summary for the current repository, if any. */
  async getActivePR(): Promise<GitHubPRSummary | undefined> {
    return getActivePR();
  }

  // ---------------------------------------------------------------------------
  // TuiGoalProvider — delegates to goalSession store when available
  // ---------------------------------------------------------------------------

  /** Get the current goal. Returns `undefined` when no store is configured. */
  async getGoal(): Promise<GoalData | undefined> {
    return this.goalSession?.getGoal();
  }

  /** Set a goal. Throws when no store is configured. */
  async setGoal(goal: string, acceptance: readonly string[]): Promise<GoalData> {
    if (!this.goalSession) {
      throw new Error("Goal management is not supported by this provider");
    }
    return this.goalSession.setGoal(goal, acceptance, "tui-operator");
  }

  // ---------------------------------------------------------------------------
  // TuiSessionProvider — delegates to goalSession store when available
  // ---------------------------------------------------------------------------

  /** List sessions. Returns an empty array when no store is configured. */
  async listSessions(query?: {
    status?: "active" | "archived";
  }): Promise<readonly SessionRecord[]> {
    return this.goalSession?.listSessions(query) ?? [];
  }

  /** Create a new session. Throws when no store is configured. */
  async createSession(input: SessionInput): Promise<SessionRecord> {
    if (!this.goalSession) {
      throw new Error("Session management is not supported by this provider");
    }
    return this.goalSession.createSession(input);
  }

  /** Get a session by ID. Returns `undefined` when no store is configured. */
  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.goalSession?.getSession(sessionId);
  }

  /** Archive a session. Throws when no store is configured. */
  async archiveSession(sessionId: string): Promise<void> {
    if (!this.goalSession) {
      throw new Error("Session management is not supported by this provider");
    }
    return this.goalSession.archiveSession(sessionId);
  }

  /** Associate a contribution with a session. Throws when no store is configured. */
  async addContributionToSession(sessionId: string, cid: string): Promise<void> {
    if (!this.goalSession) {
      throw new Error("Session management is not supported by this provider");
    }
    return this.goalSession.addContributionToSession(sessionId, cid);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Release all resources owned by this provider.
   *
   * Closes the core stores (contribution, claim, outcome, workspace)
   * then invokes {@link closeExtra} so subclasses can clean up any
   * additional resources (e.g. bounty stores, CAS, Nexus client).
   */
  close(): void {
    this.store.close();
    this.claims.close();
    this.outcomes?.close();
    this.workspace?.close();
    this.goalSession?.close();
    this.closeExtra();
  }

  /**
   * Hook for subclasses to release additional resources during {@link close}.
   * Called after the core stores have been closed. Override this instead of
   * `close()` to avoid forgetting the base cleanup.
   *
   * Default implementation is a no-op.
   */
  protected closeExtra(): void {
    // no-op — subclasses override as needed
  }
}
