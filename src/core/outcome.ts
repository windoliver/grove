/**
 * Outcome types and store interface.
 *
 * Outcomes are local/operator annotations — separate mutable records
 * that are NOT part of the Contribution manifest. They do not affect
 * CIDs, are not gossiped, and are server-local mutable state shared
 * by clients connected to the same Grove instance.
 *
 * Different Grove instances may maintain different outcome assessments
 * for the same CID.
 */

/** Outcome status values. */
export const OutcomeStatus = {
  Accepted: "accepted",
  Rejected: "rejected",
  Crashed: "crashed",
  Invalidated: "invalidated",
} as const;
export type OutcomeStatus = (typeof OutcomeStatus)[keyof typeof OutcomeStatus];

/** All valid outcome status values as a set for validation. */
export const OUTCOME_STATUSES: ReadonlySet<string> = new Set<string>(Object.values(OutcomeStatus));

/**
 * An outcome record — a local operator annotation for a contribution.
 *
 * Immutable snapshot: store methods return new objects, never mutate.
 */
export interface OutcomeRecord {
  readonly cid: string;
  readonly status: OutcomeStatus;
  readonly reason?: string | undefined;
  readonly baselineCid?: string | undefined;
  readonly evaluatedAt: string;
  readonly evaluatedBy: string;
}

/** Input for creating/updating an outcome (cid is separate). */
export interface OutcomeInput {
  readonly status: OutcomeStatus;
  readonly reason?: string | undefined;
  readonly baselineCid?: string | undefined;
  readonly evaluatedBy: string;
}

/** Aggregated outcome statistics. */
export interface OutcomeStats {
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly crashed: number;
  readonly invalidated: number;
  readonly acceptanceRate: number;
}

/** Query filter for listing outcomes. */
export interface OutcomeQuery {
  readonly status?: OutcomeStatus | undefined;
  readonly evaluatedBy?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Store interface for outcome records.
 *
 * Implementations: SqliteOutcomeStore, NexusOutcomeStore.
 */
export interface OutcomeStore {
  /** Set (create or overwrite) the outcome for a contribution CID. */
  set(cid: string, input: OutcomeInput): Promise<OutcomeRecord>;

  /** Get the outcome for a CID, or undefined if none exists. */
  get(cid: string): Promise<OutcomeRecord | undefined>;

  /** Get outcomes for multiple CIDs in a single batch query. */
  getBatch(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>>;

  /** List outcomes with optional filters. */
  list(query?: OutcomeQuery): Promise<readonly OutcomeRecord[]>;

  /** Get aggregated outcome statistics. */
  getStats(): Promise<OutcomeStats>;

  /** Release resources. */
  close(): void;
}
