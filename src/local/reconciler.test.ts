/**
 * Integration tests for DefaultReconciler with real SQLite stores.
 *
 * Tests reconciliation, startup sweep, and concurrent reconciliation
 * against real databases (not mocks).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReconcilerTests } from "../core/reconciler.conformance.js";
import { DefaultReconciler } from "../core/reconciler.js";
import { ExpiryReason } from "../core/store.js";
import { makeClaim } from "../core/test-helpers.js";
import { createSqliteStores } from "./sqlite-store.js";

// ---------------------------------------------------------------------------
// Run conformance suite with SQLite stores
// ---------------------------------------------------------------------------

runReconcilerTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "reconciler-conformance-"));
  const dbPath = join(dir, "test.db");
  const { claimStore, close } = createSqliteStores(dbPath);
  const reconciler = new DefaultReconciler(claimStore);

  return {
    claimStore,
    reconciler,
    cleanup: async () => {
      close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// Integration tests — stall detection with configured threshold
// ---------------------------------------------------------------------------

describe("DefaultReconciler integration", () => {
  let dir: string;
  let closeFn: () => void;
  let claimStore: ReturnType<typeof createSqliteStores>["claimStore"];
  let reconciler: DefaultReconciler;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reconciler-integration-"));
    const dbPath = join(dir, "test.db");
    const stores = createSqliteStores(dbPath);
    claimStore = stores.claimStore;
    closeFn = stores.close;
    reconciler = new DefaultReconciler(claimStore, undefined, {
      stallThresholdMs: 60_000, // 60 second stall threshold
      retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
  });

  afterEach(async () => {
    closeFn();
    await rm(dir, { recursive: true, force: true });
  });

  test("reconcile with stall detection expires stalled agents", async () => {
    // Agent has valid lease but stale heartbeat
    const stalled = makeClaim({
      claimId: "stalled-1",
      targetRef: "stall-target-1",
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), // still valid
    });
    await claimStore.createClaim(stalled);

    const result = await reconciler.reconcile();
    expect(result.expiredClaims.length).toBe(1);
    expect(result.expiredClaims[0]?.reason).toBe(ExpiryReason.Stalled);

    const claim = await claimStore.getClaim("stalled-1");
    expect(claim?.status).toBe("expired");
  });

  test("reconcile combines lease expiry and stall detection", async () => {
    // One claim expired by lease
    const leaseExpired = makeClaim({
      claimId: "lease-exp",
      targetRef: "combined-1",
      leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
    });
    // One claim stalled
    const stalled = makeClaim({
      claimId: "stalled-combined",
      targetRef: "combined-2",
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    // One claim healthy
    const healthy = makeClaim({
      claimId: "healthy",
      targetRef: "combined-3",
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    await claimStore.createClaim(leaseExpired);
    await claimStore.createClaim(stalled);
    await claimStore.createClaim(healthy);

    const result = await reconciler.reconcile();
    expect(result.expiredClaims.length).toBe(2);

    const reasons = result.expiredClaims.map((e) => e.reason).sort();
    expect(reasons).toContain(ExpiryReason.LeaseExpired);
    expect(reasons).toContain(ExpiryReason.Stalled);

    // Healthy claim untouched
    const h = await claimStore.getClaim("healthy");
    expect(h?.status).toBe("active");
  });

  test("startup reconcile uses only lease expiry (no stall detection)", async () => {
    // Stall detection is configured but startup should not use it
    const stalled = makeClaim({
      claimId: "startup-stalled",
      targetRef: "startup-target",
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    await claimStore.createClaim(stalled);

    const result = await reconciler.startupReconcile();
    // Should NOT expire the stalled claim (startup only uses lease expiry)
    expect(result.expiredClaims.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent reconciliation test
// ---------------------------------------------------------------------------

describe("DefaultReconciler concurrency", () => {
  test("concurrent reconcile calls do not double-expire claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reconciler-concurrent-"));
    const dbPath = join(dir, "test.db");
    const stores = createSqliteStores(dbPath);

    // Create expired claims
    for (let i = 0; i < 5; i++) {
      await stores.claimStore.createClaim(
        makeClaim({
          claimId: `concurrent-${i}`,
          targetRef: `concurrent-target-${i}`,
          leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
        }),
      );
    }

    const reconciler1 = new DefaultReconciler(stores.claimStore);
    const reconciler2 = new DefaultReconciler(stores.claimStore);

    // Run two reconcile calls concurrently
    const [result1, result2] = await Promise.all([
      reconciler1.reconcile(),
      reconciler2.reconcile(),
    ]);

    // Combined, exactly 5 claims should be expired (no duplicates)
    const allExpiredIds = [
      ...result1.expiredClaims.map((e) => e.claim.claimId),
      ...result2.expiredClaims.map((e) => e.claim.claimId),
    ];
    const uniqueIds = new Set(allExpiredIds);
    expect(uniqueIds.size).toBe(5);

    // All claims should be expired in the store
    for (let i = 0; i < 5; i++) {
      const claim = await stores.claimStore.getClaim(`concurrent-${i}`);
      expect(claim?.status).toBe("expired");
    }

    stores.close();
    await rm(dir, { recursive: true, force: true });
  });
});
