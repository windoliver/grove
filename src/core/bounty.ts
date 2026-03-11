/**
 * Core domain models for the bounty and payment system.
 *
 * Bounties are mutable coordination objects (like Claims) that track
 * the lifecycle of a reward offer: create → fund → claim → settle/expire.
 *
 * Wire format uses snake_case (JSON Schema). TypeScript uses camelCase.
 */

import type { AgentIdentity, JsonValue } from "./models.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Bounty status — lifecycle states. */
export const BountyStatus = {
  /** Created but not yet funded (draft). */
  Draft: "draft",
  /** Funded and open for claims. */
  Open: "open",
  /** Claimed by an agent (work in progress). */
  Claimed: "claimed",
  /** Work completed, pending settlement. */
  Completed: "completed",
  /** Credits distributed to fulfiller. */
  Settled: "settled",
  /** Deadline passed with no successful completion. Credits refunded. */
  Expired: "expired",
  /** Cancelled by creator before completion. Credits refunded. */
  Cancelled: "cancelled",
} as const;
export type BountyStatus = (typeof BountyStatus)[keyof typeof BountyStatus];

/** Terminal bounty states — no further transitions allowed. */
export const TERMINAL_BOUNTY_STATUSES: readonly BountyStatus[] = [
  BountyStatus.Settled,
  BountyStatus.Expired,
  BountyStatus.Cancelled,
] as const;

/** Reward signal types — automatic credit distribution triggers. */
export const RewardType = {
  /** Credits proportional to metric improvement on the frontier. */
  FrontierAdvance: "frontier_advance",
  /** Credits when another agent cites/adopts your contribution. */
  AdoptionBonus: "adoption_bonus",
  /** Credits for confirming/reproducing results. */
  ReproductionReward: "reproduction_reward",
  /** Credits for useful reviews. */
  ReviewReward: "review_reward",
  /** Credits from bounty completion. */
  BountyPayout: "bounty_payout",
} as const;
export type RewardType = (typeof RewardType)[keyof typeof RewardType];

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Criteria that a contribution must meet to fulfill a bounty. */
export interface BountyCriteria {
  /** Human/agent-readable description of what's needed. */
  readonly description: string;
  /** Optional metric name that must improve (e.g., "val_bpb"). */
  readonly metricName?: string | undefined;
  /** Optional threshold the metric must reach (e.g., 0.96). */
  readonly metricThreshold?: number | undefined;
  /** Optional metric direction: contribution must go below (minimize) or above (maximize). */
  readonly metricDirection?: "minimize" | "maximize" | undefined;
  /** Optional tags the contribution must include. */
  readonly requiredTags?: readonly string[] | undefined;
}

/**
 * A bounty — a reward offer for completing specific work.
 *
 * Bounties are mutable coordination objects with a lifecycle
 * (draft → open → claimed → completed → settled).
 * Like Claims, bounty objects returned by the store are readonly
 * snapshots; state transitions produce new snapshots.
 */
export interface Bounty {
  readonly bountyId: string;
  /** Human/agent-readable title. */
  readonly title: string;
  /** Detailed description of the bounty. */
  readonly description: string;
  readonly status: BountyStatus;
  /** Agent that created the bounty. */
  readonly creator: AgentIdentity;
  /** Credit amount offered. */
  readonly amount: number;
  /** What the contribution must achieve. */
  readonly criteria: BountyCriteria;
  /** Zone this bounty is scoped to (for Nexus multi-tenant). */
  readonly zoneId?: string | undefined;
  /** ISO 8601 deadline. After this, the bounty expires and credits are refunded. */
  readonly deadline: string;
  /** Agent that claimed the bounty (set when status transitions to 'claimed'). */
  readonly claimedBy?: AgentIdentity | undefined;
  /** CID of the claim associated with this bounty (reuses existing claim system). */
  readonly claimId?: string | undefined;
  /** CID of the contribution that fulfilled this bounty. */
  readonly fulfilledByCid?: string | undefined;
  /** Reservation ID from the CreditsService (for two-phase payment). */
  readonly reservationId?: string | undefined;
  /** Arbitrary metadata. */
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Input for creating a bounty (everything except computed fields). */
export type BountyInput = Omit<Bounty, "status" | "updatedAt" | "claimedBy" | "claimId" | "fulfilledByCid" | "reservationId">;

/**
 * A recorded reward distribution.
 *
 * Immutable record of credits distributed via a reward signal.
 * The rewardId is deterministic: derived from (bountyId/sourceCid, contributionCid, rewardType)
 * to guarantee exactly-once distribution.
 */
export interface RewardRecord {
  /** Deterministic ID for idempotency. */
  readonly rewardId: string;
  readonly rewardType: RewardType;
  /** Agent receiving the reward. */
  readonly recipient: AgentIdentity;
  /** Credit amount distributed. */
  readonly amount: number;
  /** CID of the contribution that triggered this reward. */
  readonly contributionCid: string;
  /** Bounty ID if this reward is from a bounty payout. */
  readonly bountyId?: string | undefined;
  /** Transfer ID from the CreditsService. */
  readonly transferId?: string | undefined;
  readonly createdAt: string;
}
