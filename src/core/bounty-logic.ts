/**
 * Pure validation and state transition logic for bounties.
 *
 * No I/O — these functions validate inputs and compute derived state.
 * Shared across local and Nexus implementations.
 */

import type { Bounty, BountyCriteria, BountyStatus } from "./bounty.js";
import { TERMINAL_BOUNTY_STATUSES } from "./bounty.js";
import { BountyStateError } from "./bounty-errors.js";
import type { Contribution, Score } from "./models.js";
import type { RewardType } from "./bounty.js";

// ---------------------------------------------------------------------------
// State transition validation
// ---------------------------------------------------------------------------

/** Valid transitions: from → allowed targets. */
const VALID_TRANSITIONS: Readonly<Record<BountyStatus, readonly BountyStatus[]>> = {
  draft: ["open", "cancelled"],
  open: ["claimed", "expired", "cancelled"],
  claimed: ["completed", "open", "expired", "cancelled"],
  completed: ["settled", "expired", "cancelled"],
  settled: [],
  expired: [],
  cancelled: [],
};

/**
 * Validate that a bounty state transition is allowed.
 *
 * @throws BountyStateError if the transition is invalid.
 */
export function validateBountyTransition(
  bountyId: string,
  currentStatus: BountyStatus,
  targetStatus: BountyStatus,
  action: string,
): void {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed.includes(targetStatus)) {
    throw new BountyStateError({
      bountyId,
      currentStatus,
      attemptedAction: action,
    });
  }
}

/**
 * Check if a bounty is in a terminal state (no further transitions allowed).
 */
export function isBountyTerminal(status: BountyStatus): boolean {
  return (TERMINAL_BOUNTY_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Bounty input validation
// ---------------------------------------------------------------------------

/**
 * Validate bounty input fields.
 *
 * @throws Error with descriptive message on validation failure.
 */
export function validateBountyInput(bounty: Bounty): void {
  if (!bounty.bountyId || bounty.bountyId.trim().length === 0) {
    throw new Error("Bounty ID is required");
  }
  if (!bounty.title || bounty.title.trim().length === 0) {
    throw new Error("Bounty title is required");
  }
  if (bounty.amount <= 0) {
    throw new Error(`Bounty amount must be positive, got ${bounty.amount}`);
  }
  if (!Number.isInteger(bounty.amount)) {
    throw new Error(`Bounty amount must be an integer (smallest unit), got ${bounty.amount}`);
  }
  if (!bounty.deadline) {
    throw new Error("Bounty deadline is required");
  }
  const deadlineMs = new Date(bounty.deadline).getTime();
  if (Number.isNaN(deadlineMs)) {
    throw new Error(`Invalid deadline format: ${bounty.deadline}`);
  }
  if (!bounty.creator.agentId) {
    throw new Error("Creator agent ID is required");
  }
}

// ---------------------------------------------------------------------------
// Criteria evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a contribution meets a bounty's criteria.
 *
 * Returns true if all specified criteria are satisfied.
 * Criteria that are not specified are treated as satisfied.
 */
export function evaluateBountyCriteria(
  criteria: BountyCriteria,
  contribution: Contribution,
): boolean {
  // Check required tags
  if (criteria.requiredTags !== undefined && criteria.requiredTags.length > 0) {
    const contributionTags = new Set(contribution.tags);
    for (const tag of criteria.requiredTags) {
      if (!contributionTags.has(tag)) {
        return false;
      }
    }
  }

  // Check metric threshold
  if (criteria.metricName !== undefined && criteria.metricThreshold !== undefined) {
    const scores = contribution.scores;
    if (scores === undefined) {
      return false;
    }
    const score: Score | undefined = scores[criteria.metricName];
    if (score === undefined) {
      return false;
    }

    const direction = criteria.metricDirection ?? "minimize";
    if (direction === "minimize") {
      if (score.value > criteria.metricThreshold) {
        return false;
      }
    } else {
      if (score.value < criteria.metricThreshold) {
        return false;
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Deterministic reward ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic reward ID for idempotency.
 *
 * The ID is derived from the source context and contribution CID,
 * ensuring that replaying the same event produces the same reward ID.
 * The CreditsService will reject duplicate transfers with the same ID.
 *
 * Format: `reward:{rewardType}:{sourceId}:{contributionCid}`
 *
 * @param rewardType - Type of reward signal.
 * @param sourceId - Source identifier (bountyId for bounty payouts, or a synthetic ID).
 * @param contributionCid - CID of the contribution that triggered the reward.
 */
export function computeRewardId(
  rewardType: RewardType,
  sourceId: string,
  contributionCid: string,
): string {
  return `reward:${rewardType}:${sourceId}:${contributionCid}`;
}

// ---------------------------------------------------------------------------
// Deadline checks
// ---------------------------------------------------------------------------

/**
 * Check if a bounty has passed its deadline.
 *
 * @param bounty - The bounty to check.
 * @param now - Current time (injectable for testing).
 */
export function isBountyExpired(bounty: Bounty, now: Date = new Date()): boolean {
  const deadlineMs = new Date(bounty.deadline).getTime();
  return now.getTime() > deadlineMs;
}
