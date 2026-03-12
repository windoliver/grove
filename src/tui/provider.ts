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
