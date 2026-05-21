/**
 * Store-backed base class for TUI data providers.
 *
 * Extracts the shared implementation that is identical between
 * {@link LocalDataProvider} and {@link NexusDataProvider}. Subclasses
 * only need to supply the concrete store instances, set the `mode`
 * property, and override any methods whose behaviour diverges
 * (e.g. artifacts, VFS, search).
 */

import type { AgentTaskView } from "../core/agent-task.js";
import type { Frontier, FrontierCalculator, FrontierQuery } from "../core/frontier.js";
import type { Handoff, HandoffQuery, HandoffStore } from "../core/handoff.js";
import { computeCid } from "../core/manifest.js";
import type { AgentIdentity, Claim, Contribution } from "../core/models.js";
import {
  answerQuestion as answerQuestionOp,
  listPendingQuestions,
} from "../core/operations/ask-user-bus.js";
import { getSessionCosts as getSessionCostsOp } from "../core/operations/cost-tracking.js";
import type { InboxReadSource } from "../core/operations/inbox-delegation.js";
import { readInboxWithSource } from "../core/operations/inbox-delegation.js";
import type { OutcomeRecord, OutcomeStatus, OutcomeStore } from "../core/outcome.js";
import type {
  AgentTaskStore,
  ClaimStore,
  ContributionQuery,
  ContributionStore,
  ThreadSummary,
} from "../core/store.js";
import type { SessionTimeline, WorkBlock } from "../core/timeline.js";
import type { TimelineStore } from "../core/timeline-store.js";
import type { WorkspaceManager } from "../core/workspace.js";
import { getActivePR } from "../github/active-pr.js";
import type { GoalSessionStore } from "../local/sqlite-goal-session-store.js";
import { debugLog } from "./debug-log.js";
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
  TuiHandoffProvider,
  TuiMessagingProvider,
  TuiOutcomeProvider,
  TuiSessionProvider,
} from "./provider.js";
import {
  activityFromStore,
  claimsFromStore,
  contributionsForCidsInOrder,
  contributionDetailFromStore,
  dagFromStore,
  diffArtifactsFromBuffers,
  HttpConflictError,
  outcomeStatsFromStore,
} from "./provider-shared.js";
import { buildFrontierSummary } from "./provider-utils.js";
import type { DangerousToken } from "./safety/index.js";

// ---------------------------------------------------------------------------
// Dependency bundle accepted by the constructor
// ---------------------------------------------------------------------------

/** Dependencies required to construct a {@link StoreBackedProvider}. */
export interface StoreBackedProviderDeps {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly agentTaskStore?: AgentTaskStore | undefined;
  readonly frontier: FrontierCalculator;
  readonly groveName: string;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly workspace?: WorkspaceManager | undefined;
  readonly backendLabel?: string | undefined;
  readonly goalSessionStore?: GoalSessionStore | undefined;
  readonly handoffStore?: HandoffStore | undefined;
  readonly timelineStore?: TimelineStore | undefined;
  readonly inboxReadSource?: InboxReadSource | undefined;
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
    TuiSessionProvider,
    TuiHandoffProvider
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
  protected readonly tasks: AgentTaskStore | undefined;
  protected readonly calc: FrontierCalculator;
  protected readonly name: string;
  protected readonly outcomes: OutcomeStore | undefined;
  protected readonly workspace: WorkspaceManager | undefined;
  protected readonly label: string;
  protected readonly goalSession: GoalSessionStore | undefined;
  protected readonly handoffs: HandoffStore | undefined;
  protected readonly timeline: TimelineStore | undefined;
  protected inboxReadSource: InboxReadSource | undefined;

  /**
   * Public accessor for the handoff store. NexusWsBridge needs direct
   * access to mark handoffs delivered / dead-lettered in response to IPC
   * lifecycle events; without this, the bridge's bookkeeping would be
   * dead code in production because the store is only passed through the
   * provider's constructor. Returns undefined for backends without
   * handoff support.
   */
  getHandoffStore(): HandoffStore | undefined {
    return this.handoffs;
  }

  /** Set by {@link setSessionScope} — scopes all contribution queries to this session. */
  protected activeSessionId: string | undefined;

  /**
   * Listeners that fire when {@link setSessionScope} flips the scope on/off.
   * The boolean argument is `true` when a scope is now active, `false` when
   * cleared. PR2 (#388) uses this to stop unscoped watch streams as soon
   * as a session is selected — until `/api/watch` accepts a `sessionId`,
   * a running factory would otherwise keep pulling cross-session data
   * (Codex round 2, finding 1).
   */
  private readonly scopeListeners = new Set<(scoped: boolean) => void>();

  constructor(deps: StoreBackedProviderDeps) {
    this.store = deps.contributionStore;
    this.claims = deps.claimStore;
    this.tasks = deps.agentTaskStore;
    this.calc = deps.frontier;
    this.name = deps.groveName;
    this.outcomes = deps.outcomeStore;
    this.workspace = deps.workspace;
    this.label = deps.backendLabel ?? this.name;
    this.goalSession = deps.goalSessionStore;
    this.handoffs = deps.handoffStore;
    this.timeline = deps.timelineStore;
    this.inboxReadSource = deps.inboxReadSource;
  }

  // ---------------------------------------------------------------------------
  // Session scoping
  // ---------------------------------------------------------------------------

  /**
   * Scope all subsequent contribution queries to the given session.
   * Called by screen-manager.tsx when a session is started.
   * NexusDataProvider overrides this to also swap the store instance.
   */
  setSessionScope(sessionId: string): void {
    const prev = this.activeSessionId;
    this.activeSessionId = sessionId;
    if (prev === undefined) {
      for (const fn of [...this.scopeListeners]) {
        try {
          fn(true);
        } catch (err) {
          process.stderr.write(`[provider] scope listener threw: ${String(err)}\n`);
        }
      }
    }
  }

  /**
   * Whether a session scope is currently active. Migrated views (PR2 #388)
   * use this to gate the informer hook path: the watch protocol does not
   * yet support sessionId filtering, so when scoped, a global watch cache
   * would leak contributions from other sessions. Scoped views fall back
   * to provider polling (which honors sessionId) until PR3+ extends the
   * watch protocol.
   */
  hasSessionScope(): boolean {
    return this.activeSessionId !== undefined;
  }

  /**
   * Subscribe to scope on/off transitions. Returns an unsubscribe.
   * PR2 (#388) hooks the InformerProvider into this so it can stop the
   * remote watch streams as soon as the user enters a scoped session.
   */
  onSessionScopeChange(listener: (scoped: boolean) => void): () => void {
    this.scopeListeners.add(listener);
    return () => {
      this.scopeListeners.delete(listener);
    };
  }

  protected setInboxReadSource(source: InboxReadSource | undefined): void {
    this.inboxReadSource = source;
  }

  // ---------------------------------------------------------------------------
  // TuiDataProvider — dashboard
  // ---------------------------------------------------------------------------

  /** Fetch aggregated dashboard data. */
  async getDashboard(): Promise<DashboardData> {
    const sessionFilter = this.activeSessionId ? { sessionId: this.activeSessionId } : undefined;

    const [contributionCount, recentContributions, frontier, goalData, activeSessions] =
      await Promise.all([
        this.store.count(sessionFilter),
        this.store.list({ limit: 10, ...sessionFilter }),
        this.calc.compute({ limit: 3, ...sessionFilter }),
        this.goalSession ? this.goalSession.getGoal() : Promise.resolve(undefined),
        this.goalSession
          ? this.goalSession.listSessions({ status: "active" })
          : Promise.resolve([]),
      ]);

    // Claims have no session ownership — suppress when session-scoped to avoid
    // cross-session pollution of dashboard counts and role-status indicators.
    const activeClaims = this.activeSessionId ? [] : await this.claims.activeClaims();

    const metadata: GroveMetadata = {
      name: this.name,
      contributionCount,
      activeClaimCount: activeClaims.length,
      mode: this.mode,
      backendLabel: this.label,
      ...(goalData ? { goal: goalData.goal } : {}),
      ...(activeSessions.length > 0 ? { activeSessionId: activeSessions[0]?.id } : {}),
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
    const effectiveQuery =
      this.activeSessionId !== undefined ? { ...query, sessionId: this.activeSessionId } : query;
    const result = await this.store.list(effectiveQuery);
    debugLog(
      "provider.getContributions",
      `count=${result.length} query=${JSON.stringify(effectiveQuery ?? {})}`,
    );
    return result;
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

  async getAgentTasks(): Promise<readonly AgentTaskView[]> {
    return this.tasks === undefined ? [] : this.tasks.listAgentTasks();
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
    const effectiveQuery =
      this.activeSessionId !== undefined ? { ...query, sessionId: this.activeSessionId } : query;
    return this.calc.compute(effectiveQuery);
  }

  /** Recent contributions as an activity stream. */
  async getActivity(query?: ActivityQuery): Promise<readonly Contribution[]> {
    if (this.activeSessionId !== undefined) {
      return this.store.list({
        kind: query?.kind,
        tags: query?.tags ? [...query.tags] : undefined,
        agentId: query?.agentId,
        limit: query?.limit ?? 100,
        offset: query?.offset,
        sessionId: this.activeSessionId,
      });
    }
    return activityFromStore(this.store, query);
  }

  /** Get contributions for DAG rendering. */
  async getDag(rootCid?: string): Promise<DagData> {
    if (this.activeSessionId !== undefined) {
      // Scope DAG to the current session's contributions only
      const contributions = await this.store.list({
        limit: 100,
        sessionId: this.activeSessionId,
      });
      return { contributions };
    }
    return dagFromStore(this.store, rootCid);
  }

  /** Hot discussion threads. */
  async getHotThreads(limit = 20): Promise<readonly ThreadSummary[]> {
    if (this.activeSessionId !== undefined) {
      // Hot threads are cross-session analysis — suppress when session-scoped
      return [];
    }
    return this.store.hotThreads({ limit });
  }

  /** List WorkBlocks for timeline-aware providers. */
  async getWorkBlocks(query?: {
    readonly sessionId?: string | undefined;
  }): Promise<readonly WorkBlock[]> {
    if (this.timeline === undefined) return [];
    return this.timeline.listWorkBlocks({
      sessionId: query?.sessionId ?? this.activeSessionId,
    });
  }

  /** Fetch SessionTimeline from the backing timeline store. */
  async getTimeline(query?: {
    readonly sessionId?: string | undefined;
    readonly afterRv?: string | undefined;
    readonly limit?: number | undefined;
    readonly includeWorkBlocks?: boolean | undefined;
  }): Promise<SessionTimeline> {
    const sessionId = query?.sessionId ?? this.activeSessionId;
    if (this.timeline === undefined) {
      return {
        ...(sessionId === undefined ? {} : { sessionId }),
        events: [],
        ...(query?.includeWorkBlocks === true ? { workBlocks: [] } : {}),
        timelineResourceVersion: "0",
      };
    }
    const events = await this.timeline.listTimelineEvents({
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(query?.afterRv === undefined ? {} : { afterRv: query.afterRv }),
      ...(query?.limit === undefined ? {} : { limit: query.limit }),
    });
    const workBlocks =
      query?.includeWorkBlocks === true
        ? await this.timeline.listWorkBlocks({
            ...(sessionId === undefined ? {} : { sessionId }),
          })
        : undefined;
    return {
      ...(sessionId === undefined ? {} : { sessionId }),
      events,
      ...(workBlocks === undefined ? {} : { workBlocks }),
      timelineResourceVersion: await this.timeline.currentTimelineResourceVersion(sessionId),
    };
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
    const messages = await readInboxWithSource(
      this.store,
      {
        recipient: query?.recipient,
        limit: query?.limit,
        ...(this.activeSessionId !== undefined ? { sessionId: this.activeSessionId } : {}),
      },
      this.inboxReadSource,
    );
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
    const costs = await getSessionCostsOp(
      this.store,
      this.activeSessionId !== undefined ? { sessionId: this.activeSessionId } : undefined,
    );
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
    const questions = await listPendingQuestions(
      this.store,
      this.activeSessionId !== undefined ? { sessionId: this.activeSessionId } : undefined,
    );
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
    const contribution = await answerQuestionOp(
      this.store,
      { questionCid, answer, operator },
      computeCid,
    );
    // Link the answer contribution to the active session so it is visible in
    // session-scoped reads and prevents the question from staying "pending" forever.
    if (this.activeSessionId !== undefined && this.goalSession !== undefined) {
      await this.goalSession
        .addContributionToSession(this.activeSessionId, contribution.cid)
        .catch(() => {
          /* best-effort */
        });
    }
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

  /**
   * Set a goal. Throws when no store is configured.
   *
   * C6 (#304): `token.ifMatch` is forwarded to the store as CAS opts.
   * A stale RV causes the store to return `rv-mismatch`; expectCasOk
   * throws, which the TUI callsite (via confirmAndMutate, T10) catches
   * to drive the refetch+retry loop.
   */
  async setGoal(
    token: DangerousToken<"Goal">,
    goal: string,
    acceptance: readonly string[],
  ): Promise<GoalData> {
    if (!this.goalSession) {
      throw new Error("Goal management is not supported by this provider");
    }
    const result = await this.goalSession.setGoal(goal, acceptance, "tui-operator", {
      ifMatch: token.ifMatch,
    });
    if (result.kind === "rv-mismatch") {
      // C6 (#304): emit a structured conflict so confirmAndMutate's
      // parseConflict matches and the modal enters the retry path with
      // the fresh RV. Generic Error from expectCasOk would lose `current`
      // and short-circuit the retry as a generic failure.
      throw new HttpConflictError(
        `setGoal: stale ifMatch=${token.ifMatch}; current rv=${result.current.resourceVersion}`,
        result.current,
      );
    }
    return result.view;
  }

  // ---------------------------------------------------------------------------
  // TuiSessionProvider — delegates to goalSession store when available
  // ---------------------------------------------------------------------------

  /** List sessions. Returns an empty array when no store is configured. */
  async listSessions(query?: {
    status?: "active" | "archived";
    presetName?: string;
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

  /** Return all contributions linked to a session, preserving session link order. */
  async getSessionContributions(sessionId: string): Promise<readonly Contribution[]> {
    if (!this.goalSession) return [];
    const cids = await this.goalSession.getSessionContributions(sessionId);
    return contributionsForCidsInOrder(this.store, cids);
  }

  /**
   * Archive a session. Throws when no store is configured.
   *
   * C6 (#304): `token.id` is the session id; `token.ifMatch` flows to
   * the store as CAS opts. Stale RV → `rv-mismatch` → expectCasOk throws
   * → caller (via confirmAndMutate, T10) refetches and retries.
   */
  async archiveSession(token: DangerousToken<"AgentSession">): Promise<void> {
    if (!this.goalSession) {
      throw new Error("Session management is not supported by this provider");
    }
    const result = await this.goalSession.archiveSession(token.id, { ifMatch: token.ifMatch });
    if (result.kind === "rv-mismatch") {
      // C6 (#304): structured conflict so confirmAndMutate's parseConflict
      // matches and the modal retries with the fresh RV.
      throw new HttpConflictError(
        `archiveSession(${token.id}): stale ifMatch=${token.ifMatch}; current rv=${result.current.resourceVersion}`,
        result.current,
      );
    }
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
   * Drop the contribution store's TTL list cache so the next read re-scans
   * the backend. Used by the SSE refresh fan-out (app.tsx) so an inbox
   * push that lands inside the cache TTL window doesn't leave the UI on
   * the pre-arrival snapshot until the next 30 s fallback poll.
   *
   * Stores without a list cache implement this as a no-op (only
   * NexusContributionStore currently has one).
   */
  invalidateCaches(): void {
    const store = this.store as ContributionStore & { invalidateListCache?: () => void };
    store.invalidateListCache?.();
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

  // ---------------------------------------------------------------------------
  // TuiHandoffProvider
  // ---------------------------------------------------------------------------

  async getHandoffs(query?: HandoffQuery): Promise<readonly Handoff[]> {
    if (this.handoffs === undefined) return [];
    // NOTE: do NOT call expireStale() here — it uses casUpdate which reads
    // the handoff file, sees "not found" (Nexus VFS cross-client isolation),
    // and OVERWRITES the MCP's handoff data with an empty array.
    // Expiry should be handled by the MCP side only.
    return this.handoffs.list(query);
  }

  async markHandoffDelivered(handoffId: string): Promise<void> {
    await this.handoffs?.markDelivered(handoffId);
  }
}
