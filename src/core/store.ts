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

/** Filter for counting active claims. */
export interface ActiveClaimFilter {
  readonly agentId?: string | undefined;
  readonly targetRef?: string | undefined;
}

/** A node in a discussion thread, with its position metadata. */
export interface ThreadNode {
  readonly contribution: Contribution;
  /** Depth from the thread root (root = 0, direct replies = 1, etc.). */
  readonly depth: number;
}

/** A thread root with activity metadata, returned by hotThreads(). */
export interface ThreadSummary {
  readonly contribution: Contribution;
  /** Number of direct responds_to replies. */
  readonly replyCount: number;
  /** ISO timestamp of the most recent reply. */
  readonly lastReplyAt: string;
}

/** Options for hotThreads(). Default limit is 20 when omitted. */
export interface HotThreadsOptions {
  readonly tags?: readonly string[] | undefined;
  /** Maximum number of threads to return. Defaults to 20 when omitted. */
  readonly limit?: number | undefined;
}

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
  /**
   * Optional persistent-state identity string.
   *
   * Stores backed by the same persistent state (e.g., the same SQLite
   * database file) should return the same string so that enforcement
   * wrappers can share a single write-serialization mutex across
   * independently-constructed store objects.
   *
   * Stores that do not set this property fall back to per-object
   * identity (WeakMap), which is safe only when a single wrapper
   * exists per backing store.
   */
  readonly storeIdentity?: string | undefined;
  /** Store a contribution (idempotent — same CID is a no-op). */
  put(contribution: Contribution): Promise<void>;

  /** Store multiple contributions in a single transaction. Idempotent per CID. */
  putMany(contributions: readonly Contribution[]): Promise<void>;

  /** Retrieve a contribution by CID. */
  get(cid: string): Promise<Contribution | undefined>;

  /** Retrieve multiple contributions by CID. Returns a map of CID → Contribution for found CIDs. */
  getMany(cids: readonly string[]): Promise<ReadonlyMap<string, Contribution>>;

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
   * - if relationType is provided, only relations of that type are considered
   *
   * Results are ordered by created_at descending (most recent first).
   */
  findExisting(
    agentId: string,
    targetCid: string,
    kind: ContributionKind,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]>;

  /** Count contributions matching filters. */
  count(query?: ContributionQuery): Promise<number>;

  /**
   * Count contributions created at or after the given timestamp.
   *
   * Optionally scoped to a single agent. Uses indexed queries where
   * available (e.g., the `(agent_id, created_at)` composite index in
   * SQLite) instead of materializing full contribution objects.
   *
   * @param query.agentId - If provided, only count contributions by this agent.
   * @param query.since - ISO 8601 timestamp; counts contributions with `created_at >= since`.
   */
  countSince(query: { agentId?: string; since: string }): Promise<number>;

  /**
   * Walk a discussion thread rooted at a contribution.
   *
   * Returns the root at depth 0 followed by all descendants reachable
   * via `responds_to` relations, ordered chronologically within each depth.
   * Parents always appear before their children.
   *
   * Returns an empty array if the root CID does not exist.
   *
   * @param rootCid - CID of the thread root contribution.
   * @param opts.maxDepth - Maximum depth to traverse (default: 50).
   * @param opts.limit - Maximum number of nodes to return.
   */
  thread(
    rootCid: string,
    opts?: { readonly maxDepth?: number; readonly limit?: number },
  ): Promise<readonly ThreadNode[]>;

  /**
   * Count direct replies (incoming `responds_to` relations) for multiple CIDs.
   *
   * Returns a map from CID to direct reply count. CIDs with no replies
   * have a count of 0. Non-existent CIDs also return 0 (not omitted).
   */
  replyCounts(cids: readonly string[]): Promise<ReadonlyMap<string, number>>;

  /**
   * List contributions that have discussion replies, ranked by activity.
   *
   * Returns contributions with at least one incoming `responds_to` relation,
   * sorted by reply count DESC then most recent reply timestamp DESC.
   * Any contribution kind can be a thread root (not just discussions).
   *
   * Optionally filtered by tags on the root contribution.
   */
  hotThreads(opts?: HotThreadsOptions): Promise<readonly ThreadSummary[]>;

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

/** Filters for querying claims. */
export interface ClaimQuery {
  readonly status?: ClaimStatus | readonly ClaimStatus[] | undefined;
  readonly agentId?: string | undefined;
  readonly targetRef?: string | undefined;
}

/** Store for mutable claims (coordination objects). */
export interface ClaimStore {
  /** Optional persistent-state identity string. See ContributionStore.storeIdentity. */
  readonly storeIdentity?: string | undefined;

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
   * List claims matching the given filters.
   *
   * Unlike activeClaims(), this can return claims in any status.
   * If no query is provided, returns all claims ordered by created_at desc.
   */
  listClaims(query?: ClaimQuery): Promise<readonly Claim[]>;

  /**
   * Delete terminal claims older than the retention period.
   *
   * Removes claims with status in (completed, expired, released) where
   * heartbeat_at < now - retentionMs. Uses heartbeat_at (last activity)
   * rather than created_at so that long-running claims that completed
   * recently are not prematurely deleted.
   *
   * @returns Number of claims deleted.
   */
  cleanCompleted(retentionMs: number): Promise<number>;

  /**
   * Count active claims matching the given filter.
   *
   * More efficient than `activeClaims().length` — implementations should
   * use COUNT queries rather than materializing full Claim objects.
   */
  countActiveClaims(filter?: ActiveClaimFilter): Promise<number>;

  /**
   * Detect stalled claims: active claims with a valid lease but a stale heartbeat.
   *
   * A claim is stalled when:
   * - status is 'active'
   * - lease has not expired (lease_expires_at >= now)
   * - heartbeat is older than stallTimeoutMs
   *
   * This is advisory — callers decide what to do with stalled claims.
   */
  detectStalled(stallTimeoutMs: number): Promise<readonly Claim[]>;

  /** Release resources (e.g., close database connections). */
  close(): void;
}
