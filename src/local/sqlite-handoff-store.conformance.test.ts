/**
 * Run HandoffStore conformance suite against SqliteHandoffStore.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandoffStoreTests } from "../core/handoff-store.conformance.js";
import { SqliteHandoffStore } from "./sqlite-handoff-store.js";
import { initSqliteDb } from "./sqlite-store.js";

runHandoffStoreTests(async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "grove-handoff-test-"));
  const dbPath = join(tempDir, "test.db");
  const db = initSqliteDb(dbPath);
  const store = new SqliteHandoffStore(db);
  return {
    store,
    cleanup: async () => {
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
});
