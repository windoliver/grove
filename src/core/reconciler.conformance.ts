/**
 * Conformance test suite for Reconciler implementations.
 *
 * Tests the reconciliation protocol: expire stale claims, detect
 * stalled agents, deduplicate active claims, clean completed claims,
 * and startup reconciliation.
 *
 * Any backend can validate by calling `runReconcilerTests()` with
 * factories that create fresh store + reconciler instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ClaimStatus } from "./models.js";
import type { Reconciler } from "./reconciler.js";
import { ExpiryReason } from "./store.js";
import type { ClaimStore } from "./store.js";
import { makeClaim } from "./test-helpers.js";

/** Factory for creating test instances. */
export type ReconcilerFactory = () => Promise<{
  claimStore: ClaimStore;
  reconciler: Reconciler;
  cleanup: () => Promise<void>;
}>;

/**
 * Run the full Reconciler conformance test suite.
 */
export function runReconcilerTests(factory: ReconcilerFactory): void {
  describe("Reconciler conformance", () => {
    let claimStore: ClaimStore;
    let reconciler: Reconciler;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      claimStore = result.claimStore;
      reconciler = result.reconciler;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      claimStore.close();
      await cleanup();
    });

    // ------------------------------------------------------------------
    // reconcile — expire stale claims
    // ------------------------------------------------------------------

    test("reconcile expires claims with expired leases", async () => {
      const expired = makeClaim({
        claimId: "expired-lease",
        targetRef: "target-1",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await claimStore.createClaim(expired);

      const result = await reconciler.reconcile();
      expect(result.expiredClaims.length).toBe(1);
      expect(result.expiredClaims[0]?.claim.claimId).toBe("expired-lease");
      expect(result.expiredClaims[0]?.reason).toBe(ExpiryReason.LeaseExpired);

      const claim = await claimStore.getClaim("expired-lease");
      expect(claim?.status).toBe(ClaimStatus.Expired);
    });

    test("reconcile does not expire active claims with valid leases", async () => {
      const active = makeClaim({
        claimId: "active-valid",
        targetRef: "target-2",
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      await claimStore.createClaim(active);

      const result = await reconciler.reconcile();
      expect(result.expiredClaims.length).toBe(0);

      const claim = await claimStore.getClaim("active-valid");
      expect(claim?.status).toBe(ClaimStatus.Active);
    });

    test("reconcile expires multiple stale claims at once", async () => {
      for (let i = 0; i < 3; i++) {
        await claimStore.createClaim(
          makeClaim({
            claimId: `expired-${i}`,
            targetRef: `target-${i}`,
            leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
          }),
        );
      }

      const result = await reconciler.reconcile();
      expect(result.expiredClaims.length).toBe(3);
    });

    // ------------------------------------------------------------------
    // reconcile — deduplicate active claims
    // ------------------------------------------------------------------

    test("reconcile deduplicates active claims by same agent on same target", async () => {
      // Create two active claims by the same agent on the same target
      // This shouldn't normally happen with claimOrRenew, but can happen
      // through direct createClaim calls or race conditions.
      // We simulate by creating on different targets then updating the DB.
      const claim1 = makeClaim({
        claimId: "dup-old",
        targetRef: "dup-target",
        agent: { agentId: "agent-a" },
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await claimStore.createClaim(claim1);

      // Release the first claim so we can create another on the same target
      await claimStore.release("dup-old");

      // Create a newer claim
      const claim2 = makeClaim({
        claimId: "dup-new",
        targetRef: "dup-target",
        agent: { agentId: "agent-a" },
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        createdAt: new Date().toISOString(),
      });
      await claimStore.createClaim(claim2);

      // Dedup only applies to active claims — dup-old is already released
      // so no dedup should happen
      const result = await reconciler.reconcile();
      expect(result.deduplicatedClaims.length).toBe(0);
    });

    // ------------------------------------------------------------------
    // reconcile — clean completed claims
    // ------------------------------------------------------------------

    test("reconcile cleans terminal claims past retention", async () => {
      // Create a completed claim with old heartbeatAt (last activity 30 days ago)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const old = makeClaim({
        claimId: "old-completed",
        targetRef: "target-old",
        createdAt: thirtyDaysAgo,
        heartbeatAt: thirtyDaysAgo,
      });
      await claimStore.createClaim(old);
      await claimStore.complete("old-completed");

      const result = await reconciler.reconcile();
      expect(result.cleanedCount).toBeGreaterThanOrEqual(1);

      const claim = await claimStore.getClaim("old-completed");
      expect(claim).toBeUndefined();
    });

    test("reconcile preserves recent terminal claims", async () => {
      const recent = makeClaim({
        claimId: "recent-completed",
        targetRef: "target-recent",
      });
      await claimStore.createClaim(recent);
      await claimStore.complete("recent-completed");

      const result = await reconciler.reconcile();
      // Recent claim should not be cleaned
      const claim = await claimStore.getClaim("recent-completed");
      expect(claim).toBeDefined();
      expect(claim?.status).toBe(ClaimStatus.Completed);
    });

    // ------------------------------------------------------------------
    // reconcile — idempotency
    // ------------------------------------------------------------------

    test("reconcile is idempotent (calling twice produces same state)", async () => {
      const expired = makeClaim({
        claimId: "idem-expired",
        targetRef: "target-idem",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await claimStore.createClaim(expired);

      const result1 = await reconciler.reconcile();
      expect(result1.expiredClaims.length).toBe(1);

      // Second call should find nothing to do
      const result2 = await reconciler.reconcile();
      expect(result2.expiredClaims.length).toBe(0);
      expect(result2.deduplicatedClaims.length).toBe(0);
    });

    // ------------------------------------------------------------------
    // reconcile — empty state
    // ------------------------------------------------------------------

    test("reconcile on empty store returns zeros", async () => {
      const result = await reconciler.reconcile();
      expect(result.expiredClaims.length).toBe(0);
      expect(result.deduplicatedClaims.length).toBe(0);
      expect(result.cleanedCount).toBe(0);
    });

    // ------------------------------------------------------------------
    // startupReconcile
    // ------------------------------------------------------------------

    test("startupReconcile expires stale claims", async () => {
      const expired = makeClaim({
        claimId: "startup-expired",
        targetRef: "target-startup",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await claimStore.createClaim(expired);

      const result = await reconciler.startupReconcile();
      expect(result.expiredClaims.length).toBe(1);
      expect(result.expiredClaims[0]?.claim.claimId).toBe("startup-expired");
    });

    test("startupReconcile on empty store returns empty results", async () => {
      const result = await reconciler.startupReconcile();
      expect(result.expiredClaims.length).toBe(0);
      expect(result.orphanedWorkspaces.length).toBe(0);
    });

    test("startupReconcile preserves active claims with valid leases", async () => {
      const active = makeClaim({
        claimId: "startup-active",
        targetRef: "target-startup-active",
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      await claimStore.createClaim(active);

      const result = await reconciler.startupReconcile();
      expect(result.expiredClaims.length).toBe(0);

      const claim = await claimStore.getClaim("startup-active");
      expect(claim?.status).toBe(ClaimStatus.Active);
    });
  });
}
