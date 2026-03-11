/**
 * Tests for SqliteOutcomeStore — runs the OutcomeStore conformance suite
 * against a real SQLite database.
 */

import { Database } from "bun:sqlite";
import { runOutcomeStoreTests } from "../core/outcome.conformance.js";
import { SqliteOutcomeStore } from "./sqlite-outcome-store.js";

runOutcomeStoreTests(async () => {
  const db = new Database(":memory:");
  db.run("PRAGMA busy_timeout = 5000");
  const store = new SqliteOutcomeStore(db);

  return {
    store,
    cleanup: async () => {
      db.close();
    },
  };
});
