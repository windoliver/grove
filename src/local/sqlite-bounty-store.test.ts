/**
 * Tests for SqliteBountyStore.
 *
 * Runs the conformance suite against the SQLite implementation.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBountyStoreTests } from "../core/bounty-store.conformance.js";
import { makeBounty, makeReward } from "../core/test-helpers.js";
import { SqliteBountyStore } from "./sqlite-bounty-store.js";
import { initSqliteDb } from "./sqlite-store.js";

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

runBountyStoreTests(async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-bounty-test-"));
  const dbPath = join(dir, "test.db");
  const db = initSqliteDb(dbPath);
  const store = new SqliteBountyStore(db);

  return {
    store,
    cleanup: async () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe("SqliteBountyStore query hardening", () => {
  test("rejects non-integer pagination values before building SQL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-bounty-hardening-"));
    const db = initSqliteDb(join(dir, "test.db"));
    const store = new SqliteBountyStore(db);
    try {
      await store.createBounty(makeBounty({ bountyId: "b-1" }));

      await expect(store.listBounties({ limit: "1 --" as unknown as number })).rejects.toThrow(
        /limit must be a non-negative integer/,
      );
      expect(await store.countBounties()).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects non-integer reward limits before building SQL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-reward-hardening-"));
    const db = initSqliteDb(join(dir, "test.db"));
    const store = new SqliteBountyStore(db);
    try {
      store.recordReward(makeReward({ rewardId: "r-1" }));

      await expect(store.listRewards({ limit: "1 --" as unknown as number })).rejects.toThrow(
        /limit must be a non-negative integer/,
      );
      expect(await store.listRewards()).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
