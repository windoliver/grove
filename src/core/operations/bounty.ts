/**
 * Bounty operations.
 *
 * createBountyOperation  — Create a bounty with optional credit reservation
 * listBountiesOperation  — List bounties with filters
 * claimBountyOperation   — Claim an open bounty
 * settleBountyOperation  — Settle a completed bounty
 */

import type { Bounty, BountyCriteria, BountyStatus } from "../bounty.js";
import { BountyStatus as BS } from "../bounty.js";
import { evaluateBountyCriteria } from "../bounty-logic.js";
import type { JsonValue } from "../models.js";
import type { AgentOverrides } from "./agent.js";
import { resolveAgent } from "./agent.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { fromGroveError, notFound, ok, validationErr } from "./result.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of create bounty. */
export interface CreateBountyResult {
  readonly bountyId: string;
  readonly title: string;
  readonly amount: number;
  readonly status: BountyStatus;
  readonly deadline: string;
  readonly reservationId?: string | undefined;
}

/** Summary for list responses. */
export interface BountySummary {
  readonly bountyId: string;
  readonly title: string;
  readonly amount: number;
  readonly status: BountyStatus;
  readonly deadline: string;
  readonly claimedBy?: string | undefined;
}

/** Result of list bounties. */
export interface ListBountiesResult {
  readonly bounties: readonly BountySummary[];
  readonly count: number;
}

/** Result of claim bounty. */
export interface ClaimBountyResult {
  readonly bountyId: string;
  readonly title: string;
  readonly status: BountyStatus;
  readonly claimId: string;
  readonly claimedBy?: string | undefined;
}

/** Result of settle bounty. */
export interface SettleBountyResult {
  readonly bountyId: string;
  readonly status: BountyStatus;
  readonly fulfilledByCid?: string | undefined;
  readonly amount: number;
  readonly paidTo?: string | undefined;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Input for create bounty. */
export interface CreateBountyInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly amount: number;
  readonly criteria: BountyCriteria;
  readonly deadlineMs?: number | undefined;
  readonly agent?: AgentOverrides | undefined;
  readonly zoneId?: string | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

/** Input for list bounties. */
export interface ListBountiesInput {
  readonly status?: BountyStatus | undefined;
  readonly creatorAgentId?: string | undefined;
  readonly limit?: number | undefined;
}

/** Input for claim bounty. */
export interface ClaimBountyInput {
  readonly bountyId: string;
  readonly agent?: AgentOverrides | undefined;
  readonly leaseDurationMs?: number | undefined;
}

/** Input for settle bounty. */
export interface SettleBountyInput {
  readonly bountyId: string;
  readonly contributionCid: string;
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

const MISSING_BOUNTY_STORE = "Bounty operations not available (missing bountyStore)";
const MISSING_CLAIM_STORE = "Claim operations not available (missing claimStore)";
const MISSING_CONTRIBUTION_STORE = "Settle bounty not available (missing contributionStore)";

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const DEFAULT_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Create a new bounty with optional credit reservation. */
export async function createBountyOperation(
  input: CreateBountyInput,
  deps: OperationDeps,
): Promise<OperationResult<CreateBountyResult>> {
  try {
    if (deps.bountyStore === undefined) {
      return validationErr(MISSING_BOUNTY_STORE);
    }

    if (!input.title || input.title.trim().length === 0) {
      return validationErr("Bounty title must be a non-empty string");
    }
    if (input.amount <= 0) {
      return validationErr("Bounty amount must be positive");
    }

    const agent = resolveAgent(input.agent);
    const now = new Date();
    const bountyId = crypto.randomUUID();
    const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const deadline = new Date(now.getTime() + deadlineMs).toISOString();

    // Reserve credits when available
    let reservationId: string | undefined;
    if (deps.creditsService) {
      reservationId = crypto.randomUUID();
      await deps.creditsService.reserve({
        reservationId,
        agentId: agent.agentId,
        amount: input.amount,
        timeoutMs: deadlineMs + 24 * 60 * 60 * 1000,
      });
    }

    const bounty: Bounty = {
      bountyId,
      title: input.title,
      description: input.description ?? input.title,
      status: BS.Open,
      creator: agent,
      amount: input.amount,
      criteria: input.criteria,
      zoneId: input.zoneId,
      deadline,
      reservationId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(input.context !== undefined ? { context: input.context } : {}),
    };

    const result = await deps.bountyStore.createBounty(bounty);

    return ok({
      bountyId: result.bountyId,
      title: result.title,
      amount: result.amount,
      status: result.status,
      deadline: result.deadline,
      reservationId: result.reservationId,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** List bounties with optional filters. */
export async function listBountiesOperation(
  input: ListBountiesInput,
  deps: OperationDeps,
): Promise<OperationResult<ListBountiesResult>> {
  try {
    if (deps.bountyStore === undefined) {
      return validationErr(MISSING_BOUNTY_STORE);
    }

    const bounties = await deps.bountyStore.listBounties({
      status: input.status,
      creatorAgentId: input.creatorAgentId,
      limit: input.limit,
    });

    const summaries: BountySummary[] = bounties.map((b) => ({
      bountyId: b.bountyId,
      title: b.title,
      amount: b.amount,
      status: b.status,
      deadline: b.deadline,
      claimedBy: b.claimedBy?.agentId,
    }));

    return ok({ bounties: summaries, count: summaries.length });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Claim an open bounty. */
export async function claimBountyOperation(
  input: ClaimBountyInput,
  deps: OperationDeps,
): Promise<OperationResult<ClaimBountyResult>> {
  try {
    if (deps.bountyStore === undefined) {
      return validationErr(MISSING_BOUNTY_STORE);
    }

    if (deps.claimStore === undefined) {
      return validationErr(MISSING_CLAIM_STORE);
    }

    const bounty = await deps.bountyStore.getBounty(input.bountyId);
    if (!bounty) {
      return notFound("Bounty", input.bountyId);
    }

    const agent = resolveAgent(input.agent);
    const now = new Date();
    const leaseDurationMs = input.leaseDurationMs ?? 1_800_000;

    // Renewal path: same agent can extend the lease on an already-claimed bounty.
    // This prevents long-running bounties from getting stranded when the claim
    // lease expires while the worker is still active.
    if (
      bounty.status === BS.Claimed &&
      bounty.claimedBy?.agentId === agent.agentId &&
      bounty.claimId
    ) {
      // Check if the existing claim is still active. If expired, we need a
      // fresh claim ID — reusing the old one would collide with the persisted
      // expired claim record instead of renewing it.
      const existingClaim = await deps.claimStore.getClaim(bounty.claimId);
      const claimIsActive = existingClaim?.status === "active";

      const renewalClaimId = claimIsActive ? bounty.claimId : crypto.randomUUID();
      const renewed = await deps.claimStore.claimOrRenew({
        claimId: renewalClaimId,
        targetRef: `bounty:${input.bountyId}`,
        agent,
        status: "active",
        intentSummary: `Renewing claim on bounty: ${bounty.title}`,
        createdAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      });

      // If we rotated the claim ID, update the bounty record to point at the new claim
      if (renewalClaimId !== bounty.claimId) {
        await deps.bountyStore.claimBounty(input.bountyId, agent, renewed.claimId);
      }

      return ok({
        bountyId: bounty.bountyId,
        title: bounty.title,
        status: bounty.status,
        claimId: renewed.claimId,
        claimedBy: bounty.claimedBy.agentId,
      });
    }

    // New claim: bounty must be open
    if (bounty.status !== BS.Open) {
      return validationErr(
        `Bounty '${input.bountyId}' is not open for claims (current status: ${bounty.status})`,
      );
    }

    const claimId = crypto.randomUUID();

    // Create claim via existing claim system
    const claim = await deps.claimStore.claimOrRenew({
      claimId,
      targetRef: `bounty:${input.bountyId}`,
      agent,
      status: "active",
      intentSummary: `Claiming bounty: ${bounty.title}`,
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    });

    let claimed: Bounty;
    try {
      claimed = await deps.bountyStore.claimBounty(input.bountyId, agent, claim.claimId);
    } catch (bountyErr) {
      // If the bounty transition failed (pre-commit or CAS conflict), the
      // claim lease is orphaned. Re-read the bounty: if it's still open,
      // the transition didn't commit and we can safely release the claim.
      // If it's already claimed (post-commit failure), keep the claim.
      try {
        const current = await deps.bountyStore.getBounty(input.bountyId);
        if (current && current.status === BS.Open) {
          await deps.claimStore.release(claim.claimId);
        }
      } catch {
        // Best-effort release — claim will expire via lease timeout
      }
      throw bountyErr;
    }

    return ok({
      bountyId: claimed.bountyId,
      title: claimed.title,
      status: claimed.status,
      claimId: claim.claimId,
      claimedBy: claimed.claimedBy?.agentId,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/**
 * Settle a bounty using the saga pattern:
 *   claimed → pending_settlement (pivot) → capture → completed → settled
 *
 * Retryable: if the operation is called again on a pending_settlement bounty,
 * it resumes from the capture step (capture is idempotent).
 */
export async function settleBountyOperation(
  input: SettleBountyInput,
  deps: OperationDeps,
): Promise<OperationResult<SettleBountyResult>> {
  try {
    if (deps.bountyStore === undefined) {
      return validationErr(MISSING_BOUNTY_STORE);
    }

    if (deps.contributionStore === undefined) {
      return validationErr(MISSING_CONTRIBUTION_STORE);
    }

    const bounty = await deps.bountyStore.getBounty(input.bountyId);
    if (!bounty) {
      return notFound("Bounty", input.bountyId);
    }

    // Allow "claimed" (fresh), "pending_settlement" (post-pivot), "completed" (post-capture)
    const resumable =
      bounty.status === BS.Claimed ||
      bounty.status === BS.PendingSettlement ||
      bounty.status === BS.Completed;
    if (!resumable) {
      return validationErr(
        `Bounty '${input.bountyId}' cannot be settled (current status: ${bounty.status})`,
      );
    }

    // On resume from pending_settlement or completed, the fulfillment CID
    // is frozen — reject attempts to change it.
    let fulfilledByCid = input.contributionCid;
    if (bounty.status !== BS.Claimed) {
      if (bounty.fulfilledByCid && input.contributionCid !== bounty.fulfilledByCid) {
        return validationErr(
          `Bounty '${input.bountyId}' is already pending settlement with contribution ` +
            `'${bounty.fulfilledByCid}' — cannot change to '${input.contributionCid}'`,
        );
      }
      fulfilledByCid = bounty.fulfilledByCid ?? input.contributionCid;
    }

    // Validate contribution exists and meets criteria
    const contribution = await deps.contributionStore.get(fulfilledByCid);
    if (!contribution) {
      return notFound("Contribution", fulfilledByCid);
    }
    if (!evaluateBountyCriteria(bounty.criteria, contribution)) {
      return validationErr(`Contribution '${fulfilledByCid}' does not meet bounty criteria`);
    }

    // Require credits service when escrow is active
    if (bounty.reservationId && !deps.creditsService) {
      return validationErr(
        "Cannot settle bounty with escrowed credits: creditsService is not available",
      );
    }

    // Step 1: Pivot — transition to pending_settlement (skip if resuming)
    if (bounty.status === BS.Claimed) {
      await deps.bountyStore.beginSettlement(input.bountyId, fulfilledByCid);
    }

    // Step 2: Capture payment (idempotent — safe to retry)
    if (deps.creditsService && bounty.reservationId && bounty.claimedBy) {
      await deps.creditsService.capture(bounty.reservationId, {
        toAgentId: bounty.claimedBy.agentId,
      });
    } else if (deps.creditsService && bounty.reservationId) {
      await deps.creditsService.capture(bounty.reservationId);
    }

    // Step 3: Advance through completed → settled (skip steps already done)
    if (bounty.status !== BS.Completed) {
      await deps.bountyStore.completeBounty(input.bountyId, fulfilledByCid);
    }
    const settled = await deps.bountyStore.settleBounty(input.bountyId);

    return ok({
      bountyId: settled.bountyId,
      status: settled.status,
      fulfilledByCid: settled.fulfilledByCid,
      amount: settled.amount,
      paidTo: settled.claimedBy?.agentId,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}
