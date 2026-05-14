/**
 * Schema migration smoke tests for SQLite store.
 *
 * Validates that:
 * - Fresh DB records the current schema version
 * - Re-opening existing DB doesn't corrupt data
 * - Schema migrations table is correctly populated
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toManifest } from "../core/manifest.js";
import { RelationType } from "../core/models.js";
import { makeClaim, makeContribution } from "../core/test-helpers.js";
import { CURRENT_SCHEMA_VERSION, initSqliteDb, SqliteStore } from "./sqlite-store.js";

const MODEL_HASH = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONFIG_HASH = "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ARTIFACT_A_HASH = "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const ARTIFACT_B_HASH = "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

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
      expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);
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
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .all() as readonly { name: string }[];
      db.close();

      const tableNames = tables.map((t) => t.name);
      const indexNames = indexes.map((i) => i.name);
      expect(tableNames).toContain("contributions");
      expect(tableNames).toContain("contribution_tags");
      expect(tableNames).toContain("artifacts");
      expect(tableNames).toContain("relations");
      expect(tableNames).toContain("claims");
      expect(tableNames).toContain("schema_migrations");
      expect(tableNames).toContain("contributions_fts");
      expect(tableNames).toContain("session_deletion_audits");
      expect(tableNames).toContain("workspaces");
      expect(indexNames).toContain("idx_sessions_deletion_timestamp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fresh DB creates split claim tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-claim-split-"));
    try {
      const dbPath = join(dir, "test.db");
      const store = new SqliteStore(dbPath);
      store.close();

      const db = new Database(dbPath);
      const tableNames = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as readonly {
          name: string;
        }[]
      ).map((r) => r.name);
      const indexNames = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as readonly {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(tableNames).toContain("claim_spec");
      expect(tableNames).toContain("claim_status");
      expect(indexNames).toContain("idx_claim_spec_target");
      expect(indexNames).toContain("idx_claim_spec_agent");
      expect(indexNames).toContain("idx_claim_status_phase");
      expect(indexNames).toContain("idx_claim_status_phase_lease");
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("legacy claims rows backfill into claim_spec and claim_status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-claim-split-legacy-"));
    try {
      const dbPath = join(dir, "test.db");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contributions (
          cid TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          mode TEXT NOT NULL,
          summary TEXT NOT NULL,
          description TEXT,
          agent_id TEXT NOT NULL,
          agent_name TEXT,
          created_at TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          manifest_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relations (
          source_cid TEXT NOT NULL,
          target_cid TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          metadata_json TEXT
        );
        CREATE TABLE IF NOT EXISTS claims (
          claim_id TEXT PRIMARY KEY,
          target_ref TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          intent_summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          context_json TEXT,
          agent_json TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1
        );
      `);
      db.prepare(
        `INSERT INTO claims (
          claim_id, target_ref, agent_id, status, intent_summary, created_at,
          heartbeat_at, lease_expires_at, context_json, agent_json, attempt_count, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy-split",
        "target-legacy",
        "agent-legacy",
        "active",
        "legacy intent",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:02:00.000Z",
        "2026-01-01T00:07:00.000Z",
        JSON.stringify({ migrated: true }),
        JSON.stringify({ agentId: "agent-legacy", platform: "codex", role: "coder" }),
        2,
        5,
      );
      db.close();

      const contextJson = JSON.stringify({ migrated: true });
      const agentJson = JSON.stringify({
        agentId: "agent-legacy",
        platform: "codex",
        role: "coder",
      });

      const store = new SqliteStore(dbPath);
      const claim = await store.getClaim("legacy-split");
      const migratedDb = new Database(dbPath, { readonly: true });
      const spec = migratedDb
        .prepare(
          `SELECT role_name, platform, assignee_json, lease_deadline_sec, generation,
            target_ref, agent_id, agent_json, intent_summary, context_json, created_at
           FROM claim_spec WHERE id = ?`,
        )
        .get("legacy-split") as {
        role_name: string;
        platform: string;
        assignee_json: string;
        lease_deadline_sec: number;
        generation: number;
        target_ref: string;
        agent_id: string;
        agent_json: string;
        intent_summary: string;
        context_json: string;
        created_at: string;
      };
      const status = migratedDb
        .prepare(
          `SELECT phase, observed_generation, last_heartbeat_at, lease_expires_at,
            conditions_json, last_transition_at, attempt_count, revision
           FROM claim_status WHERE id = ?`,
        )
        .get("legacy-split") as {
        phase: string;
        observed_generation: number;
        last_heartbeat_at: string;
        lease_expires_at: string;
        conditions_json: string;
        last_transition_at: string;
        attempt_count: number;
        revision: number;
      };
      migratedDb.close();
      const specAssignee = JSON.parse(spec.assignee_json) as {
        agentId: string;
        platform: string;
        role: string;
      };
      const specAgent = JSON.parse(spec.agent_json) as {
        agentId: string;
        platform: string;
        role: string;
      };
      const specContext = JSON.parse(spec.context_json) as { migrated: boolean };
      const statusConditions = JSON.parse(status.conditions_json) as readonly unknown[];

      expect(claim?.claimId).toBe("legacy-split");
      expect(claim?.status).toBe("active");
      expect(claim?.attemptCount).toBe(2);
      expect(claim?.revision).toBe(5);
      expect(spec.role_name).toBe("coder");
      expect(spec.platform).toBe("codex");
      expect(specAssignee).toEqual({ agentId: "agent-legacy", platform: "codex", role: "coder" });
      expect(spec.lease_deadline_sec).toBe(420);
      expect(spec.generation).toBe(5);
      expect(spec.target_ref).toBe("target-legacy");
      expect(spec.agent_id).toBe("agent-legacy");
      expect(spec.agent_json).toBe(agentJson);
      expect(specAgent).toEqual({ agentId: "agent-legacy", platform: "codex", role: "coder" });
      expect(spec.intent_summary).toBe("legacy intent");
      expect(spec.context_json).toBe(contextJson);
      expect(specContext).toEqual({ migrated: true });
      expect(spec.created_at).toBe("2026-01-01T00:00:00.000Z");
      expect(status.phase).toBe("active");
      expect(status.observed_generation).toBe(5);
      expect(status.last_heartbeat_at).toBe("2026-01-01T00:02:00.000Z");
      expect(status.lease_expires_at).toBe("2026-01-01T00:07:00.000Z");
      expect(status.conditions_json).toBe("[]");
      expect(statusConditions).toEqual([]);
      expect(status.last_transition_at).toBe("2026-01-01T00:02:00.000Z");
      expect(status.attempt_count).toBe(2);
      expect(status.revision).toBe(5);

      const view = await store.claims.getClaimView("legacy-split");
      expect(view?.spec.targetRef).toBe("target-legacy");
      expect(view?.spec.agent.platform).toBe("codex");
      expect(view?.spec.generation).toBe(5);
      expect(view?.status.phase).toBe("active");
      expect(view?.status.observedGeneration).toBe(5);
      expect(view?.status.lastHeartbeatAt).toBe("2026-01-01T00:02:00.000Z");

      store.close();
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
      expect(rows[0]?.version).toBe(CURRENT_SCHEMA_VERSION);
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
      expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);

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
        artifacts: { "model.bin": MODEL_HASH, "config.json": CONFIG_HASH },
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
      expect(rows[0]?.content_hash).toBe(CONFIG_HASH);
      expect(rows[1]?.name).toBe("model.bin");
      expect(rows[1]?.content_hash).toBe(MODEL_HASH);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("backfill repairs partially populated junction tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
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
        CREATE TABLE IF NOT EXISTS contribution_tags (
          cid TEXT NOT NULL,
          tag TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          contribution_cid TEXT NOT NULL,
          name TEXT NOT NULL,
          content_hash TEXT NOT NULL
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

      const contribution = makeContribution({
        summary: "partial-backfill",
        tags: ["alpha", "beta"],
        artifacts: {
          "a.txt": ARTIFACT_A_HASH,
          "b.txt": ARTIFACT_B_HASH,
        },
      });
      const manifestJson = JSON.stringify(toManifest(contribution));
      db.run(
        `INSERT INTO contributions (cid, kind, mode, summary, description,
         agent_id, agent_name, created_at, tags_json, manifest_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contribution.cid,
          contribution.kind,
          contribution.mode,
          contribution.summary,
          contribution.description ?? null,
          contribution.agent.agentId,
          contribution.agent.agentName ?? null,
          contribution.createdAt,
          JSON.stringify(contribution.tags),
          manifestJson,
        ],
      );
      db.run("INSERT INTO contribution_tags (cid, tag) VALUES (?, ?)", [contribution.cid, "alpha"]);
      db.run("INSERT INTO artifacts (contribution_cid, name, content_hash) VALUES (?, ?, ?)", [
        contribution.cid,
        "a.txt",
        ARTIFACT_A_HASH,
      ]);
      db.close();

      const db2 = initSqliteDb(dbPath);
      const tags = db2
        .prepare("SELECT tag FROM contribution_tags WHERE cid = ? ORDER BY tag")
        .all(contribution.cid) as readonly { tag: string }[];
      const artifacts = db2
        .prepare(
          "SELECT name, content_hash FROM artifacts WHERE contribution_cid = ? ORDER BY name",
        )
        .all(contribution.cid) as readonly { name: string; content_hash: string }[];
      db2.close();

      expect(tags.map((row) => row.tag)).toEqual(["alpha", "beta"]);
      expect(artifacts).toEqual([
        { name: "a.txt", content_hash: ARTIFACT_A_HASH },
        { name: "b.txt", content_hash: ARTIFACT_B_HASH },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("legacy DB with no schema_migrations rows gets claims columns added", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // Simulate a pre-schema-tracking legacy DB: tables exist but
      // schema_migrations has no rows (predates version tracking).
      // SCHEMA_DDL's CREATE TABLE IF NOT EXISTS will be a no-op for
      // the existing claims table, so column-adding migrations must
      // still run even when currentVersion is null.
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
        -- Old-style claims table: missing created_at, context_json, attempt_count
        CREATE TABLE IF NOT EXISTS claims (
          claim_id TEXT PRIMARY KEY, target_ref TEXT NOT NULL,
          agent_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
          heartbeat_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
          intent_summary TEXT NOT NULL, agent_json TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS contributions_fts USING fts5(cid, summary, description);
        -- NOTE: no rows inserted into schema_migrations (simulates pre-tracking DB)
      `);

      // Insert a legacy claim
      db.run(
        `INSERT INTO claims (claim_id, target_ref, agent_id, status,
         heartbeat_at, lease_expires_at, intent_summary, agent_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "legacy-claim",
          "some-target",
          "agent-1",
          "active",
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          "legacy work",
          JSON.stringify({ agentId: "agent-1" }),
        ],
      );
      db.close();

      // Open with initSqliteDb — should add missing columns
      const db2 = initSqliteDb(dbPath);

      // Verify the columns were added
      const cols = db2.prepare("PRAGMA table_info(claims)").all() as readonly {
        name: string;
      }[];
      const colNames = new Set(cols.map((c) => c.name));
      expect(colNames.has("created_at")).toBe(true);
      expect(colNames.has("context_json")).toBe(true);
      expect(colNames.has("attempt_count")).toBe(true);

      // Verify the legacy claim's created_at was backfilled from heartbeat_at
      const claim = db2
        .prepare("SELECT created_at, heartbeat_at FROM claims WHERE claim_id = ?")
        .get("legacy-claim") as { created_at: string; heartbeat_at: string };
      expect(claim.created_at).toBe(claim.heartbeat_at);

      // Verify schema version was recorded
      const version = (
        db2.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as {
          v: number | null;
        }
      ).v;
      expect(version).toBe(CURRENT_SCHEMA_VERSION);

      db2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("v14 migration backfills session contribution owner refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA foreign_keys = ON");
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          goal TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active',
          started_at TEXT NOT NULL,
          archived_at INTEGER,
          contribution_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS session_contributions (
          session_id TEXT NOT NULL,
          cid TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (session_id, cid)
        );
        INSERT OR IGNORE INTO schema_migrations (version, applied_at)
        VALUES (13, '2026-01-01T00:00:00Z');
      `);
      db.run(
        `INSERT INTO sessions (session_id, goal, config_json, status, started_at, contribution_count)
         VALUES (?, ?, '{}', 'active', ?, 1)`,
        ["legacy-session", "legacy goal", new Date().toISOString()],
      );
      db.run(
        `INSERT INTO session_contributions (session_id, cid, added_at)
         VALUES (?, ?, ?)`,
        ["legacy-session", "blake3:legacy", new Date().toISOString()],
      );
      db.close();

      const migrated = initSqliteDb(dbPath);
      const session = migrated
        .prepare("SELECT uid FROM sessions WHERE session_id = ?")
        .get("legacy-session") as { uid: string } | null;
      const link = migrated
        .prepare(
          "SELECT owner_ref_json FROM session_contributions WHERE session_id = ? AND cid = ?",
        )
        .get("legacy-session", "blake3:legacy") as { owner_ref_json: string | null } | null;

      expect(session?.uid).toBeTruthy();
      expect(link?.owner_ref_json).toBeTruthy();
      expect(JSON.parse(link?.owner_ref_json ?? "{}")).toEqual({
        kind: "session",
        id: "legacy-session",
        uid: session?.uid,
      });

      migrated.close();
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

  test("content-hash dedup rewires incoming relation indexes to canonical contribution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
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
        CREATE TABLE IF NOT EXISTS contribution_tags (
          cid TEXT NOT NULL,
          tag TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          contribution_cid TEXT NOT NULL,
          name TEXT NOT NULL,
          content_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relations (
          source_cid TEXT NOT NULL,
          target_cid TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          metadata_json TEXT,
          FOREIGN KEY (source_cid) REFERENCES contributions(cid)
        );
        CREATE TABLE IF NOT EXISTS claims (
          claim_id TEXT PRIMARY KEY, target_ref TEXT NOT NULL,
          agent_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
          heartbeat_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
          intent_summary TEXT NOT NULL, agent_json TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS contributions_fts USING fts5(cid, summary, description);
        INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (11, '2026-01-01T00:00:00Z');
      `);

      const canonical = makeContribution({
        summary: "dedup target",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const duplicate = makeContribution({
        summary: "dedup target",
        createdAt: "2026-01-01T00:01:00.000Z",
      });
      const child = makeContribution({
        summary: "child of duplicate",
        relations: [
          {
            targetCid: duplicate.cid,
            relationType: RelationType.RespondsTo,
          },
        ],
      });

      for (const contribution of [canonical, duplicate, child]) {
        db.run(
          `INSERT INTO contributions (cid, kind, mode, summary, description,
           agent_id, agent_name, created_at, tags_json, manifest_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            contribution.cid,
            contribution.kind,
            contribution.mode,
            contribution.summary,
            contribution.description ?? null,
            contribution.agent.agentId,
            contribution.agent.agentName ?? null,
            contribution.createdAt,
            JSON.stringify(contribution.tags),
            JSON.stringify(toManifest(contribution)),
          ],
        );
        db.run("INSERT INTO contributions_fts (cid, summary, description) VALUES (?, ?, ?)", [
          contribution.cid,
          contribution.summary,
          contribution.description ?? "",
        ]);
      }
      db.run(
        "INSERT INTO relations (source_cid, target_cid, relation_type, metadata_json) VALUES (?, ?, ?, ?)",
        [child.cid, duplicate.cid, RelationType.RespondsTo, null],
      );
      db.close();

      const store = new SqliteStore(dbPath);

      expect(await store.get(duplicate.cid)).toBeUndefined();
      expect(
        (await store.relatedTo(canonical.cid, RelationType.RespondsTo)).map((c) => c.cid),
      ).toEqual([child.cid]);
      expect(
        (await store.relationsOf(child.cid, RelationType.RespondsTo)).map((r) => r.targetCid),
      ).toEqual([canonical.cid]);

      const db2 = new Database(dbPath, { readonly: true });
      const dangling = db2
        .prepare("SELECT COUNT(*) as cnt FROM relations WHERE target_cid = ?")
        .get(duplicate.cid) as { cnt: number };
      db2.close();
      expect(dangling.cnt).toBe(0);

      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("v14 migration backfills missing session UIDs even when uid column already exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA foreign_keys = ON");
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          uid TEXT,
          goal TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active',
          started_at TEXT NOT NULL,
          archived_at INTEGER,
          contribution_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR REPLACE INTO schema_migrations (version, applied_at)
        VALUES (14, '2026-01-01T00:00:00Z');
      `);
      db.run(
        `INSERT INTO sessions (session_id, uid, goal, config_json, status, started_at)
         VALUES (?, ?, 'null uid', '{}', 'active', ?)`,
        ["legacy-null-uid", null, new Date().toISOString()],
      );
      db.run(
        `INSERT INTO sessions (session_id, uid, goal, config_json, status, started_at)
         VALUES (?, ?, 'empty uid', '{}', 'active', ?)`,
        ["legacy-empty-uid", "", new Date().toISOString()],
      );
      db.run(
        `INSERT INTO sessions (session_id, uid, goal, config_json, status, started_at)
         VALUES (?, ?, 'stable uid', '{}', 'active', ?)`,
        ["legacy-stable-uid", "stable-uid", new Date().toISOString()],
      );
      db.close();

      const migrated = initSqliteDb(dbPath);
      const rows = migrated
        .prepare("SELECT session_id, uid FROM sessions ORDER BY session_id")
        .all() as readonly { session_id: string; uid: string | null }[];

      expect(rows.find((row) => row.session_id === "legacy-null-uid")?.uid).toBeTruthy();
      expect(rows.find((row) => row.session_id === "legacy-empty-uid")?.uid).toBeTruthy();
      expect(rows.find((row) => row.session_id === "legacy-stable-uid")?.uid).toBe("stable-uid");
      expect(rows.find((row) => row.session_id === "legacy-null-uid")?.uid).not.toBe("stable-uid");
      expect(rows.find((row) => row.session_id === "legacy-empty-uid")?.uid).not.toBe("stable-uid");

      migrated.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("v16 migration backfills resource_version on every mutating-entity table", async () => {
    // C6 (#304) Task 1 safety net. Asserts both:
    //   1. Existing rows are lifted to a non-zero `resource_version` matching
    //      the init rule (generation for *_spec, revision for *_status,
    //      literal 1 for everything else).
    //   2. Post-migration INSERTs that do NOT mention `resource_version`
    //      still land with `resource_version >= 1` — the column DEFAULT
    //      must be 1, not 0. This is the regression check for the
    //      `DEFAULT 0` bug in the original T1 commit.
    const dir = await mkdtemp(join(tmpdir(), "sqlite-migration-"));
    const dbPath = join(dir, "test.db");
    try {
      // Build a v15-shaped legacy DB. Each table's DDL mirrors the
      // pre-v16 SCHEMA_DDL but omits `resource_version` so the
      // migration must add it.
      const db = new Database(dbPath);
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA foreign_keys = ON");
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
        );

        -- v15-shaped contributions (no resource_version)
        CREATE TABLE IF NOT EXISTS contributions (
          cid TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          mode TEXT NOT NULL,
          summary TEXT NOT NULL,
          description TEXT,
          agent_id TEXT NOT NULL,
          agent_name TEXT,
          created_at TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          content_hash TEXT NOT NULL,
          manifest_json TEXT NOT NULL
        );

        -- v15-shaped claim_spec / claim_status (no resource_version)
        CREATE TABLE IF NOT EXISTS claim_spec (
          id TEXT PRIMARY KEY,
          role_name TEXT,
          platform TEXT,
          blueprint TEXT,
          assignee_json TEXT,
          lease_deadline_sec INTEGER,
          priority INTEGER,
          max_iterations INTEGER,
          generation INTEGER NOT NULL DEFAULT 1,
          target_ref TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_json TEXT NOT NULL,
          intent_summary TEXT NOT NULL,
          context_json TEXT,
          owner_ref_json TEXT,
          finalizers_json TEXT NOT NULL DEFAULT '[]',
          deletion_timestamp TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS claim_status (
          id TEXT PRIMARY KEY,
          phase TEXT NOT NULL DEFAULT 'active',
          observed_generation INTEGER NOT NULL DEFAULT 0,
          agent_session_id TEXT,
          last_heartbeat_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          current_contribution_cid TEXT,
          conditions_json TEXT NOT NULL DEFAULT '[]',
          last_transition_at TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1
        );

        -- v15-shaped agent_task_spec / agent_task_status (no resource_version)
        CREATE TABLE IF NOT EXISTS agent_task_spec (
          id TEXT PRIMARY KEY,
          worktree TEXT NOT NULL,
          runtime TEXT NOT NULL,
          role TEXT NOT NULL,
          prompt TEXT NOT NULL,
          depends_on_json TEXT NOT NULL DEFAULT '[]',
          max_turns INTEGER,
          budget_json TEXT,
          generation INTEGER NOT NULL DEFAULT 1,
          owner_ref_json TEXT,
          finalizers_json TEXT NOT NULL DEFAULT '[]',
          deletion_timestamp TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_task_status (
          id TEXT PRIMARY KEY,
          phase TEXT NOT NULL DEFAULT 'Pending',
          session_id TEXT,
          contributions_json TEXT NOT NULL DEFAULT '[]',
          conditions_json TEXT NOT NULL DEFAULT '[]',
          observed_generation INTEGER NOT NULL DEFAULT 0,
          last_transition_at TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1
        );

        -- v15-shaped lazy tables (DDLs live in their own modules; they
        -- predate v16 so they also lack resource_version). These mirror
        -- the production DDLs from sqlite-handoff-store.ts,
        -- sqlite-goal-session-store.ts, sqlite-bounty-store.ts, and
        -- sqlite-outcome-store.ts.
        CREATE TABLE IF NOT EXISTS handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_cid TEXT NOT NULL,
          from_role TEXT NOT NULL,
          to_role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending_pickup',
          requires_reply INTEGER NOT NULL DEFAULT 0,
          reply_due_at TEXT,
          resolved_by_cid TEXT,
          seen_at TEXT,
          acked_at TEXT,
          session_id TEXT,
          ipc_message_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          uid TEXT NOT NULL,
          goal TEXT,
          preset_name TEXT,
          topology_json TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          worktree_strategy_json TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          started_at TEXT NOT NULL,
          finalizers_json TEXT NOT NULL DEFAULT '[]',
          deletion_timestamp TEXT,
          deletion_audit_json TEXT NOT NULL DEFAULT '[]',
          ended_at TEXT,
          stop_reason TEXT,
          stop_status TEXT,
          archived_at INTEGER,
          contribution_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS goals (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          goal TEXT NOT NULL,
          acceptance TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          set_at TEXT NOT NULL,
          set_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bounties (
          bounty_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          creator_agent_id TEXT NOT NULL,
          creator_json TEXT NOT NULL,
          amount INTEGER NOT NULL,
          criteria_json TEXT NOT NULL,
          zone_id TEXT,
          deadline TEXT NOT NULL,
          claimed_by_json TEXT,
          claim_id TEXT,
          fulfilled_by_cid TEXT,
          reservation_id TEXT,
          context_json TEXT,
          content_hash TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outcomes (
          cid TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          reason TEXT,
          baseline_cid TEXT,
          content_hash TEXT,
          evaluated_at TEXT NOT NULL,
          evaluated_by TEXT NOT NULL
        );

        INSERT OR REPLACE INTO schema_migrations (version, applied_at)
        VALUES (15, '2026-05-01T00:00:00Z');
      `);

      const now = new Date().toISOString();

      // Seed one row per table. The *_spec rows use a distinct
      // `generation` and the *_status rows use a distinct `revision` so
      // we can verify the column-init path actually copies from the
      // right source.
      db.run(
        `INSERT INTO contributions
           (cid, kind, mode, summary, agent_id, created_at, tags_json, content_hash, manifest_json)
         VALUES (?, 'note', 'individual', ?, 'agent-a', ?, '[]', ?, '{}')`,
        ["blake3:v16-contrib", "v16-test", now, "blake3:v16-hash"],
      );
      db.run(
        `INSERT INTO claim_spec
           (id, role_name, generation, target_ref, agent_id, agent_json,
            intent_summary, finalizers_json, created_at)
         VALUES (?, 'reviewer', 3, 'task:x', 'agent-a', '{}', 'work', '[]', ?)`,
        ["claim-v16", now],
      );
      db.run(
        `INSERT INTO claim_status
           (id, phase, observed_generation, last_heartbeat_at, lease_expires_at,
            conditions_json, last_transition_at, attempt_count, revision)
         VALUES (?, 'active', 0, ?, ?, '[]', ?, 0, 5)`,
        ["claim-v16", now, now, now],
      );
      db.run(
        `INSERT INTO agent_task_spec
           (id, worktree, runtime, role, prompt, depends_on_json, generation,
            finalizers_json, created_at)
         VALUES (?, 'wt-a', 'claude', 'planner', 'do work', '[]', 2, '[]', ?)`,
        ["task-v16", now],
      );
      db.run(
        `INSERT INTO agent_task_status
           (id, phase, contributions_json, conditions_json,
            observed_generation, last_transition_at, revision)
         VALUES (?, 'Pending', '[]', '[]', 0, ?, 4)`,
        ["task-v16", now],
      );
      db.run(
        `INSERT INTO handoffs
           (handoff_id, source_cid, from_role, to_role, status, created_at)
         VALUES (?, ?, 'planner', 'reviewer', 'pending_pickup', ?)`,
        ["handoff-v16", "blake3:v16-contrib", now],
      );
      db.run(
        `INSERT INTO sessions
           (session_id, uid, goal, started_at)
         VALUES (?, 'session-uid-v16', 'session goal', ?)`,
        ["session-v16", now],
      );
      db.run(
        `INSERT INTO goals (id, goal, acceptance, set_at, set_by)
         VALUES (1, 'goal v16', 'acceptance', ?, 'tester')`,
        [now],
      );
      db.run(
        `INSERT INTO bounties
           (bounty_id, title, description, creator_agent_id, creator_json,
            amount, criteria_json, deadline, created_at, updated_at)
         VALUES (?, 'b', 'd', 'agent-a', '{}', 1, '{}', ?, ?, ?)`,
        ["bounty-v16", now, now, now],
      );
      db.run(
        `INSERT INTO outcomes
           (cid, status, content_hash, evaluated_at, evaluated_by)
         VALUES (?, 'accepted', 'blake3:outcome-v16', ?, 'evaluator')`,
        ["blake3:v16-outcome", now],
      );
      db.close();

      // Run the v16 migration.
      const migrated = initSqliteDb(dbPath);

      // Helper: read resource_version for a single keyed row.
      const rvFor = (table: string, idCol: string, idVal: string): number => {
        const row = migrated
          .prepare(`SELECT resource_version AS rv FROM ${table} WHERE ${idCol} = ?`)
          .get(idVal) as { rv: number } | null;
        if (row === null) throw new Error(`row not found in ${table}: ${idVal}`);
        return row.rv;
      };

      // Existing rows backfilled per init rule.
      expect(rvFor("contributions", "cid", "blake3:v16-contrib")).toBe(1);
      expect(rvFor("claim_spec", "id", "claim-v16")).toBe(3); // from generation
      expect(rvFor("claim_status", "id", "claim-v16")).toBe(5); // from revision
      expect(rvFor("agent_task_spec", "id", "task-v16")).toBe(2); // from generation
      expect(rvFor("agent_task_status", "id", "task-v16")).toBe(4); // from revision
      expect(rvFor("handoffs", "handoff_id", "handoff-v16")).toBe(1);
      expect(rvFor("sessions", "session_id", "session-v16")).toBe(1);
      expect(rvFor("bounties", "bounty_id", "bounty-v16")).toBe(1);
      expect(rvFor("outcomes", "cid", "blake3:v16-outcome")).toBe(1);

      // Goals uses id=1 (singleton); rvFor takes numeric -> cast via raw.
      const goalRow = migrated
        .prepare("SELECT resource_version AS rv FROM goals WHERE id = 1")
        .get() as { rv: number } | null;
      expect(goalRow?.rv).toBe(1);

      // Schema version was advanced.
      const ver = (
        migrated.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as {
          v: number | null;
        }
      ).v;
      expect(ver).toBe(CURRENT_SCHEMA_VERSION);

      // Critical regression check (Issue 1): post-migration INSERTs that
      // do NOT mention `resource_version` MUST land with the column
      // DEFAULT, and that DEFAULT MUST be 1 — not 0. Exercises every
      // lazy-DDL table whose insert path does not specify the column.
      migrated.run(
        `INSERT INTO contributions
           (cid, kind, mode, summary, agent_id, created_at, tags_json, content_hash, manifest_json)
         VALUES (?, 'note', 'individual', 'fresh', 'agent-b', ?, '[]', ?, '{}')`,
        ["blake3:v16-fresh-contrib", now, "blake3:v16-fresh-hash"],
      );
      migrated.run(
        `INSERT INTO handoffs
           (handoff_id, source_cid, from_role, to_role, status, created_at)
         VALUES (?, ?, 'planner', 'reviewer', 'pending_pickup', ?)`,
        ["handoff-v16-fresh", "blake3:v16-fresh-contrib", now],
      );
      migrated.run(
        `INSERT INTO sessions (session_id, uid, goal, started_at)
         VALUES (?, 'fresh-uid', 'fresh', ?)`,
        ["session-v16-fresh", now],
      );
      migrated.run(
        `INSERT INTO bounties
           (bounty_id, title, description, creator_agent_id, creator_json,
            amount, criteria_json, deadline, created_at, updated_at)
         VALUES (?, 'b', 'd', 'agent-b', '{}', 1, '{}', ?, ?, ?)`,
        ["bounty-v16-fresh", now, now, now],
      );
      migrated.run(
        `INSERT INTO outcomes
           (cid, status, content_hash, evaluated_at, evaluated_by)
         VALUES (?, 'accepted', 'blake3:outcome-v16-fresh', ?, 'evaluator')`,
        ["blake3:v16-outcome-fresh", now],
      );

      expect(rvFor("contributions", "cid", "blake3:v16-fresh-contrib")).toBeGreaterThanOrEqual(1);
      expect(rvFor("handoffs", "handoff_id", "handoff-v16-fresh")).toBeGreaterThanOrEqual(1);
      expect(rvFor("sessions", "session_id", "session-v16-fresh")).toBeGreaterThanOrEqual(1);
      expect(rvFor("bounties", "bounty_id", "bounty-v16-fresh")).toBeGreaterThanOrEqual(1);
      expect(rvFor("outcomes", "cid", "blake3:v16-outcome-fresh")).toBeGreaterThanOrEqual(1);

      migrated.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
