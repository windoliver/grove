/**
 * Conformance test suite for ClaimStore implementations.
 *
 * Any backend that implements ClaimStore can validate its behavior
 * by calling `runClaimStoreTests()` with a factory that creates
 * fresh store instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ClaimStatus } from "./models.js";
import type { ClaimStore } from "./store.js";
import { makeClaim } from "./test-helpers.js";

/** Factory that creates a fresh ClaimStore and returns a cleanup function. */
export type ClaimStoreFactory = () => Promise<{
  store: ClaimStore;
  cleanup: () => Promise<void>;
}>;

/**
 * Run the full ClaimStore conformance test suite.
 *
 * Call this from your backend-specific test file with a factory
 * that creates and tears down store instances.
 */
export function runClaimStoreTests(factory: ClaimStoreFactory): void {
  describe("ClaimStore conformance", () => {
    let store: ClaimStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      store = result.store;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      store.close();
      await cleanup();
    });

    // ------------------------------------------------------------------
    // createClaim / getClaim
    // ------------------------------------------------------------------

    test("createClaim stores and returns a claim", async () => {
      const claim = makeClaim();
      const result = await store.createClaim(claim);
      expect(result.claimId).toBe(claim.claimId);
      expect(result.targetRef).toBe(claim.targetRef);
      expect(result.status).toBe(ClaimStatus.Active);
      expect(result.intentSummary).toBe(claim.intentSummary);
    });

    test("createClaim throws on duplicate claimId", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      await expect(store.createClaim(claim)).rejects.toThrow();
    });

    test("createClaim throws when target already has an active claim", async () => {
      const claim1 = makeClaim({ claimId: "first", targetRef: "shared-target" });
      await store.createClaim(claim1);
      const claim2 = makeClaim({ claimId: "second", targetRef: "shared-target" });
      await expect(store.createClaim(claim2)).rejects.toThrow(/active claim/);
    });

    test("createClaim allows claiming target after previous claim released", async () => {
      const claim1 = makeClaim({ claimId: "released-claim", targetRef: "shared-target" });
      await store.createClaim(claim1);
      await store.release(claim1.claimId);
      const claim2 = makeClaim({ claimId: "new-claim", targetRef: "shared-target" });
      const result = await store.createClaim(claim2);
      expect(result.claimId).toBe("new-claim");
    });

    test("createClaim handles offset timestamps correctly for target exclusivity", async () => {
      // Create a claim with a timezone-offset lease that is 30 minutes in the future
      const futureMs = Date.now() + 30 * 60_000;
      const futureWithOffset = new Date(futureMs).toISOString().replace("Z", "+00:00");
      const claim1 = makeClaim({
        claimId: "offset-claim",
        targetRef: "offset-target",
        leaseExpiresAt: futureWithOffset,
      });
      await store.createClaim(claim1);

      // Second claim on same target should be rejected despite offset format
      const claim2 = makeClaim({
        claimId: "offset-claim-2",
        targetRef: "offset-target",
      });
      await expect(store.createClaim(claim2)).rejects.toThrow(/active claim/);

      // The claim should appear in activeClaims
      const actives = await store.activeClaims("offset-target");
      expect(actives.length).toBe(1);
      expect(actives[0]?.claimId).toBe("offset-claim");
    });

    test("createClaim allows claiming target after previous claim lease expired", async () => {
      const expired = makeClaim({
        claimId: "expired-claim",
        targetRef: "shared-target",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await store.createClaim(expired);
      const claim2 = makeClaim({ claimId: "fresh-claim", targetRef: "shared-target" });
      const result = await store.createClaim(claim2);
      expect(result.claimId).toBe("fresh-claim");
    });

    test("getClaim returns stored claim", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      const retrieved = await store.getClaim(claim.claimId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.claimId).toBe(claim.claimId);
      expect(retrieved?.targetRef).toBe(claim.targetRef);
      expect(retrieved?.agent).toEqual(claim.agent);
    });

    test("getClaim returns undefined for non-existent claim", async () => {
      const result = await store.getClaim("nonexistent");
      expect(result).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // heartbeat
    // ------------------------------------------------------------------

    test("heartbeat updates heartbeat_at and extends lease", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);

      const updated = await store.heartbeat(claim.claimId);
      expect(updated.claimId).toBe(claim.claimId);
      expect(updated.status).toBe(ClaimStatus.Active);
      // heartbeat_at should be updated (at or after original)
      expect(new Date(updated.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
        new Date(claim.heartbeatAt).getTime(),
      );
      // lease should be extended
      expect(new Date(updated.leaseExpiresAt).getTime()).toBeGreaterThan(
        new Date(claim.heartbeatAt).getTime(),
      );
    });

    test("heartbeat throws for non-existent claim", async () => {
      await expect(store.heartbeat("nonexistent")).rejects.toThrow();
    });

    test("heartbeat throws for non-active claim (released)", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      await store.release(claim.claimId);
      await expect(store.heartbeat(claim.claimId)).rejects.toThrow();
    });

    test("heartbeat throws for non-active claim (completed)", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      await store.complete(claim.claimId);
      await expect(store.heartbeat(claim.claimId)).rejects.toThrow();
    });

    test("heartbeat accepts custom lease duration", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);

      const before = Date.now();
      const updated = await store.heartbeat(claim.claimId, 120_000);
      const expectedMinExpiry = before + 120_000 - 1000; // 1s tolerance
      expect(new Date(updated.leaseExpiresAt).getTime()).toBeGreaterThanOrEqual(expectedMinExpiry);
    });

    // ------------------------------------------------------------------
    // release
    // ------------------------------------------------------------------

    test("release changes status to released", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      const released = await store.release(claim.claimId);
      expect(released.status).toBe(ClaimStatus.Released);
      expect(released.claimId).toBe(claim.claimId);
    });

    test("release throws for non-active claim", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      await store.release(claim.claimId);
      await expect(store.release(claim.claimId)).rejects.toThrow();
    });

    // ------------------------------------------------------------------
    // complete
    // ------------------------------------------------------------------

    test("complete changes status to completed", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      const completed = await store.complete(claim.claimId);
      expect(completed.status).toBe(ClaimStatus.Completed);
      expect(completed.claimId).toBe(claim.claimId);
    });

    test("complete throws for non-active claim", async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      await store.complete(claim.claimId);
      await expect(store.complete(claim.claimId)).rejects.toThrow();
    });

    // ------------------------------------------------------------------
    // expireStale
    // ------------------------------------------------------------------

    test("expireStale marks expired claims", async () => {
      // Create a claim with an already-expired lease
      const expired = makeClaim({
        claimId: "expired-claim",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await store.createClaim(expired);

      const stale = await store.expireStale();
      expect(stale.length).toBe(1);
      expect(stale[0]?.claimId).toBe("expired-claim");
      expect(stale[0]?.status).toBe(ClaimStatus.Expired);
    });

    test("expireStale returns the expired claims", async () => {
      const expired1 = makeClaim({
        claimId: "exp-1",
        leaseExpiresAt: new Date(Date.now() - 5_000).toISOString(),
      });
      const expired2 = makeClaim({
        claimId: "exp-2",
        leaseExpiresAt: new Date(Date.now() - 5_000).toISOString(),
      });
      await store.createClaim(expired1);
      await store.createClaim(expired2);

      const stale = await store.expireStale();
      expect(stale.length).toBe(2);
      const ids = stale.map((c) => c.claimId);
      expect(ids).toContain("exp-1");
      expect(ids).toContain("exp-2");
    });

    test("expireStale does not affect non-expired active claims", async () => {
      // One expired, one still active
      const expired = makeClaim({
        claimId: "stale",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      const active = makeClaim({
        claimId: "fresh",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await store.createClaim(expired);
      await store.createClaim(active);

      const stale = await store.expireStale();
      expect(stale.length).toBe(1);
      expect(stale[0]?.claimId).toBe("stale");

      // The fresh claim should still be active
      const freshClaim = await store.getClaim("fresh");
      expect(freshClaim).toBeDefined();
      expect(freshClaim?.status).toBe(ClaimStatus.Active);
    });

    // ------------------------------------------------------------------
    // activeClaims
    // ------------------------------------------------------------------

    test("activeClaims returns only active claims", async () => {
      const active = makeClaim({ claimId: "active-1", targetRef: "target-active" });
      const released = makeClaim({ claimId: "released-1", targetRef: "target-released" });
      await store.createClaim(active);
      await store.createClaim(released);
      await store.release(released.claimId);

      const actives = await store.activeClaims();
      expect(actives.length).toBe(1);
      expect(actives[0]?.claimId).toBe("active-1");
    });

    test("activeClaims excludes claims with expired leases", async () => {
      const expired = makeClaim({
        claimId: "expired-active",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      const fresh = makeClaim({
        claimId: "fresh-active",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await store.createClaim(expired);
      await store.createClaim(fresh);

      const actives = await store.activeClaims();
      expect(actives.length).toBe(1);
      expect(actives[0]?.claimId).toBe("fresh-active");
    });

    test("heartbeat throws for claim with expired lease", async () => {
      const expired = makeClaim({
        claimId: "expired-heartbeat",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await store.createClaim(expired);
      await expect(store.heartbeat("expired-heartbeat")).rejects.toThrow();
    });

    test("activeClaims filters by targetRef", async () => {
      const claim1 = makeClaim({
        claimId: "c1",
        targetRef: "target-A",
      });
      const claim2 = makeClaim({
        claimId: "c2",
        targetRef: "target-B",
      });
      await store.createClaim(claim1);
      await store.createClaim(claim2);

      const results = await store.activeClaims("target-A");
      expect(results.length).toBe(1);
      expect(results[0]?.claimId).toBe("c1");
    });

    // ------------------------------------------------------------------
    // created_at immutability
    // ------------------------------------------------------------------

    test("created_at is not modified by heartbeat", async () => {
      const claim = makeClaim();
      const created = await store.createClaim(claim);
      const originalCreatedAt = created.createdAt;

      const updated = await store.heartbeat(claim.claimId);
      expect(updated.createdAt).toBe(originalCreatedAt);
      // heartbeat_at should be updated, but created_at stays the same
      expect(new Date(updated.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalCreatedAt).getTime(),
      );
    });

    test("created_at is not modified by release", async () => {
      const claim = makeClaim();
      const created = await store.createClaim(claim);
      const originalCreatedAt = created.createdAt;

      const released = await store.release(claim.claimId);
      expect(released.createdAt).toBe(originalCreatedAt);
    });

    test("created_at is not modified by complete", async () => {
      const claim = makeClaim();
      const created = await store.createClaim(claim);
      const originalCreatedAt = created.createdAt;

      const completed = await store.complete(claim.claimId);
      expect(completed.createdAt).toBe(originalCreatedAt);
    });

    // ------------------------------------------------------------------
    // context round-trip
    // ------------------------------------------------------------------

    test("context is stored and retrieved correctly", async () => {
      const claim = makeClaim({
        claimId: "ctx-simple",
        context: { branch: "feat/new-model", priority: 5 },
      });
      const created = await store.createClaim(claim);
      expect(created.context).toEqual({ branch: "feat/new-model", priority: 5 });

      const retrieved = await store.getClaim("ctx-simple");
      expect(retrieved?.context).toEqual({ branch: "feat/new-model", priority: 5 });
    });

    test("context with nested values survives round-trip", async () => {
      const nestedContext = {
        workflow: "autoresearch",
        config: { model: "claude-opus-4-6", budget: 100, tags: ["ml", "nlp"] },
        scores: [0.95, 0.87, 0.92],
        nullable: null,
        flag: true,
      };
      const claim = makeClaim({
        claimId: "ctx-nested",
        context: nestedContext,
      });
      const created = await store.createClaim(claim);
      expect(created.context).toEqual(nestedContext);

      const retrieved = await store.getClaim("ctx-nested");
      expect(retrieved?.context).toEqual(nestedContext);
    });

    test("context rejects non-JSON-safe values (Date)", async () => {
      const claim = makeClaim({
        claimId: "ctx-invalid",
        // Force a Date through the type system to simulate runtime misuse
        context: { when: new Date() } as unknown as Record<string, never>,
      });
      await expect(store.createClaim(claim)).rejects.toThrow(/context/i);
    });

    test("claim without context returns undefined for context", async () => {
      const claim = makeClaim({ claimId: "no-ctx" });
      await store.createClaim(claim);

      const retrieved = await store.getClaim("no-ctx");
      expect(retrieved?.context).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // agent identity round-trip
    // ------------------------------------------------------------------

    test("full agent identity survives round-trip", async () => {
      const fullAgent = {
        agentId: "agent-007",
        agentName: "Research Agent",
        provider: "anthropic",
        model: "claude-opus-4-6",
        version: "1.0.0",
        toolchain: "claude-code",
        runtime: "bun-1.3.9",
        platform: "H100",
      };
      const claim = makeClaim({ claimId: "full-agent", agent: fullAgent });
      await store.createClaim(claim);

      const retrieved = await store.getClaim("full-agent");
      expect(retrieved?.agent).toEqual(fullAgent);
    });

    // ------------------------------------------------------------------
    // close
    // ------------------------------------------------------------------

    test("close does not throw", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
}
