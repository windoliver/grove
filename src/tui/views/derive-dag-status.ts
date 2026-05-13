/**
 * Pure status derivation for a DAG node (issue #311 C5).
 *
 * Resolution order (first match wins):
 *   1. Outcome present → done (accepted) / failed (rejected | crashed | invalidated)
 *   2. Active claim with future lease → running
 *   3. Active claim with expired lease → blocked
 *   4. work-kind with no outcome, no active claim, no review child → awaiting-review
 *   5. fallback → idle
 *
 * Released / expired / completed claims do NOT contribute (the claim
 * status is itself observable; we only treat "active" claims as live work).
 */

import { type Claim, ClaimStatus, type Contribution, ContributionKind } from "../../core/models.js";
import { type OutcomeRecord, OutcomeStatus } from "../../core/outcome.js";

export type DagNodeStatus = "running" | "done" | "failed" | "blocked" | "awaiting-review" | "idle";

export interface DeriveStatusInput {
  readonly contribution: Contribution;
  readonly outcome: OutcomeRecord | undefined;
  readonly claim: Claim | undefined;
  readonly hasReviewChild: boolean;
  readonly now: number;
}

export function deriveDagStatus(input: DeriveStatusInput): DagNodeStatus {
  const { contribution, outcome, claim, hasReviewChild, now } = input;

  if (outcome) {
    if (outcome.status === OutcomeStatus.Accepted) return "done";
    return "failed";
  }

  if (claim && claim.status === ClaimStatus.Active) {
    const expiresMs = Date.parse(claim.leaseExpiresAt);
    if (!Number.isNaN(expiresMs) && expiresMs > now) return "running";
    return "blocked";
  }

  if (contribution.kind === ContributionKind.Work && !hasReviewChild) {
    return "awaiting-review";
  }

  return "idle";
}
