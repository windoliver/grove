/**
 * Claim operations.
 *
 * claimOperation     — Create or renew a claim
 * releaseOperation   — Release or complete a claim
 * listClaimsOperation — List claims with filters
 */

import type { Claim, ClaimStatus, JsonValue } from "../models.js";
import type { AgentOverrides } from "./agent.js";
import { resolveAgent } from "./agent.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { fromGroveError, notFound, ok, validationErr } from "./result.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of a claim operation. */
export interface ClaimResult {
  readonly claimId: string;
  readonly targetRef: string;
  readonly status: ClaimStatus;
  readonly agentId: string;
  readonly intentSummary: string;
  readonly leaseExpiresAt: string;
  readonly renewed: boolean;
}

/** Result of a release/complete operation. */
export interface ReleaseResult {
  readonly claimId: string;
  readonly targetRef: string;
  readonly status: ClaimStatus;
  readonly action: "release" | "complete";
}

/** Result of a list claims operation. */
export interface ListClaimsResult {
  readonly claims: readonly ClaimSummary[];
  readonly count: number;
}

/** Claim summary for list responses. */
export interface ClaimSummary {
  readonly claimId: string;
  readonly targetRef: string;
  readonly status: ClaimStatus;
  readonly agentId: string;
  readonly intentSummary: string;
  readonly leaseExpiresAt: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Input for the claim operation. */
export interface ClaimInput {
  readonly targetRef: string;
  readonly intentSummary: string;
  readonly leaseDurationMs?: number | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent?: AgentOverrides | undefined;
}

/** Input for the release operation. */
export interface ReleaseInput {
  readonly claimId: string;
  readonly action: "release" | "complete";
}

/** Input for the list claims operation. */
export interface ListClaimsInput {
  readonly status?: ClaimStatus | readonly ClaimStatus[] | undefined;
  readonly agentId?: string | undefined;
  readonly targetRef?: string | undefined;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const DEFAULT_LEASE_MS = 300_000; // 5 minutes

/** Create or renew a claim to prevent duplicate work. */
export async function claimOperation(
  input: ClaimInput,
  deps: OperationDeps,
): Promise<OperationResult<ClaimResult>> {
  try {
    if (deps.claimStore === undefined) {
      return validationErr("Claim operations not available (missing claimStore)");
    }

    const agent = resolveAgent(input.agent);
    const now = new Date();
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_MS;

    const claim: Claim = {
      claimId: crypto.randomUUID(),
      targetRef: input.targetRef,
      agent,
      status: "active",
      intentSummary: input.intentSummary,
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      ...(input.context !== undefined ? { context: input.context } : {}),
    };

    // Check if we're renewing by looking for existing active claim
    const activeBefore = await deps.claimStore.activeClaims(input.targetRef);
    const existing = activeBefore.find((c) => c.agent.agentId === agent.agentId);
    const renewed = existing !== undefined;

    const result = await deps.claimStore.claimOrRenew(claim);

    return ok({
      claimId: result.claimId,
      targetRef: result.targetRef,
      status: result.status,
      agentId: result.agent.agentId,
      intentSummary: result.intentSummary,
      leaseExpiresAt: result.leaseExpiresAt,
      renewed,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Release or complete an active claim. */
export async function releaseOperation(
  input: ReleaseInput,
  deps: OperationDeps,
): Promise<OperationResult<ReleaseResult>> {
  try {
    if (deps.claimStore === undefined) {
      return validationErr("Claim operations not available (missing claimStore)");
    }

    // Verify claim exists
    const existing = await deps.claimStore.getClaim(input.claimId);
    if (existing === undefined) {
      return notFound("Claim", input.claimId);
    }

    let result: Claim;
    if (input.action === "release") {
      result = await deps.claimStore.release(input.claimId);
    } else {
      result = await deps.claimStore.complete(input.claimId);
    }

    return ok({
      claimId: result.claimId,
      targetRef: result.targetRef,
      status: result.status,
      action: input.action,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** List claims with optional filters. */
export async function listClaimsOperation(
  input: ListClaimsInput,
  deps: OperationDeps,
): Promise<OperationResult<ListClaimsResult>> {
  try {
    if (deps.claimStore === undefined) {
      return validationErr("Claim operations not available (missing claimStore)");
    }

    const claims = await deps.claimStore.listClaims({
      status: input.status,
      agentId: input.agentId,
      targetRef: input.targetRef,
    });

    const summaries: ClaimSummary[] = claims.map((c) => ({
      claimId: c.claimId,
      targetRef: c.targetRef,
      status: c.status,
      agentId: c.agent.agentId,
      intentSummary: c.intentSummary,
      leaseExpiresAt: c.leaseExpiresAt,
      createdAt: c.createdAt,
    }));

    return ok({
      claims: summaries,
      count: summaries.length,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}
