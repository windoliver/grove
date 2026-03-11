/**
 * Tests for SqliteBountyStore.
 *
 * Runs the conformance suite against the SQLite implementation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runBountyStoreTests } from "../core/bounty-store.conformance.js";
import { initSqliteDb } from "./sqlite-store.js";
import { SqliteBountyStore } from "./sqlite-bounty-store.js";

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
