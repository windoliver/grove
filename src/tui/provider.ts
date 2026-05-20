/**
 * TUI data provider interfaces.
 *
 * View-oriented: one method per TUI view. Implementations handle
 * the details of fetching from local SQLite, remote HTTP, or Nexus.
 *
 * Provider capabilities are additive. TuiDataProvider is the base
 * (unchanged from pre-#65). TuiOutcomeProvider, TuiArtifactProvider,
 * and TuiVfsProvider are optional extensions with separate conformance
 * suites. Panels check `provider.capabilities` at runtime.
 */

import type { AgentTaskView } from "../core/agent-task.js";
import type { Frontier, FrontierQuery } from "../core/frontier.js";
import type { Handoff, HandoffQuery } from "../core/handoff.js";
import type {
  AgentIdentity,
  Claim,
  Contribution,
  ContributionKind,
  JsonValue,
} from "../core/models.js";
import type { OutcomeRecord, OutcomeStatus } from "../core/outcome.js";
import type { ContributionQuery, ThreadNode, ThreadSummary } from "../core/store.js";
import type { SessionTimeline, WorkBlock } from "../core/timeline.js";
import type { DangerousToken } from "./safety/index.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Declares which optional provider interfaces are available. */
export interface ProviderCapabilities {
  readonly outcomes: boolean;
  readonly artifacts: boolean;
  readonly vfs: boolean;
  readonly messaging: boolean;
  readonly costTracking: boolean;
  readonly askUser: boolean;
  readonly github: boolean;
  readonly bounties: boolean;
  readonly gossip: boolean;
  readonly goals: boolean;
  readonly sessions: boolean;
  readonly handoffs: boolean;
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Grove-level metadata shown in the dashboard header. */
export interface GroveMetadata {
  readonly name: string;
  readonly contributionCount: number;
  readonly activeClaimCount: number;
  readonly mode: string;
  readonly backendLabel: string;
  readonly goal?: string | undefined;
  readonly activeSessionId?: string | undefined;
}

/** Aggregated dashboard data fetched in a single call. */
export interface DashboardData {
  readonly metadata: GroveMetadata;
  readonly activeClaims: readonly Claim[];
  readonly recentContributions: readonly Contribution[];
  readonly frontierSummary: FrontierSummary;
}

/** Compact frontier summary for dashboard display. */
export interface FrontierSummary {
  readonly topByMetric: readonly {
    readonly metric: string;
    readonly cid: string;
    readonly summary: string;
    readonly value: number;
  }[];
  readonly topByAdoption: readonly {
    readonly cid: string;
    readonly summary: string;
    readonly count: number;
  }[];
}

/** Input for creating a claim via the TUI provider. */
export interface ClaimInput {
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly intentSummary: string;
  readonly leaseDurationMs: number;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

/** Options for paginated list queries. */
export interface PaginatedQuery {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Claims query with optional filters. */
export interface ClaimsQuery extends PaginatedQuery {
  readonly status?: "active" | "all" | undefined;
  readonly agentId?: string | undefined;
}

/** Activity stream query with optional filters. */
export interface ActivityQuery extends PaginatedQuery {
  readonly kind?: ContributionKind | undefined;
  readonly agentId?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

/** WorkBlock list query. */
export interface WorkBlocksQuery {
  readonly sessionId?: string | undefined;
}

/** SessionTimeline read query. */
export interface TimelineQuery {
  readonly sessionId?: string | undefined;
  readonly afterRv?: string | undefined;
  readonly limit?: number | undefined;
  readonly includeWorkBlocks?: boolean | undefined;
}

/** Full detail for a single contribution, including relations and thread. */
export interface ContributionDetail {
  readonly contribution: Contribution;
  readonly ancestors: readonly Contribution[];
  readonly children: readonly Contribution[];
  readonly thread: readonly ThreadNode[];
}

/** DAG node for graph visualization. */
export interface DagData {
  readonly contributions: readonly Contribution[];
}

/** Operator-level aggregate stats (separate from Frontier). */
export interface OperatorStats {
  readonly totalContributions: number;
  readonly outcomeBreakdown: {
    readonly accepted: number;
    readonly rejected: number;
    readonly crashed: number;
    readonly invalidated: number;
  };
  readonly acceptanceRate: number;
  readonly byAgent: readonly AgentStats[];
}

/** Per-agent outcome statistics. */
export interface AgentStats {
  readonly agentId: string;
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly acceptanceRate: number;
}

/** Artifact metadata returned by getArtifactMeta. */
export interface ArtifactMeta {
  readonly sizeBytes: number;
  readonly mediaType?: string | undefined;
}

/** VFS directory entry for Nexus zone browsing. */
export interface FsEntry {
  readonly name: string;
  readonly type: "file" | "directory";
  readonly sizeBytes?: number | undefined;
}

/** Message from inbox. */
export interface InboxMessage {
  readonly cid: string;
  readonly from: { readonly agentId: string; readonly agentName?: string };
  readonly body: string;
  readonly recipients: readonly string[];
  readonly createdAt: string;
}

/** Session cost summary. */
export interface SessionCostSummary {
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly byAgent: readonly {
    readonly agentId: string;
    readonly agentName?: string;
    readonly costUsd: number;
    readonly tokens: number;
    readonly contextPercent?: number;
  }[];
}

/** Pending ask-user question. */
export interface PendingQuestion {
  readonly cid: string;
  readonly agentName?: string;
  readonly question: string;
  readonly options?: readonly string[];
  readonly createdAt: string;
}

/** GitHub PR summary. */
export interface GitHubPRSummary {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly checksStatus: string;
  readonly reviewStatus: string;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
}

/** Goal information for the active session. */
export interface GoalData {
  readonly goal: string;
  readonly acceptance: readonly string[];
  readonly status: "active" | "completed" | "abandoned";
  readonly setAt: string;
  readonly setBy: string;
  /**
   * Optimistic-concurrency resource version persisted by the store (C6, #304).
   * Optional: legacy stores that have not yet been migrated emit `undefined`,
   * in which case CAS callers should treat the entity as version "1".
   */
  readonly resourceVersion?: number | undefined;
}

// Session types — re-exported from core for convenience.
// The canonical definitions live in src/core/session.ts.
// Import locally so the aliases can be used within this file (e.g. TuiSessionProvider).
import type { CreateSessionInput, Session } from "../core/session.js";
export type { Session as SessionRecord, CreateSessionInput as SessionInput };
type SessionRecord = Session;
type SessionInput = CreateSessionInput;

// ---------------------------------------------------------------------------
// Base provider (unchanged from pre-#65)
// ---------------------------------------------------------------------------

/** Abstract data provider for the TUI. */
export interface TuiDataProvider {
  /** Declares which optional interfaces this provider supports. */
  readonly capabilities: ProviderCapabilities;

  /** Fetch aggregated dashboard data. */
  getDashboard(): Promise<DashboardData>;

  /** List contributions with pagination. */
  getContributions(query?: ContributionQuery & PaginatedQuery): Promise<readonly Contribution[]>;

  /** Fetch full contribution detail. */
  getContribution(cid: string): Promise<ContributionDetail | undefined>;

  /** List claims with optional filters. */
  getClaims(query?: ClaimsQuery): Promise<readonly Claim[]>;

  /** Compute frontier. */
  getFrontier(query?: FrontierQuery): Promise<Frontier>;

  /** Recent contributions as activity stream. */
  getActivity(query?: ActivityQuery): Promise<readonly Contribution[]>;

  /** Get contributions for DAG rendering. */
  getDag(rootCid?: string): Promise<DagData>;

  /** Hot discussion threads. */
  getHotThreads(limit?: number): Promise<readonly ThreadSummary[]>;

  /** List WorkBlocks when the backend exposes timeline storage. */
  getWorkBlocks?(query?: WorkBlocksQuery): Promise<readonly WorkBlock[]>;

  /** Fetch an ordered SessionTimeline view when available. */
  getTimeline?(query?: TimelineQuery): Promise<SessionTimeline>;

  /** Create a claim for an agent (optional — available in local/remote modes). */
  createClaim?(input: ClaimInput): Promise<Claim>;

  /** Check out a workspace for an agent (optional). Returns the workspace path. */
  checkoutWorkspace?(targetRef: string, agent: AgentIdentity): Promise<string>;

  /** Renew a claim's lease by heartbeating (optional). */
  heartbeatClaim?(claimId: string, leaseDurationMs?: number): Promise<Claim>;

  /** List trigger-neutral agent task lifecycle records when configured. */
  getAgentTasks?(): Promise<readonly AgentTaskView[]>;

  /** Release a claim by transitioning it to "released" status (optional). */
  releaseClaim?(claimId: string): Promise<void>;

  /** Clean up a workspace directory by targetRef and agentId (optional). */
  cleanWorkspace?(targetRef: string, agentId: string): Promise<void>;

  /**
   * Drop any in-memory snapshot caches the provider is holding (e.g. the
   * NexusContributionStore list-cache). Optional — providers without TTL
   * caches need not implement this. Callers with out-of-band proof of new
   * data (SSE inbox-delivery push) should invoke this BEFORE triggering a
   * refetch so the next read does not return a stale snapshot.
   */
  invalidateCaches?(): void;

  /** Release resources. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Optional provider extensions (additive, separate conformance suites)
// ---------------------------------------------------------------------------

/** Outcome queries — available when capabilities.outcomes is true. */
export interface TuiOutcomeProvider {
  getOutcome(cid: string): Promise<OutcomeRecord | undefined>;
  getOutcomes(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>>;
  getOutcomeStats(): Promise<OperatorStats>;
  listOutcomes(query?: { status?: OutcomeStatus }): Promise<readonly OutcomeRecord[]>;
}

/** Artifact access — available when capabilities.artifacts is true. */
export interface TuiArtifactProvider {
  getArtifact(cid: string, name: string): Promise<Buffer>;
  getArtifactMeta(cid: string, name: string): Promise<ArtifactMeta>;
  diffArtifacts(
    parentCid: string,
    childCid: string,
    name: string,
  ): Promise<{ readonly parent: string; readonly child: string }>;
  search(query: string): Promise<readonly Contribution[]>;
}

/** Nexus VFS browsing — available when capabilities.vfs is true. */
export interface TuiVfsProvider {
  listPath(path: string): Promise<readonly FsEntry[]>;
  /** Read a file at the given VFS path. Returns undefined when the path does not exist.
   *  When maxBytes is provided, the provider should return at most that many bytes. */
  readFile(path: string, maxBytes?: number): Promise<Buffer | undefined>;
}

/** Messaging queries — available when capabilities.messaging is true. */
export interface TuiMessagingProvider {
  getInboxMessages(query?: {
    recipient?: string;
    limit?: number;
  }): Promise<readonly InboxMessage[]>;
}

/** Cost tracking — available when capabilities.costTracking is true. */
export interface TuiCostProvider {
  getSessionCosts(): Promise<SessionCostSummary>;
}

/** Ask-user event bus — available when capabilities.askUser is true. */
export interface TuiAskUserProvider {
  getPendingQuestions(): Promise<readonly PendingQuestion[]>;
  answerQuestion(questionCid: string, answer: string): Promise<void>;
}

/** GitHub context — available when capabilities.github is true. */
export interface TuiGitHubProvider {
  getActivePR(): Promise<GitHubPRSummary | undefined>;
}

/** Bounty queries — available when capabilities.bounties is true. */
export interface TuiBountyProvider {
  listBounties(
    query?: import("../core/bounty-store.js").BountyQuery,
  ): Promise<readonly import("../core/bounty.js").Bounty[]>;
}

/** Gossip peer access — available when capabilities.gossip is true. */
export interface TuiGossipProvider {
  getGossipPeers(): Promise<readonly import("../core/gossip/types.js").PeerInfo[]>;
}

/** Handoff queries — available when capabilities.handoffs is true. */
export interface TuiHandoffProvider {
  getHandoffs(query?: HandoffQuery): Promise<readonly Handoff[]>;
  /**
   * Mark a handoff delivered. Optional `sessionId` pins the POST scope
   * so a session switch between the preceding getHandoffs() and this
   * call can't strand the handoff in pending_pickup.
   */
  markHandoffDelivered(handoffId: string, sessionId?: string): Promise<void>;
  cancelHandoff(handoffId: string, reason?: string, sessionId?: string): Promise<void>;
  manualResolveHandoff(handoffId: string, reason?: string, sessionId?: string): Promise<void>;
  resendHandoff(
    handoffId: string,
    options?: {
      readonly reason?: string;
      readonly replyDueAt?: string;
      readonly sessionId?: string;
    },
  ): Promise<void>;
  rerouteHandoff(
    handoffId: string,
    options: {
      readonly toRole: string;
      readonly reason?: string;
      readonly replyDueAt?: string;
      readonly sessionId?: string;
    },
  ): Promise<void>;
}

/** Type guard: does the provider support handoff queries? */
export function isHandoffProvider(p: unknown): p is TuiHandoffProvider {
  const candidate = p as Partial<Record<keyof TuiHandoffProvider, unknown>>;
  return (
    typeof candidate.getHandoffs === "function" &&
    typeof candidate.markHandoffDelivered === "function" &&
    typeof candidate.cancelHandoff === "function" &&
    typeof candidate.manualResolveHandoff === "function" &&
    typeof candidate.resendHandoff === "function" &&
    typeof candidate.rerouteHandoff === "function"
  );
}

/** Goal management — available when capabilities.goals is true. */
export interface TuiGoalProvider {
  getGoal(): Promise<GoalData | undefined>;
  /**
   * Set (upsert) the current goal.
   *
   * C6 (#304): The `token` argument is minted by `confirmAndMutate` (T10)
   * and carries the goal's current resourceVersion as `ifMatch`. The
   * implementation wires it through to the `@Dangerous` PUT /api/session/goal
   * route so a stale RV produces a 409 the caller can retry. Tests mint
   * tokens via `src/tui/safety/testing.ts`.
   */
  setGoal(
    token: DangerousToken<"Goal">,
    goal: string,
    acceptance: readonly string[],
  ): Promise<GoalData>;
}

/** Session management — available when capabilities.sessions is true. */
export interface TuiSessionProvider {
  listSessions(query?: {
    status?: import("../core/session.js").SessionStatus;
    presetName?: string;
  }): Promise<readonly SessionRecord[]>;
  createSession(input: SessionInput): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  /**
   * Archive a session.
   *
   * C6 (#304): The `token` argument is minted by `confirmAndMutate` (T10)
   * and carries the session id + resourceVersion. The implementation
   * extracts `token.id` for the URL path and `token.ifMatch` for the
   * If-Match header. Tests mint tokens via `src/tui/safety/testing.ts`.
   */
  archiveSession(token: DangerousToken<"AgentSession">): Promise<void>;
  addContributionToSession(sessionId: string, cid: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Type guards — use these instead of `as unknown as { method? }` casts
// ---------------------------------------------------------------------------

/** Check if provider supports outcome queries. */
export function isOutcomeProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiOutcomeProvider {
  return provider.capabilities.outcomes;
}

/** Check if provider supports artifact access. */
export function isArtifactProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiArtifactProvider {
  return provider.capabilities.artifacts;
}

/** Check if provider supports full-text search (independent of CAS/artifact capability). */
export function isSearchProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & Pick<TuiArtifactProvider, "search"> {
  return typeof (provider as unknown as Record<string, unknown>).search === "function";
}

/** Check if provider supports Nexus VFS browsing. */
export function isVfsProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiVfsProvider {
  return provider.capabilities.vfs;
}

/** Check if provider supports messaging. */
export function isMessagingProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiMessagingProvider {
  return provider.capabilities.messaging;
}

/** Check if provider supports cost tracking. */
export function isCostProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiCostProvider {
  return provider.capabilities.costTracking;
}

/** Check if provider supports ask-user events. */
export function isAskUserProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiAskUserProvider {
  return provider.capabilities.askUser;
}

/** Check if provider supports GitHub context. */
export function isGitHubProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiGitHubProvider {
  return provider.capabilities.github;
}

/** Check if provider supports bounty queries. */
export function isBountyProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiBountyProvider {
  return provider.capabilities.bounties;
}

/** Check if provider supports gossip peer access. */
export function isGossipProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiGossipProvider {
  return provider.capabilities.gossip;
}

/** Check if provider supports goal management. */
export function isGoalProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiGoalProvider {
  return provider.capabilities.goals;
}

/** Check if provider supports session management. */
export function isSessionProvider(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiSessionProvider {
  return provider.capabilities.sessions;
}
