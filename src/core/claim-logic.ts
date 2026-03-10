/**
 * Shared claim state-transition logic.
 *
 * Pure functions that validate claim operations. Both the local
 * SQLite adapter and the Nexus adapter use these to enforce
 * consistent business rules without duplicating validation.
 */

import { ContextSchema } from "./manifest.js";
import type { Claim, ClaimStatus } from "./models.js";

/** Default lease duration in milliseconds (5 minutes). */
export const DEFAULT_LEASE_DURATION_MS = 300_000;

/**
 * Validate that a claim's context field contains only JSON-safe values.
 * Throws if the context contains non-JSON types (Date, Map, Set, etc.).
 */
export function validateClaimContext(claim: Claim): void {
  if (claim.context !== undefined) {
    const result = ContextSchema.safeParse(claim.context);
    if (!result.success) {
      throw new Error(`Invalid claim context: ${result.error.message}`);
    }
  }
}

/**
 * Check if a claim is currently active and has a valid (non-expired) lease.
 */
export function isClaimActiveAndValid(claim: Claim, now: Date = new Date()): boolean {
  return claim.status === "active" && new Date(claim.leaseExpiresAt).getTime() >= now.getTime();
}

/**
 * Validate that a claim can be heartbeated.
 * Throws with a specific error message if the transition is invalid.
 */
export function validateHeartbeat(claim: Claim | undefined, claimId: string): void {
  if (claim === undefined) {
    throw new Error(`Claim '${claimId}' not found`);
  }
  if (claim.status !== "active") {
    throw new Error(
      `Cannot heartbeat claim '${claimId}' with status '${claim.status}' (must be active)`,
    );
  }
  if (new Date(claim.leaseExpiresAt).getTime() < Date.now()) {
    throw new Error(
      `Cannot heartbeat claim '${claimId}': lease expired at ${claim.leaseExpiresAt}`,
    );
  }
}

/**
 * Validate that a claim can transition to a new status (release/complete).
 * Throws with a specific error message if the transition is invalid.
 */
export function validateTransition(
  claim: Claim | undefined,
  claimId: string,
  newStatus: ClaimStatus,
): void {
  if (claim === undefined) {
    throw new Error(`Claim '${claimId}' not found`);
  }
  if (claim.status !== "active") {
    throw new Error(
      `Cannot transition claim '${claimId}' from '${claim.status}' to '${newStatus}' (must be active)`,
    );
  }
}

/**
 * Determine the outcome of a claimOrRenew operation given the existing
 * active claim (if any) on the target.
 *
 * Returns:
 * - `{ action: "create" }` if no active claim exists
 * - `{ action: "renew", existingClaimId }` if same agent has active claim
 * - Throws if a different agent has the active claim
 */
export function resolveClaimOrRenew(
  existingClaim: { claimId: string; agentId: string } | undefined,
  incomingAgentId: string,
  targetRef: string,
): { action: "create" } | { action: "renew"; existingClaimId: string } {
  if (existingClaim === undefined) {
    return { action: "create" };
  }

  if (existingClaim.agentId === incomingAgentId) {
    return { action: "renew", existingClaimId: existingClaim.claimId };
  }

  throw new Error(
    `Target '${targetRef}' already has an active claim '${existingClaim.claimId}' by agent '${existingClaim.agentId}'`,
  );
}

/**
 * Compute the lease duration from a claim's timestamps.
 * Uses heartbeatAt (the moving lease anchor) rather than createdAt (immutable
 * provenance), so renewals extend by the original duration, not by claim age.
 * Falls back to the default lease duration if the computed duration is non-positive.
 */
export function computeLeaseDuration(claim: Claim): number {
  const requested =
    new Date(claim.leaseExpiresAt).getTime() - new Date(claim.heartbeatAt).getTime();
  return requested > 0 ? requested : DEFAULT_LEASE_DURATION_MS;
}
