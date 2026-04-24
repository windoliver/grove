/**
 * Tests for SqliteOutcomeStore — runs the OutcomeStore conformance suite
 * against a real SQLite database.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runOutcomeStoreTests } from "../core/outcome.conformance.js";
import { SqliteOutcomeStore } from "./sqlite-outcome-store.js";

function sqliteBindLimit(db: Database): number {
  const rows = db.prepare("PRAGMA compile_options").all() as readonly {
    compile_options: string;
  }[];
  const option = rows.find((row) => row.compile_options.startsWith("MAX_VARIABLE_NUMBER="));
  return option ? Number(option.compile_options.slice("MAX_VARIABLE_NUMBER=".length)) : 999;
}

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

describe("SqliteOutcomeStore", () => {
  test("list supports offset without an explicit limit", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA busy_timeout = 5000");
    const store = new SqliteOutcomeStore(db);

    try {
      await store.set("cid-1", { status: "accepted", evaluatedBy: "alice" });
      await store.set("cid-2", { status: "rejected", evaluatedBy: "alice" });
      await store.set("cid-3", { status: "crashed", evaluatedBy: "bob" });

      const listed = await store.list({ offset: 1 });
      expect(listed).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("getBatch chunks requests larger than SQLite's bind limit", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA busy_timeout = 5000");
    const store = new SqliteOutcomeStore(db);

    try {
      const bindLimit = sqliteBindLimit(db);
      await store.set("cid-1", { status: "accepted", evaluatedBy: "alice" });
      await store.set("cid-2", { status: "rejected", evaluatedBy: "alice" });
      await store.set("cid-3", { status: "crashed", evaluatedBy: "bob" });

      const cids = Array.from({ length: bindLimit + 1 }, (_, index) =>
        index < 3 ? `cid-${index + 1}` : `missing-${index}`,
      );
      const batch = await store.getBatch(cids);

      expect(batch.size).toBe(3);
      expect(batch.get("cid-1")?.status).toBe("accepted");
      expect(batch.get("cid-2")?.status).toBe("rejected");
      expect(batch.get("cid-3")?.status).toBe("crashed");
    } finally {
      db.close();
    }
  });
});
