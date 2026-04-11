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
// Operations
// ---------------------------------------------------------------------------

const DEFAULT_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const MISSING_BOUNTY_STORE = "Bounty operations not available (missing bountyStore)";

/** Create a new bounty with optional credit reservation. */
export async function createBountyOperation(
  input: CreateBountyInput,
  deps: OperationDeps,
): Promise<OperationResult<CreateBountyResult>> {
  try {
    if (deps.bountyStore === undefined) {
      return validationErr(MISSING_BOUNTY_STORE);
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

    try {
      const result = await deps.bountyStore.createBounty(bounty);
      return ok({
        bountyId: result.bountyId,
        title: result.title,
        amount: result.amount,
        status: result.status,
        deadline: result.deadline,
        reservationId: result.reservationId,
      });
    } catch (storeErr) {
      // Compensating action: void the reservation so credits are returned
      // to the agent's available balance. void() is idempotent and non-fatal.
      if (reservationId !== undefined && deps.creditsService !== undefined) {
        try {
          await deps.creditsService.void(reservationId);
        } catch {
          // Best-effort — reservation will auto-expire at its timeout.
        }
      }
      return fromGroveError(storeErr);
    }
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
      return validationErr("Claim operations not available (missing claimStore)");
    }

    const bounty = await deps.bountyStore.getBounty(input.bountyId);
    if (!bounty) {
      return notFound("Bounty", input.bountyId);
    }

    // Pre-flight: only open bounties can be claimed. Checking here avoids
    // creating a dangling claim record before the store rejects the transition.
    if (bounty.status !== BS.Open) {
      return validationErr(
        `Bounty '${input.bountyId}' is not open (status: ${bounty.status})`,
      );
    }

    const agent = resolveAgent(input.agent);
    const now = new Date();
    const claimId = crypto.randomUUID();
    const leaseDurationMs = input.leaseDurationMs ?? 1_800_000;

    // Step 1: Create claim via existing claim system
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

    // Step 2: Update bounty status. On failure, release the claim so it doesn't
    // block other agents from claiming until the lease expires.
    let claimed;
    try {
      claimed = await deps.bountyStore.claimBounty(input.bountyId, agent, claim.claimId);
    } catch (bountyErr) {
      try {
        await deps.claimStore.release(claim.claimId);
      } catch {
        // Best-effort: the claim lease will expire on its own.
      }
      return fromGroveError(bountyErr);
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

/** Settle a completed bounty. */
export async function settleBountyOperation(
  input: SettleBountyInput,
  deps: OperationDeps,
): Promise<OperationResult<SettleBountyResult>> {
  try {
    if (deps.bountyStore === undefined) {
      return validationErr("Bounty operations not available (missing bountyStore)");
    }

    if (deps.contributionStore === undefined) {
      return validationErr("Settle bounty not available (missing contributionStore)");
    }

    const bounty = await deps.bountyStore.getBounty(input.bountyId);
    if (!bounty) {
      return notFound("Bounty", input.bountyId);
    }

    // Validate contribution exists and meets criteria
    const contribution = await deps.contributionStore.get(input.contributionCid);
    if (!contribution) {
      return notFound("Contribution", input.contributionCid);
    }
    if (!evaluateBountyCriteria(bounty.criteria, contribution)) {
      return validationErr(`Contribution '${input.contributionCid}' does not meet bounty criteria`);
    }

    // Require credits service when escrow is active
    if (bounty.reservationId && !deps.creditsService) {
      return validationErr(
        "Cannot settle bounty with escrowed credits: creditsService is not available",
      );
    }

    // Persist state transitions first, then capture payment.
    // Order matters: a failed state update before payment leaves the bounty
    // recoverable (retry settle); a failed state update after payment would
    // orphan captured funds with no record to reconcile against.
    const completed = await deps.bountyStore.completeBounty(input.bountyId, input.contributionCid);
    const settled = await deps.bountyStore.settleBounty(completed.bountyId);

    // Capture payment after state is persisted
    if (deps.creditsService && bounty.reservationId && bounty.claimedBy) {
      await deps.creditsService.capture(bounty.reservationId, {
        toAgentId: bounty.claimedBy.agentId,
      });
    } else if (deps.creditsService && bounty.reservationId) {
      await deps.creditsService.capture(bounty.reservationId);
    }

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
