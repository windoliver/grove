/**
 * TUI data provider interface.
 *
 * View-oriented: one method per TUI view. Implementations handle
 * the details of fetching from local SQLite or remote HTTP.
 */

import type { Frontier, FrontierQuery } from "../core/frontier.js";
import type { Claim, Contribution, ContributionKind } from "../core/models.js";
import type { ContributionQuery, ThreadNode, ThreadSummary } from "../core/store.js";

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

/** Abstract data provider for the TUI. */
export interface TuiDataProvider {
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

  /** Release resources. */
  close(): void;
}
