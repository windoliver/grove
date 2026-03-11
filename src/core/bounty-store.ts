/**
 * Store protocol for bounties.
 *
 * Defines the abstract interface that storage backends must implement.
 * The local SQLite adapter and the Nexus adapter both satisfy this protocol.
 *
 * Bounties are mutable coordination objects (like Claims). State transitions
 * produce new readonly snapshots.
 */

import type { Bounty, BountyStatus, RewardRecord, RewardType } from "./bounty.js";

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

/** Filters for querying bounties. */
export interface BountyQuery {
  readonly status?: BountyStatus | readonly BountyStatus[] | undefined;
  readonly creatorAgentId?: string | undefined;
  readonly claimedByAgentId?: string | undefined;
  readonly zoneId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Filters for querying reward records. */
export interface RewardQuery {
  readonly rewardType?: RewardType | undefined;
  readonly recipientAgentId?: string | undefined;
  readonly bountyId?: string | undefined;
  readonly contributionCid?: string | undefined;
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Store protocol
// ---------------------------------------------------------------------------

/** Store for mutable bounties and immutable reward records. */
export interface BountyStore {
  /** Optional persistent-state identity string. See ContributionStore.storeIdentity. */
  readonly storeIdentity?: string | undefined;

  // -----------------------------------------------------------------------
  // Bounty CRUD
  // -----------------------------------------------------------------------

  /**
   * Create a new bounty. Throws if bountyId already exists.
   *
   * The bounty is created in the provided status (typically 'draft' or 'open').
   * @returns The created bounty snapshot.
   */
  createBounty(bounty: Bounty): Promise<Bounty>;

  /**
   * Get a bounty by ID.
   * @returns The bounty snapshot, or undefined if not found.
   */
  getBounty(bountyId: string): Promise<Bounty | undefined>;

  /**
   * List bounties matching filters.
   * Results are ordered by created_at descending (most recent first).
   */
  listBounties(query?: BountyQuery): Promise<readonly Bounty[]>;

  /**
   * Count bounties matching filters.
   */
  countBounties(query?: BountyQuery): Promise<number>;

  // -----------------------------------------------------------------------
  // Bounty state transitions
  // -----------------------------------------------------------------------

  /**
   * Fund a draft bounty, transitioning it to 'open'.
   *
   * @param bountyId - The bounty to fund.
   * @param reservationId - The CreditsService reservation ID.
   * @returns The updated bounty snapshot.
   * @throws BountyStateError if bounty is not in 'draft' status.
   */
  fundBounty(bountyId: string, reservationId: string): Promise<Bounty>;

  /**
   * Mark a bounty as claimed by an agent.
   *
   * @param bountyId - The bounty to claim.
   * @param claimedBy - The agent claiming the bounty.
   * @param claimId - The associated claim ID (from ClaimStore).
   * @returns The updated bounty snapshot.
   * @throws BountyStateError if bounty is not in 'open' status.
   */
  claimBounty(bountyId: string, claimedBy: import("./models.js").AgentIdentity, claimId: string): Promise<Bounty>;

  /**
   * Mark a bounty as completed (work done, pending settlement).
   *
   * @param bountyId - The bounty to complete.
   * @param fulfilledByCid - CID of the contribution that fulfilled the bounty.
   * @returns The updated bounty snapshot.
   * @throws BountyStateError if bounty is not in 'claimed' status.
   */
  completeBounty(bountyId: string, fulfilledByCid: string): Promise<Bounty>;

  /**
   * Settle a bounty (credits distributed to fulfiller).
   *
   * @param bountyId - The bounty to settle.
   * @returns The updated bounty snapshot.
   * @throws BountyStateError if bounty is not in 'completed' status.
   */
  settleBounty(bountyId: string): Promise<Bounty>;

  /**
   * Expire a bounty (deadline passed, refund credits).
   *
   * @param bountyId - The bounty to expire.
   * @returns The updated bounty snapshot.
   * @throws BountyStateError if bounty is in a terminal status.
   */
  expireBounty(bountyId: string): Promise<Bounty>;

  /**
   * Cancel a bounty (creator withdraws it).
   *
   * @param bountyId - The bounty to cancel.
   * @returns The updated bounty snapshot.
   * @throws BountyStateError if bounty is in a terminal status.
   */
  cancelBounty(bountyId: string): Promise<Bounty>;

  // -----------------------------------------------------------------------
  // Expiry sweep
  // -----------------------------------------------------------------------

  /**
   * Find bounties past their deadline that are still open or claimed.
   *
   * Used by the reconciler to expire stale bounties and void reservations.
   * Does NOT mutate state — callers decide what to do with the results.
   */
  findExpiredBounties(): Promise<readonly Bounty[]>;

  // -----------------------------------------------------------------------
  // Reward records
  // -----------------------------------------------------------------------

  /**
   * Record a reward distribution. Idempotent — same rewardId is a no-op.
   */
  recordReward(reward: RewardRecord): Promise<void>;

  /**
   * Check if a reward has already been distributed.
   * Used for idempotency checks before distributing credits.
   */
  hasReward(rewardId: string): Promise<boolean>;

  /**
   * List reward records matching filters.
   */
  listRewards(query?: RewardQuery): Promise<readonly RewardRecord[]>;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Release resources (e.g., close database connections). */
  close(): void;
}
