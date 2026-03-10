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
      expect(stale[0]?.claim.claimId).toBe("expired-claim");
      expect(stale[0]?.claim.status).toBe(ClaimStatus.Expired);
      expect(stale[0]?.reason).toBe("lease_expired");
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
      const ids = stale.map((c) => c.claim.claimId);
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
      expect(stale[0]?.claim.claimId).toBe("stale");

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
    // claimOrRenew
    // ------------------------------------------------------------------

    test("claimOrRenew creates new claim when no active claim exists", async () => {
      const claim = makeClaim({ claimId: "renew-new", targetRef: "renew-target" });
      const result = await store.claimOrRenew(claim);
      expect(result.claimId).toBe("renew-new");
      expect(result.status).toBe(ClaimStatus.Active);
    });

    test("claimOrRenew renews existing claim by same agent", async () => {
      const original = makeClaim({
        claimId: "renew-original",
        targetRef: "renew-target-2",
        agent: { agentId: "agent-x" },
        intentSummary: "original intent",
      });
      const created = await store.createClaim(original);

      const beforeRenew = Date.now();
      const renewal = makeClaim({
        claimId: "renew-attempt",
        targetRef: "renew-target-2",
        agent: { agentId: "agent-x" },
        intentSummary: "updated intent",
        // Simulate a stale payload — old timestamps that should be ignored
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() - 30_000).toISOString(),
      });
      const result = await store.claimOrRenew(renewal);

      // Should return the original claim ID, not the new one
      expect(result.claimId).toBe("renew-original");
      // Intent summary should be updated
      expect(result.intentSummary).toBe("updated intent");
      // Lease should be extended from NOW, not from the stale payload
      expect(new Date(result.heartbeatAt).getTime()).toBeGreaterThanOrEqual(beforeRenew);
      expect(new Date(result.leaseExpiresAt).getTime()).toBeGreaterThan(beforeRenew);
    });

    test("claimOrRenew respects requested lease duration on renewal", async () => {
      const original = makeClaim({
        claimId: "renew-duration",
        targetRef: "renew-target-dur",
        agent: { agentId: "agent-d" },
      });
      await store.createClaim(original);

      const beforeRenew = Date.now();
      // Request a 1-hour lease via createdAt/leaseExpiresAt spread
      const renewalCreatedAt = new Date(beforeRenew).toISOString();
      const renewalLeaseExpires = new Date(beforeRenew + 3_600_000).toISOString();
      const renewal = makeClaim({
        claimId: "renew-duration-attempt",
        targetRef: "renew-target-dur",
        agent: { agentId: "agent-d" },
        createdAt: renewalCreatedAt,
        leaseExpiresAt: renewalLeaseExpires,
      });
      const result = await store.claimOrRenew(renewal);

      // Lease should be approximately 1 hour from now (within 5s tolerance)
      const expectedMinExpiry = beforeRenew + 3_600_000 - 5_000;
      expect(new Date(result.leaseExpiresAt).getTime()).toBeGreaterThanOrEqual(expectedMinExpiry);
    });

    test("claimOrRenew throws when different agent has active claim", async () => {
      const existing = makeClaim({
        claimId: "renew-blocked",
        targetRef: "renew-target-3",
        agent: { agentId: "agent-a" },
      });
      await store.createClaim(existing);

      const attempt = makeClaim({
        claimId: "renew-different",
        targetRef: "renew-target-3",
        agent: { agentId: "agent-b" },
      });
      await expect(store.claimOrRenew(attempt)).rejects.toThrow(/active claim/);
    });

    test("claimOrRenew creates new claim after previous expired", async () => {
      const expired = makeClaim({
        claimId: "renew-expired",
        targetRef: "renew-target-4",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await store.createClaim(expired);

      const fresh = makeClaim({
        claimId: "renew-fresh",
        targetRef: "renew-target-4",
      });
      const result = await store.claimOrRenew(fresh);
      expect(result.claimId).toBe("renew-fresh");
      expect(result.status).toBe(ClaimStatus.Active);
    });

    // ------------------------------------------------------------------
    // expireStale — stall detection
    // ------------------------------------------------------------------

    test("expireStale with stallThresholdMs detects stalled agents", async () => {
      // Create a claim with valid lease but old heartbeat
      const stalled = makeClaim({
        claimId: "stalled-agent",
        targetRef: "stall-target",
        heartbeatAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), // still valid
      });
      await store.createClaim(stalled);

      // Without stall threshold, claim should NOT be expired
      const noStall = await store.expireStale();
      expect(noStall.length).toBe(0);

      // With stall threshold of 60s, claim should be expired
      const withStall = await store.expireStale({ stallThresholdMs: 60_000 });
      expect(withStall.length).toBe(1);
      expect(withStall[0]?.claim.claimId).toBe("stalled-agent");
      expect(withStall[0]?.reason).toBe("stalled");
    });

    test("expireStale with stallThresholdMs does not expire fresh heartbeats", async () => {
      const fresh = makeClaim({
        claimId: "fresh-heartbeat",
        targetRef: "fresh-target",
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      await store.createClaim(fresh);

      const result = await store.expireStale({ stallThresholdMs: 60_000 });
      expect(result.length).toBe(0);
    });

    // ------------------------------------------------------------------
    // cleanCompleted
    // ------------------------------------------------------------------

    test("cleanCompleted deletes old terminal claims", async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const old = makeClaim({
        claimId: "clean-old",
        targetRef: "clean-target-1",
        createdAt: thirtyDaysAgo,
        heartbeatAt: thirtyDaysAgo, // old heartbeat → eligible for cleanup
      });
      await store.createClaim(old);
      await store.complete("clean-old");

      const deleted = await store.cleanCompleted(7 * 24 * 60 * 60 * 1000); // 7 day retention
      expect(deleted).toBe(1);

      const claim = await store.getClaim("clean-old");
      expect(claim).toBeUndefined();
    });

    test("cleanCompleted preserves recent terminal claims", async () => {
      const recent = makeClaim({
        claimId: "clean-recent",
        targetRef: "clean-target-2",
      });
      await store.createClaim(recent);
      await store.complete("clean-recent");

      const deleted = await store.cleanCompleted(7 * 24 * 60 * 60 * 1000);
      expect(deleted).toBe(0);

      const claim = await store.getClaim("clean-recent");
      expect(claim).toBeDefined();
    });

    test("cleanCompleted preserves active claims regardless of age", async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const oldActive = makeClaim({
        claimId: "clean-active",
        targetRef: "clean-target-3",
        createdAt: thirtyDaysAgo,
        heartbeatAt: thirtyDaysAgo,
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      await store.createClaim(oldActive);

      const deleted = await store.cleanCompleted(7 * 24 * 60 * 60 * 1000);
      expect(deleted).toBe(0);

      const claim = await store.getClaim("clean-active");
      expect(claim?.status).toBe(ClaimStatus.Active);
    });

    test("cleanCompleted preserves long-running claims completed recently", async () => {
      // Long-running claim (created 30 days ago) but completed moments ago
      // should NOT be deleted — heartbeat_at is recent
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const longRunning = makeClaim({
        claimId: "clean-long-running",
        targetRef: "clean-target-long",
        createdAt: thirtyDaysAgo,
        // heartbeatAt defaults to now (agent was alive until completion)
      });
      await store.createClaim(longRunning);
      await store.complete("clean-long-running");

      const deleted = await store.cleanCompleted(7 * 24 * 60 * 60 * 1000);
      expect(deleted).toBe(0); // recent heartbeat → not deleted

      const claim = await store.getClaim("clean-long-running");
      expect(claim).toBeDefined();
      expect(claim?.status).toBe(ClaimStatus.Completed);
    });

    test("cleanCompleted deletes expired and released claims past retention", async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const expired = makeClaim({
        claimId: "clean-expired",
        targetRef: "clean-target-4",
        createdAt: thirtyDaysAgo,
        heartbeatAt: thirtyDaysAgo,
        leaseExpiresAt: thirtyDaysAgo,
      });
      await store.createClaim(expired);

      const released = makeClaim({
        claimId: "clean-released",
        targetRef: "clean-target-5",
        createdAt: thirtyDaysAgo,
        heartbeatAt: thirtyDaysAgo,
      });
      await store.createClaim(released);
      await store.release("clean-released");

      const deleted = await store.cleanCompleted(7 * 24 * 60 * 60 * 1000);
      // The expired claim is still status='active' in DB (expireStale not called)
      // so only the released one should be deleted
      expect(deleted).toBe(1);
    });

    // ------------------------------------------------------------------
    // countActiveClaims
    // ------------------------------------------------------------------

    test("countActiveClaims returns 0 when no claims exist", async () => {
      const count = await store.countActiveClaims();
      expect(count).toBe(0);
    });

    test("countActiveClaims counts only active non-expired claims", async () => {
      const active = makeClaim({
        claimId: "count-active",
        targetRef: "t-count-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const expired = makeClaim({
        claimId: "count-expired",
        targetRef: "t-count-2",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      const released = makeClaim({
        claimId: "count-released",
        targetRef: "t-count-3",
      });
      await store.createClaim(active);
      await store.createClaim(expired);
      await store.createClaim(released);
      await store.release("count-released");

      const count = await store.countActiveClaims();
      expect(count).toBe(1);
    });

    test("countActiveClaims filters by agentId", async () => {
      const claim1 = makeClaim({
        claimId: "agent-a-1",
        targetRef: "t-filter-1",
        agent: { agentId: "agent-alpha", agentName: "Alpha" },
      });
      const claim2 = makeClaim({
        claimId: "agent-b-1",
        targetRef: "t-filter-2",
        agent: { agentId: "agent-beta", agentName: "Beta" },
      });
      await store.createClaim(claim1);
      await store.createClaim(claim2);

      const alphaCount = await store.countActiveClaims({ agentId: "agent-alpha" });
      expect(alphaCount).toBe(1);

      const betaCount = await store.countActiveClaims({ agentId: "agent-beta" });
      expect(betaCount).toBe(1);

      const allCount = await store.countActiveClaims();
      expect(allCount).toBe(2);
    });

    test("countActiveClaims filters by targetRef", async () => {
      const claim1 = makeClaim({
        claimId: "target-a",
        targetRef: "target-alpha",
      });
      const claim2 = makeClaim({
        claimId: "target-b",
        targetRef: "target-beta",
      });
      await store.createClaim(claim1);
      await store.createClaim(claim2);

      const alphaCount = await store.countActiveClaims({ targetRef: "target-alpha" });
      expect(alphaCount).toBe(1);
    });

    // ------------------------------------------------------------------
    // detectStalled
    // ------------------------------------------------------------------

    test("detectStalled returns empty when no stalled claims", async () => {
      const fresh = makeClaim({
        claimId: "fresh-stall",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await store.createClaim(fresh);
      // Heartbeat just happened, so with a 30s stall timeout nothing should be stalled
      const stalled = await store.detectStalled(30_000);
      expect(stalled.length).toBe(0);
    });

    test("detectStalled finds claims with stale heartbeats", async () => {
      // Create a claim with a long lease but whose heartbeat will be old
      const claim = makeClaim({
        claimId: "stalled-claim",
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      });
      await store.createClaim(claim);

      // With 60s stall timeout, a 120s-old heartbeat should be stalled
      const stalled = await store.detectStalled(60_000);
      expect(stalled.length).toBe(1);
      expect(stalled[0]?.claimId).toBe("stalled-claim");
    });

    test("detectStalled excludes non-active claims", async () => {
      const claim = makeClaim({
        claimId: "released-stall",
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      });
      await store.createClaim(claim);
      await store.release("released-stall");

      const stalled = await store.detectStalled(60_000);
      expect(stalled.length).toBe(0);
    });

    // ------------------------------------------------------------------
    // listClaims
    // ------------------------------------------------------------------

    test("listClaims returns all claims when no query provided", async () => {
      const c1 = makeClaim({ claimId: "list-1", targetRef: "lt-1" });
      const c2 = makeClaim({ claimId: "list-2", targetRef: "lt-2" });
      await store.createClaim(c1);
      await store.createClaim(c2);
      await store.release("list-2");

      const all = await store.listClaims();
      expect(all.length).toBe(2);
    });

    test("listClaims filters by single status", async () => {
      const c1 = makeClaim({ claimId: "ls-1", targetRef: "lst-1" });
      const c2 = makeClaim({ claimId: "ls-2", targetRef: "lst-2" });
      await store.createClaim(c1);
      await store.createClaim(c2);
      await store.release("ls-2");

      const active = await store.listClaims({ status: ClaimStatus.Active });
      expect(active.length).toBe(1);
      expect(active[0]?.claimId).toBe("ls-1");

      const released = await store.listClaims({ status: ClaimStatus.Released });
      expect(released.length).toBe(1);
      expect(released[0]?.claimId).toBe("ls-2");
    });

    test("listClaims filters by multiple statuses", async () => {
      const c1 = makeClaim({ claimId: "lm-1", targetRef: "lmt-1" });
      const c2 = makeClaim({ claimId: "lm-2", targetRef: "lmt-2" });
      const c3 = makeClaim({ claimId: "lm-3", targetRef: "lmt-3" });
      await store.createClaim(c1);
      await store.createClaim(c2);
      await store.createClaim(c3);
      await store.release("lm-2");
      await store.complete("lm-3");

      const terminal = await store.listClaims({
        status: [ClaimStatus.Released, ClaimStatus.Completed],
      });
      expect(terminal.length).toBe(2);
      const ids = terminal.map((c) => c.claimId);
      expect(ids).toContain("lm-2");
      expect(ids).toContain("lm-3");
    });

    test("listClaims filters by agentId", async () => {
      const c1 = makeClaim({
        claimId: "la-1",
        targetRef: "lat-1",
        agent: { agentId: "agent-x" },
      });
      const c2 = makeClaim({
        claimId: "la-2",
        targetRef: "lat-2",
        agent: { agentId: "agent-y" },
      });
      await store.createClaim(c1);
      await store.createClaim(c2);

      const xClaims = await store.listClaims({ agentId: "agent-x" });
      expect(xClaims.length).toBe(1);
      expect(xClaims[0]?.agent.agentId).toBe("agent-x");
    });

    test("listClaims combines status and agentId filters", async () => {
      const c1 = makeClaim({
        claimId: "lc-1",
        targetRef: "lct-1",
        agent: { agentId: "agent-a" },
      });
      const c2 = makeClaim({
        claimId: "lc-2",
        targetRef: "lct-2",
        agent: { agentId: "agent-a" },
      });
      const c3 = makeClaim({
        claimId: "lc-3",
        targetRef: "lct-3",
        agent: { agentId: "agent-b" },
      });
      await store.createClaim(c1);
      await store.createClaim(c2);
      await store.createClaim(c3);
      await store.release("lc-2");

      const result = await store.listClaims({
        status: ClaimStatus.Active,
        agentId: "agent-a",
      });
      expect(result.length).toBe(1);
      expect(result[0]?.claimId).toBe("lc-1");
    });

    test("listClaims returns empty array when no matches", async () => {
      const result = await store.listClaims({ agentId: "nonexistent" });
      expect(result.length).toBe(0);
    });

    test("listClaims orders by created_at descending", async () => {
      const c1 = makeClaim({
        claimId: "lo-1",
        targetRef: "lot-1",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const c2 = makeClaim({
        claimId: "lo-2",
        targetRef: "lot-2",
        createdAt: "2026-01-02T00:00:00Z",
      });
      await store.createClaim(c1);
      await store.createClaim(c2);

      const result = await store.listClaims();
      expect(result[0]?.claimId).toBe("lo-2");
      expect(result[1]?.claimId).toBe("lo-1");
    });

    // ------------------------------------------------------------------
    // close
    // ------------------------------------------------------------------

    test("close does not throw", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
}
