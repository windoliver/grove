/**
 * Store protocols for the contribution graph.
 *
 * These define the abstract interface that storage backends must implement.
 * The local SQLite adapter and the Nexus adapter both satisfy these protocols.
 */

import type {
  Claim,
  ClaimStatus,
  Contribution,
  ContributionKind,
  ContributionMode,
  Relation,
  RelationType,
} from "./models.js";

/** Filters for querying contributions. */
export interface ContributionQuery {
  readonly kind?: ContributionKind | undefined;
  readonly mode?: ContributionMode | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly agentId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Store for immutable contributions and their typed relations. */
export interface ContributionStore {
  /** Store a contribution (idempotent — same CID is a no-op). */
  put(contribution: Contribution): Promise<void>;

  /** Store multiple contributions in a single transaction. Idempotent per CID. */
  putMany(contributions: readonly Contribution[]): Promise<void>;

  /** Retrieve a contribution by CID. */
  get(cid: string): Promise<Contribution | undefined>;

  /** List contributions matching filters. */
  list(query?: ContributionQuery): Promise<readonly Contribution[]>;

  /** Get contributions that have a relation pointing to this CID (incoming edges). */
  children(cid: string): Promise<readonly Contribution[]>;

  /** Get contributions that this CID has relations to (outgoing edge targets). */
  ancestors(cid: string): Promise<readonly Contribution[]>;

  /** Get relations originating from this CID. */
  relationsOf(cid: string, relationType?: RelationType): Promise<readonly Relation[]>;

  /** Get contributions that have relations pointing to this CID. */
  relatedTo(cid: string, relationType?: RelationType): Promise<readonly Contribution[]>;

  /**
   * Full-text search on summary and description.
   *
   * Implementations should use an efficient text search mechanism (e.g.,
   * SQLite FTS5) rather than naive substring matching. The query string
   * is matched against summary and description fields.
   */
  search(query: string, filters?: ContributionQuery): Promise<readonly Contribution[]>;

  /**
   * Find existing contributions by agent, target, and kind.
   *
   * Used for semantic dedup: "has this agent already reviewed/adopted this target?"
   * Returns contributions where:
   * - agent.agentId matches the given agentId
   * - kind matches the given kind
   * - at least one relation targets the given targetCid
   *
   * Results are ordered by created_at descending (most recent first).
   */
  findExisting(
    agentId: string,
    targetCid: string,
    kind: ContributionKind,
  ): Promise<readonly Contribution[]>;

  /** Count contributions matching filters. */
  count(query?: ContributionQuery): Promise<number>;

  /** Release resources (e.g., close database connections). */
  close(): void;
}

/** Reason a claim was expired during reconciliation. */
export const ExpiryReason = {
  /** Lease expired: lease_expires_at < now. */
  LeaseExpired: "lease_expired",
  /** Agent stalled: heartbeat_at older than stall threshold. */
  Stalled: "stalled",
} as const;
export type ExpiryReason = (typeof ExpiryReason)[keyof typeof ExpiryReason];

/** A claim that was expired, with the reason for expiry. */
export interface ExpiredClaim {
  readonly claim: Claim;
  readonly reason: ExpiryReason;
}

/** Options for expireStale(). */
export interface ExpireStaleOptions {
  /**
   * Stall threshold in milliseconds. Claims whose heartbeat_at is older
   * than `now - stallThresholdMs` are expired even if their lease hasn't
   * technically ended. Detects dead agents that set long leases.
   *
   * If omitted, only lease-based expiry is performed (no stall detection).
   */
  readonly stallThresholdMs?: number | undefined;
}

/** Store for mutable claims (coordination objects). */
export interface ClaimStore {
  /** Create a new claim. Throws if claimId already exists. */
  createClaim(claim: Claim): Promise<Claim>;

  /**
   * Create or renew a claim for the same agent on the same target.
   *
   * If the same agent (by agentId) already has an active claim on the
   * target, updates the lease and intent summary. If a different agent
   * has an active claim, throws. If no active claim exists, creates new.
   *
   * @returns The created or renewed claim snapshot.
   */
  claimOrRenew(claim: Claim): Promise<Claim>;

  /** Get a claim by ID. */
  getClaim(claimId: string): Promise<Claim | undefined>;

  /**
   * Update heartbeat timestamp and renew lease.
   *
   * @param claimId - The claim to heartbeat.
   * @param leaseDurationMs - Optional lease duration in milliseconds.
   *   If omitted, the implementation uses a default (e.g., 300 seconds / 5 minutes).
   * @returns The updated claim snapshot. Throws if claim is not active.
   */
  heartbeat(claimId: string, leaseDurationMs?: number): Promise<Claim>;

  /** Release a claim (agent gives up). Returns the updated claim snapshot. */
  release(claimId: string): Promise<Claim>;

  /** Mark a claim as completed. Returns the updated claim snapshot. */
  complete(claimId: string): Promise<Claim>;

  /**
   * Expire stale claims. Returns expired claims with reasons.
   *
   * Expires claims where:
   * 1. lease_expires_at < now (lease expired)
   * 2. heartbeat_at < now - stallThresholdMs (agent stalled, if threshold provided)
   *
   * Both conditions are checked atomically.
   */
  expireStale(options?: ExpireStaleOptions): Promise<readonly ExpiredClaim[]>;

  /** List active claims, optionally filtered by target. */
  activeClaims(targetRef?: string): Promise<readonly Claim[]>;

  /**
   * Delete terminal claims older than the retention period.
   *
   * Removes claims with status in (completed, expired, released) where
   * created_at < now - retentionMs.
   *
   * @returns Number of claims deleted.
   */
  cleanCompleted(retentionMs: number): Promise<number>;

  /** Release resources (e.g., close database connections). */
  close(): void;
}
