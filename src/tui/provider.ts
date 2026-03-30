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

import type { Frontier, FrontierQuery } from "../core/frontier.js";
import type {
  AgentIdentity,
  Claim,
  Contribution,
  ContributionKind,
  JsonValue,
} from "../core/models.js";
import type { OutcomeRecord, OutcomeStatus } from "../core/outcome.js";
import type { ContributionQuery, ThreadNode, ThreadSummary } from "../core/store.js";

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
}

/** Session record for grouping work. */
export interface SessionRecord {
  readonly sessionId: string;
  readonly goal?: string | undefined;
  readonly presetName?: string | undefined;
  readonly status: "active" | "archived";
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly contributionCount: number;
}

/** Input for creating a session. */
export interface SessionInput {
  readonly goal?: string | undefined;
  readonly presetName?: string | undefined;
}

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

  /** Create a claim for an agent (optional — available in local/remote modes). */
  createClaim?(input: ClaimInput): Promise<Claim>;

  /** Check out a workspace for an agent (optional). Returns the workspace path. */
  checkoutWorkspace?(targetRef: string, agent: AgentIdentity): Promise<string>;

  /** Renew a claim's lease by heartbeating (optional). */
  heartbeatClaim?(claimId: string, leaseDurationMs?: number): Promise<Claim>;

  /** Release a claim by transitioning it to "released" status (optional). */
  releaseClaim?(claimId: string): Promise<void>;

  /** Clean up a workspace directory by targetRef and agentId (optional). */
  cleanWorkspace?(targetRef: string, agentId: string): Promise<void>;

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

/** Goal management — available when capabilities.goals is true. */
export interface TuiGoalProvider {
  getGoal(): Promise<GoalData | undefined>;
  setGoal(goal: string, acceptance: readonly string[]): Promise<GoalData>;
}

/** Session management — available when capabilities.sessions is true. */
export interface TuiSessionProvider {
  listSessions(query?: {
    status?: "active" | "archived";
    presetName?: string;
  }): Promise<readonly SessionRecord[]>;
  createSession(input: SessionInput): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  archiveSession(sessionId: string): Promise<void>;
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
