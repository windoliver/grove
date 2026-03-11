/**
 * Schema migration smoke tests for SQLite store.
 *
 * Validates that:
 * - Fresh DB creates schema v1
 * - Re-opening existing DB doesn't corrupt data
 * - Schema migrations table is correctly populated
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toManifest } from "../core/manifest.js";
import { makeClaim, makeContribution } from "../core/test-helpers.js";
import { initSqliteDb, SqliteStore } from "./sqlite-store.js";

describe("schema migration", () => {
  test("fresh DB creates schema_migrations with current version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      const store = new SqliteStore(dbPath);
      store.close();

      // Inspect the DB directly
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
        .get() as { version: number } | null;
      db.close();

      expect(row).toBeDefined();
      expect(row?.version).toBe(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fresh DB creates all expected tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      const store = new SqliteStore(dbPath);
      store.close();

      const db = new Database(dbPath, { readonly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as readonly { name: string }[];
      db.close();

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("contributions");
      expect(tableNames).toContain("contribution_tags");
      expect(tableNames).toContain("artifacts");
      expect(tableNames).toContain("relations");
      expect(tableNames).toContain("claims");
      expect(tableNames).toContain("schema_migrations");
      expect(tableNames).toContain("contributions_fts");
      expect(tableNames).toContain("workspaces");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-opening existing DB does not corrupt contributions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // First open: create and write data
      const store1 = new SqliteStore(dbPath);
      const c = makeContribution({ summary: "survives reopen" });
      await store1.put(c);
      store1.close();

      // Second open: data should be intact
      const store2 = new SqliteStore(dbPath);
      const retrieved = await store2.get(c.cid);
      expect(retrieved).toBeDefined();
      expect(retrieved?.summary).toBe("survives reopen");
      expect(retrieved?.cid).toBe(c.cid);

      // Count should be 1 (not duplicated)
      const count = await store2.count();
      expect(count).toBe(1);
      store2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-opening existing DB does not corrupt claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // First open: create claim
      const store1 = new SqliteStore(dbPath);
      const claim = makeClaim({ claimId: "reopen-claim" });
      await store1.createClaim(claim);
      store1.close();

      // Second open: claim should be intact
      const store2 = new SqliteStore(dbPath);
      const retrieved = await store2.getClaim("reopen-claim");
      expect(retrieved).toBeDefined();
      expect(retrieved?.status).toBe("active");
      expect(retrieved?.targetRef).toBe("target-1");
      store2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-opening preserves FTS index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // First open: write searchable data
      const store1 = new SqliteStore(dbPath);
      const c = makeContribution({ summary: "searchable quantum computing" });
      await store1.put(c);
      store1.close();

      // Second open: search should still work
      const store2 = new SqliteStore(dbPath);
      const results = await store2.search("quantum");
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(c.cid);
      store2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-opening preserves tag junction table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // First open: write tagged data
      const store1 = new SqliteStore(dbPath);
      const c = makeContribution({ summary: "tagged data", tags: ["alpha", "beta"] });
      await store1.put(c);
      store1.close();

      // Second open: tag filtering should still work
      const store2 = new SqliteStore(dbPath);
      const results = await store2.list({ tags: ["alpha", "beta"] });
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(c.cid);
      store2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("schema_migrations version is not duplicated on reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // Open twice
      const store1 = new SqliteStore(dbPath);
      store1.close();
      const store2 = new SqliteStore(dbPath);
      store2.close();

      // Check only one migration row
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare("SELECT * FROM schema_migrations").all() as readonly {
        version: number;
      }[];
      db.close();

      expect(rows.length).toBe(1);
      expect(rows[0]?.version).toBe(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("initSqliteDb returns a functional Database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      const db = initSqliteDb(dbPath);

      // Should be able to query schema
      const row = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
        .get() as {
        version: number;
      } | null;
      expect(row?.version).toBe(6);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("backfill populates contribution_tags for pre-existing contributions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // Simulate a pre-existing DB: create schema, insert contribution directly
      // with tags in tags_json but NO rows in contribution_tags.
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA foreign_keys = ON");

      // Create only the contributions table (simulating old schema without junction tables)
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contributions (
          cid TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL,
          summary TEXT NOT NULL, description TEXT, agent_id TEXT NOT NULL,
          agent_name TEXT, created_at TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]', manifest_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relations (
          source_cid TEXT NOT NULL, target_cid TEXT NOT NULL,
          relation_type TEXT NOT NULL, metadata_json TEXT,
          FOREIGN KEY (source_cid) REFERENCES contributions(cid)
        );
        CREATE TABLE IF NOT EXISTS claims (
          claim_id TEXT PRIMARY KEY, target_ref TEXT NOT NULL,
          agent_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
          heartbeat_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
          intent_summary TEXT NOT NULL, agent_json TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS contributions_fts USING fts5(cid, summary, description);
        INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00Z');
      `);

      // Insert a contribution with tags directly (bypassing the store's putSync)
      const c = makeContribution({ summary: "legacy-tagged", tags: ["x-ray", "yankee"] });
      const manifestJson = JSON.stringify(toManifest(c));
      const tagsJson = JSON.stringify(c.tags);
      db.run(
        `INSERT INTO contributions (cid, kind, mode, summary, description,
         agent_id, agent_name, created_at, tags_json, manifest_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.cid,
          c.kind,
          c.mode,
          c.summary,
          c.description ?? null,
          c.agent.agentId,
          c.agent.agentName ?? null,
          c.createdAt,
          tagsJson,
          manifestJson,
        ],
      );
      db.run("INSERT INTO contributions_fts (cid, summary, description) VALUES (?, ?, ?)", [
        c.cid,
        c.summary,
        c.description ?? "",
      ]);
      db.close();

      // Now open with initSqliteDb — backfill should populate contribution_tags
      const store = new SqliteStore(dbPath);
      const results = await store.list({ tags: ["x-ray"] });
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(c.cid);

      // Both tags should be backfilled
      const results2 = await store.list({ tags: ["x-ray", "yankee"] });
      expect(results2.length).toBe(1);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("backfill populates artifacts for pre-existing contributions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // Create a DB with a contribution that has artifacts in manifest_json
      // but no rows in the artifacts junction table.
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA foreign_keys = ON");

      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contributions (
          cid TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL,
          summary TEXT NOT NULL, description TEXT, agent_id TEXT NOT NULL,
          agent_name TEXT, created_at TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]', manifest_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relations (
          source_cid TEXT NOT NULL, target_cid TEXT NOT NULL,
          relation_type TEXT NOT NULL, metadata_json TEXT,
          FOREIGN KEY (source_cid) REFERENCES contributions(cid)
        );
        CREATE TABLE IF NOT EXISTS claims (
          claim_id TEXT PRIMARY KEY, target_ref TEXT NOT NULL,
          agent_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
          heartbeat_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
          intent_summary TEXT NOT NULL, agent_json TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS contributions_fts USING fts5(cid, summary, description);
        INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00Z');
      `);

      const c = makeContribution({
        summary: "legacy-artifact",
        artifacts: { "model.bin": "abc123hash", "config.json": "def456hash" },
      });
      const manifestJson = JSON.stringify(toManifest(c));
      db.run(
        `INSERT INTO contributions (cid, kind, mode, summary, description,
         agent_id, agent_name, created_at, tags_json, manifest_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.cid,
          c.kind,
          c.mode,
          c.summary,
          c.description ?? null,
          c.agent.agentId,
          c.agent.agentName ?? null,
          c.createdAt,
          JSON.stringify(c.tags),
          manifestJson,
        ],
      );
      db.close();

      // Open with initSqliteDb — backfill should populate artifacts table
      const db2 = initSqliteDb(dbPath);
      const rows = db2
        .prepare(
          "SELECT name, content_hash FROM artifacts WHERE contribution_cid = ? ORDER BY name",
        )
        .all(c.cid) as readonly { name: string; content_hash: string }[];
      db2.close();

      expect(rows.length).toBe(2);
      expect(rows[0]?.name).toBe("config.json");
      expect(rows[0]?.content_hash).toBe("def456hash");
      expect(rows[1]?.name).toBe("model.bin");
      expect(rows[1]?.content_hash).toBe("abc123hash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("backfill does not duplicate tags on re-open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // First open: write tagged contribution (junction rows created by putSync)
      const store1 = new SqliteStore(dbPath);
      const c = makeContribution({ summary: "no-dup", tags: ["alpha", "beta"] });
      await store1.put(c);
      store1.close();

      // Second open: backfill runs again but should not duplicate
      const store2 = new SqliteStore(dbPath);
      const results = await store2.list({ tags: ["alpha"] });
      expect(results.length).toBe(1);

      // Verify exact row count in junction table
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM contribution_tags WHERE cid = ?")
        .get(c.cid) as {
        cnt: number;
      };
      db.close();
      expect(row.cnt).toBe(2); // exactly 2 tags, not 4
      store2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
