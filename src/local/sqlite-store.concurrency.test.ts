/**
 * Concurrency tests for SQLite store.
 *
 * Validates that concurrent access to the same database file works correctly:
 * - Idempotent puts from multiple stores
 * - Claim exclusivity under contention
 * - Expiry atomicity
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim } from "../core/models.js";
import { ClaimStatus } from "../core/models.js";
import { makeContribution } from "../core/test-helpers.js";
import { createSqliteStores } from "./sqlite-store.js";

async function withTwoStores<T>(
  fn: (ctx: {
    contrib1: ReturnType<typeof createSqliteStores>["contributionStore"];
    contrib2: ReturnType<typeof createSqliteStores>["contributionStore"];
    claim1: ReturnType<typeof createSqliteStores>["claimStore"];
    claim2: ReturnType<typeof createSqliteStores>["claimStore"];
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-concurrency-"));
  const dbPath = join(dir, "test.db");
  const stores1 = createSqliteStores(dbPath);
  const stores2 = createSqliteStores(dbPath);
  try {
    return await fn({
      contrib1: stores1.contributionStore,
      contrib2: stores2.contributionStore,
      claim1: stores1.claimStore,
      claim2: stores2.claimStore,
    });
  } finally {
    stores1.close();
    stores2.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function makeClaim(overrides?: Partial<Claim>): Claim {
  const now = new Date().toISOString();
  const leaseExpires = new Date(Date.now() + 300_000).toISOString();
  return {
    claimId: "claim-1",
    targetRef: "target-1",
    agent: { agentId: "test-agent" },
    status: ClaimStatus.Active,
    intentSummary: "Test claim",
    createdAt: now,
    heartbeatAt: now,
    leaseExpiresAt: leaseExpires,
    ...overrides,
  };
}

describe("concurrent contribution puts", () => {
  test("two stores putting the same contribution is idempotent", async () => {
    await withTwoStores(async ({ contrib1, contrib2 }) => {
      const c = makeContribution({ summary: "concurrent-put" });

      // Both stores put the same contribution concurrently
      await Promise.all([contrib1.put(c), contrib2.put(c)]);

      // Should exist exactly once
      const result = await contrib1.get(c.cid);
      expect(result).toBeDefined();
      expect(result?.summary).toBe("concurrent-put");

      const count = await contrib1.count();
      expect(count).toBe(1);
    });
  });

  test("concurrent putMany with overlapping contributions", async () => {
    await withTwoStores(async ({ contrib1, contrib2 }) => {
      const shared = makeContribution({ summary: "shared" });
      const only1 = makeContribution({ summary: "only-store-1" });
      const only2 = makeContribution({ summary: "only-store-2" });

      await Promise.all([contrib1.putMany([shared, only1]), contrib2.putMany([shared, only2])]);

      const count = await contrib1.count();
      expect(count).toBe(3);

      // All three should be readable from either store
      expect(await contrib2.get(only1.cid)).toBeDefined();
      expect(await contrib1.get(only2.cid)).toBeDefined();
    });
  });

  test("many concurrent puts of distinct contributions", async () => {
    await withTwoStores(async ({ contrib1, contrib2 }) => {
      const contributions = Array.from({ length: 20 }, (_, i) =>
        makeContribution({
          summary: `concurrent-${i}`,
          createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      );

      // Split contributions across two stores, put concurrently
      const batch1 = contributions.filter((_, i) => i % 2 === 0);
      const batch2 = contributions.filter((_, i) => i % 2 === 1);

      await Promise.all([contrib1.putMany(batch1), contrib2.putMany(batch2)]);

      const count = await contrib1.count();
      expect(count).toBe(20);
    });
  });
});

describe("concurrent claim operations", () => {
  test("only one store can claim a target", async () => {
    await withTwoStores(async ({ claim1, claim2 }) => {
      const c1 = makeClaim({ claimId: "claim-a", targetRef: "contested-target" });
      const c2 = makeClaim({ claimId: "claim-b", targetRef: "contested-target" });

      // Race: both try to claim the same target
      const results = await Promise.allSettled([claim1.createClaim(c1), claim2.createClaim(c2)]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly one should succeed, one should fail
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });
  });

  test("claim becomes available after release from another store", async () => {
    await withTwoStores(async ({ claim1, claim2 }) => {
      const c = makeClaim({ claimId: "release-test", targetRef: "shared" });
      await claim1.createClaim(c);
      await claim1.release("release-test");

      // Second store should now be able to claim the same target
      const c2 = makeClaim({ claimId: "after-release", targetRef: "shared" });
      const result = await claim2.createClaim(c2);
      expect(result.claimId).toBe("after-release");
    });
  });

  test("expireStale is atomic across stores", async () => {
    await withTwoStores(async ({ claim1, claim2 }) => {
      // Create claims with already-expired leases on different targets
      const expired1 = makeClaim({
        claimId: "exp-1",
        targetRef: "target-exp-1",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      const expired2 = makeClaim({
        claimId: "exp-2",
        targetRef: "target-exp-2",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await claim1.createClaim(expired1);
      await claim1.createClaim(expired2);

      // Both stores try to expire simultaneously
      const [result1, result2] = await Promise.all([claim1.expireStale(), claim2.expireStale()]);

      // Combined, exactly 2 claims should be reported expired (no duplicates)
      const allExpiredIds = [...result1.map((c) => c.claimId), ...result2.map((c) => c.claimId)];
      const uniqueIds = new Set(allExpiredIds);
      expect(uniqueIds.size).toBe(2);

      // Both claims should now be expired
      const c1 = await claim1.getClaim("exp-1");
      const c2 = await claim1.getClaim("exp-2");
      expect(c1?.status).toBe("expired");
      expect(c2?.status).toBe("expired");
    });
  });
});

describe("split-store close() safety", () => {
  test("closing contribution store does not break claim store", async () => {
    await withTwoStores(async ({ contrib1, claim1 }) => {
      // close() on split stores is a no-op — it should not close the shared DB
      contrib1.close();

      // Claim store should still work after contribution store is "closed"
      const claim = makeClaim({ claimId: "after-close", targetRef: "safe" });
      const result = await claim1.createClaim(claim);
      expect(result.claimId).toBe("after-close");
    });
  });

  test("closing claim store does not break contribution store", async () => {
    await withTwoStores(async ({ contrib1, claim1 }) => {
      claim1.close();

      // Contribution store should still work
      const c = makeContribution({ summary: "after-claim-close" });
      await contrib1.put(c);
      const retrieved = await contrib1.get(c.cid);
      expect(retrieved?.summary).toBe("after-claim-close");
    });
  });
});
