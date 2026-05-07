/**
 * SQLite-backed contribution graph store.
 *
 * Uses Bun's built-in bun:sqlite for zero-dependency local storage.
 * Split into separate ContributionStore and ClaimStore classes that
 * share a Database instance via initSqliteDb().
 *
 * Schema uses a hybrid approach: materialized columns for indexed queries
 * plus full JSON manifest for round-trip fidelity. FTS5 provides full-text
 * search on summary and description fields.
 */

import type { SQLQueryBindings, Statement } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { ContextSchema, fromManifest, toManifest, verifyCid } from "../core/manifest.js";
import type {
  AgentIdentity,
  Claim,
  ClaimStatus,
  Contribution,
  ContributionKind,
  JsonValue,
  Relation,
  RelationType,
} from "../core/models.js";
import type {
  ActiveClaimFilter,
  ClaimQuery,
  ClaimStore,
  ContributionPutResult,
  ContributionQuery,
  ContributionStore,
  ExpiredClaim,
  ExpireStaleOptions,
  HotThreadsOptions,
  ThreadNode,
  ThreadSummary,
} from "../core/store.js";
import { ExpiryReason } from "../core/store.js";
import { BOUNTY_DDL, SqliteBountyStore } from "./sqlite-bounty-store.js";
import { GOAL_SESSION_DDL, SqliteGoalSessionStore } from "./sqlite-goal-session-store.js";
import { HANDOFF_DDL, SqliteHandoffStore } from "./sqlite-handoff-store.js";
import { SqliteOutcomeStore } from "./sqlite-outcome-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

import { DEFAULT_LEASE_DURATION_MS } from "../core/claim-logic.js";
import { computeContributionContentHash } from "../core/content-dedup.js";
import type { ClaimEntity, ContributionEntity } from "../core/entity.js";
import { claimToEntity, contributionToEntity } from "../core/entity.js";
import { ClaimConflictError, NotFoundError, StateConflictError } from "../core/errors.js";
import type { Finalizer, OwnerRef } from "../core/lifecycle-metadata.js";
import { toUtcIso } from "../core/time.js";

export const CURRENT_SCHEMA_VERSION = 14;
const SQLITE_BIND_LIMIT = 900;

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
  -- Schema migrations tracking
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  -- Main contributions table with materialized columns for indexed queries
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

  CREATE INDEX IF NOT EXISTS idx_contributions_kind ON contributions(kind);
  CREATE INDEX IF NOT EXISTS idx_contributions_mode ON contributions(mode);
  -- Composite index for rate-limit COUNT queries: WHERE agent_id = ? AND created_at >= ?
  CREATE INDEX IF NOT EXISTS idx_contributions_agent_created ON contributions(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_contributions_agent_name ON contributions(agent_name);
  CREATE INDEX IF NOT EXISTS idx_contributions_created ON contributions(created_at);

  -- Junction table for indexable tag queries
  CREATE TABLE IF NOT EXISTS contribution_tags (
    cid TEXT NOT NULL,
    tag TEXT NOT NULL,
    FOREIGN KEY (cid) REFERENCES contributions(cid)
  );

  CREATE INDEX IF NOT EXISTS idx_contribution_tags_tag ON contribution_tags(tag, cid);
  CREATE INDEX IF NOT EXISTS idx_contribution_tags_cid ON contribution_tags(cid);

  -- Junction table for artifact reverse lookups
  CREATE TABLE IF NOT EXISTS artifacts (
    contribution_cid TEXT NOT NULL,
    name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    FOREIGN KEY (contribution_cid) REFERENCES contributions(cid)
  );

  CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(content_hash);
  CREATE INDEX IF NOT EXISTS idx_artifacts_cid ON artifacts(contribution_cid);

  -- Separate relations table for efficient graph traversal
  CREATE TABLE IF NOT EXISTS relations (
    source_cid TEXT NOT NULL,
    target_cid TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (source_cid) REFERENCES contributions(cid)
  );

  CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_cid);
  CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_cid);
  CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
  CREATE INDEX IF NOT EXISTS idx_relations_target_type ON relations(target_cid, relation_type);

  -- Claims table
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
    owner_ref_json TEXT,
    finalizers_json TEXT NOT NULL DEFAULT '[]',
    deletion_timestamp TEXT,
    agent_json TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_claims_target ON claims(target_ref);
  CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
  -- Composite index for active-claim queries: WHERE status = 'active' AND lease_expires_at >= ?
  CREATE INDEX IF NOT EXISTS idx_claims_status_lease ON claims(status, lease_expires_at);

  -- Workspaces table for agent session isolation (per-agent isolation)
  CREATE TABLE IF NOT EXISTS workspaces (
    cid TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    agent_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    context_json TEXT,
    PRIMARY KEY (cid, agent_id)
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
  CREATE INDEX IF NOT EXISTS idx_workspaces_activity ON workspaces(last_activity_at);
  CREATE INDEX IF NOT EXISTS idx_workspaces_agent_id ON workspaces(agent_id);

  -- Idempotency cache: persists across process restarts so CLI retries work.
  -- The in-memory Map in contribute.ts handles single-flight within a process;
  -- this table handles cross-process deduplication.
  -- status: 'pending' (reservation, write in progress) or 'committed' (write done).
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    cache_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    stored_at INTEGER NOT NULL
  );

  -- Key-value store for per-grove settings (e.g. migrated namespace).
  CREATE TABLE IF NOT EXISTS project_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS contributions_fts USING fts5(
    cid,
    summary,
    description
  );
`;

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

/**
 * Initialize a SQLite database with Grove schema and pragmas.
 *
 * Both SqliteContributionStore and SqliteClaimStore share a Database instance
 * created by this function. The caller is responsible for calling db.close().
 */
export function initSqliteDb(dbPath: string): Database {
  const db = new Database(dbPath);

  // busy_timeout MUST be set before any potentially contentious operation.
  db.run("PRAGMA busy_timeout = 5000");

  // Enable WAL mode for concurrent read/write access.
  const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  if (mode !== "wal") {
    try {
      db.run("PRAGMA journal_mode = WAL");
    } catch {
      // Concurrent first-open: another process is switching to WAL.
      // This session falls back to delete/rollback journal mode, which
      // is functionally correct. WAL will be active for future opens.
    }
  }

  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");

  // Performance PRAGMAs — safe defaults for local CLI/server workloads.
  db.run("PRAGMA temp_store = MEMORY");
  db.run("PRAGMA mmap_size = 268435456"); // 256 MB memory-mapped I/O
  db.run("PRAGMA cache_size = -16000"); // 16 MB page cache (8× default)
  db.run("PRAGMA journal_size_limit = 27103364"); // ~26 MB WAL cap

  // Refresh query planner statistics from previous sessions.
  db.run("PRAGMA optimize = 0x10002");

  // IMMEDIATE transaction for schema init — acquires write lock upfront
  // so concurrent openers wait via busy_timeout instead of failing.
  const initSchema = db.transaction(() => {
    db.exec(SCHEMA_DDL);
    db.exec(FTS_DDL);
    db.exec(GOAL_SESSION_DDL);

    // Pre-HANDOFF_DDL column-safe migration: legacy handoffs tables (pre-#164)
    // lack session_id/seen_at/acked_at/ipc_message_id. HANDOFF_DDL now includes
    // `CREATE INDEX idx_handoffs_session_id ON handoffs(session_id)`, which
    // fails on those older tables because CREATE TABLE IF NOT EXISTS leaves the
    // existing schema alone. Add the missing columns here so the index
    // statement in HANDOFF_DDL succeeds. Fresh DBs are no-ops — the table
    // doesn't exist yet, so the PRAGMA returns empty and nothing runs.
    //
    // Legacy NULL-session rows are left intact here. Downstream,
    // SqliteHandoffStore's constructor quarantines them by stamping a
    // sentinel session_id so no real scoped session can mutate them
    // across sessions — while keeping the rows themselves around so
    // unscoped admin/CLI paths and round-3's no-destroy invariant are
    // preserved.
    {
      const handoffCols = db.prepare("PRAGMA table_info(handoffs)").all() as readonly {
        name: string;
      }[];
      if (handoffCols.length > 0) {
        const names = new Set(handoffCols.map((c) => c.name));
        for (const col of ["seen_at", "acked_at", "session_id", "ipc_message_id"]) {
          if (!names.has(col)) {
            db.run(`ALTER TABLE handoffs ADD COLUMN ${col} TEXT`);
          }
        }
      }
    }

    db.exec(HANDOFF_DDL);

    // Check current schema version for migrations
    const currentVersion = (
      db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as {
        v: number | null;
      }
    ).v;
    const needsLegacyBackfill = currentVersion === null || currentVersion < CURRENT_SCHEMA_VERSION;

    // Column-safe migrations: always run regardless of schema version.
    // Each uses PRAGMA table_info to check before altering, making them
    // idempotent on both fresh databases (columns exist from SCHEMA_DDL)
    // and legacy databases that predate schema_migrations tracking
    // (where currentVersion is null and version-gated migrations would
    // be skipped, leaving the DB marked as current but missing columns).
    {
      const columns = db.prepare("PRAGMA table_info(claims)").all() as readonly {
        name: string;
      }[];
      const columnNames = new Set(columns.map((c) => c.name));

      // From v1→v2: add created_at and context_json to claims
      if (!columnNames.has("created_at")) {
        db.run("ALTER TABLE claims ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
        db.run("UPDATE claims SET created_at = heartbeat_at WHERE created_at = ''");
      }
      if (!columnNames.has("context_json")) {
        db.run("ALTER TABLE claims ADD COLUMN context_json TEXT");
      }
      if (!columnNames.has("owner_ref_json")) {
        db.run("ALTER TABLE claims ADD COLUMN owner_ref_json TEXT");
      }
      if (!columnNames.has("finalizers_json")) {
        db.run("ALTER TABLE claims ADD COLUMN finalizers_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!columnNames.has("deletion_timestamp")) {
        db.run("ALTER TABLE claims ADD COLUMN deletion_timestamp TEXT");
      }

      // From v4→v5: add attempt_count to claims
      if (!columnNames.has("attempt_count")) {
        db.run("ALTER TABLE claims ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
      }

      // Revision column — monotonic resourceVersion for Entity watch semantics (#287).
      // Newly created claims start at revision=1 to match NexusClaimStore; when the
      // column is added to an existing database we backfill live rows to 1 for the
      // same reason (generation 0 reads as "uninitialized").
      if (!columnNames.has("revision")) {
        db.run("ALTER TABLE claims ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
        db.run("UPDATE claims SET revision = 1 WHERE revision = 0");
      }
    }

    // Composite index — idempotent via IF NOT EXISTS (from v4→v5)
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_contributions_agent_created ON contributions(agent_id, created_at)",
    );

    // Migration → v12: add implicit content-hash dedup for contributions.
    // Existing duplicate rows are pruned before the UNIQUE index is created,
    // keeping the earliest created_at row for each logical payload.
    {
      const contributionCols = db.prepare("PRAGMA table_info(contributions)").all() as readonly {
        name: string;
      }[];
      const contributionColNames = new Set(contributionCols.map((c) => c.name));
      if (!contributionColNames.has("content_hash")) {
        db.run("ALTER TABLE contributions ADD COLUMN content_hash TEXT");
      }

      const rows = db
        .prepare(
          "SELECT cid, manifest_json FROM contributions WHERE content_hash IS NULL OR content_hash = ''",
        )
        .all() as readonly { cid: string; manifest_json: string }[];
      const updateContentHash = db.prepare(
        "UPDATE contributions SET content_hash = ? WHERE cid = ?",
      );
      for (const row of rows) {
        const contribution = rowToContribution(row);
        updateContentHash.run(computeContributionContentHash(contribution), row.cid);
      }

      const duplicateRows = db
        .prepare(
          `
          WITH ranked AS (
            SELECT cid,
                   ROW_NUMBER() OVER (
                     PARTITION BY content_hash
                     ORDER BY created_at ASC, rowid ASC
                   ) AS rn
            FROM contributions
            WHERE content_hash IS NOT NULL AND content_hash <> ''
          )
          SELECT cid FROM ranked WHERE rn > 1
        `,
        )
        .all() as readonly { cid: string }[];
      for (const row of duplicateRows) {
        db.run("DELETE FROM contributions_fts WHERE cid = ?", [row.cid]);
        db.run("DELETE FROM contribution_tags WHERE cid = ?", [row.cid]);
        db.run("DELETE FROM artifacts WHERE contribution_cid = ?", [row.cid]);
        db.run("DELETE FROM relations WHERE source_cid = ?", [row.cid]);
        db.run("DELETE FROM contributions WHERE cid = ?", [row.cid]);
      }

      db.run(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_contributions_content_hash ON contributions(content_hash)",
      );
    }

    // Version-gated destructive migration: recreate workspaces with per-agent PK
    if (currentVersion !== null && currentVersion < 4 && currentVersion >= 3) {
      db.run("DROP TABLE IF EXISTS workspaces");
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          cid TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          agent_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          context_json TEXT,
          PRIMARY KEY (cid, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
        CREATE INDEX IF NOT EXISTS idx_workspaces_activity ON workspaces(last_activity_at);
        CREATE INDEX IF NOT EXISTS idx_workspaces_agent_id ON workspaces(agent_id);
      `);
    }

    // Migration → v6: add bounties and rewards tables
    if (currentVersion === null || currentVersion < 6) {
      db.exec(BOUNTY_DDL);
    }

    // Migration → v7: normalize ALL created_at values to UTC with milliseconds
    // for reliable lexicographic ORDER BY. This covers:
    //  - Non-Z offsets like +05:30 (strftime normalizes to UTC)
    //  - Z-without-milliseconds like T08:00:00Z (strftime adds .000)
    // Without milliseconds, "T08:00:00Z" sorts BEFORE "T08:00:00.100Z"
    // because '.' (0x2E) < 'Z' (0x5A), giving wrong chronological order.
    if (currentVersion === null || currentVersion < 7) {
      db.run("UPDATE contributions SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)");
    }

    // Migration → v8: add config_json column to sessions (column-safe).
    // The sessions table is created by SqliteGoalSessionStore (lazy init),
    // so it may not exist yet on fresh databases. Only migrate if it does.
    {
      const sessionTableExists =
        (db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
          .get() as { name: string } | null) !== null;
      if (sessionTableExists) {
        const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as readonly {
          name: string;
        }[];
        const sessionColNames = new Set(sessionCols.map((c) => c.name));
        if (!sessionColNames.has("config_json")) {
          db.run("ALTER TABLE sessions ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'");
        }
        if (!sessionColNames.has("preset_name")) {
          db.run("ALTER TABLE sessions ADD COLUMN preset_name TEXT");
        }
        if (!sessionColNames.has("topology_json")) {
          db.run("ALTER TABLE sessions ADD COLUMN topology_json TEXT");
        }
        if (!sessionColNames.has("stop_reason")) {
          db.run("ALTER TABLE sessions ADD COLUMN stop_reason TEXT");
        }
        if (!sessionColNames.has("stop_status")) {
          db.run("ALTER TABLE sessions ADD COLUMN stop_status TEXT");
        }
      }
    }

    // Migration → v9: add archived_at and contribution_count to sessions, create triggers.
    // archived_at (INTEGER, Unix epoch) drives default-exclude behavior in listSessions().
    // contribution_count (denormalized INTEGER) replaces the GROUP BY subquery.
    // Triggers keep contribution_count in sync with session_contributions.
    {
      const sessionTableExists =
        (db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
          .get() as { name: string } | null) !== null;
      if (sessionTableExists) {
        const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as readonly {
          name: string;
        }[];
        const sessionColNames = new Set(sessionCols.map((c) => c.name));

        if (!sessionColNames.has("archived_at")) {
          db.run("ALTER TABLE sessions ADD COLUMN archived_at INTEGER");
          // Backfill: sessions that already have status='archived' get archived_at set
          db.run(`
            UPDATE sessions
            SET archived_at = CAST(strftime('%s', COALESCE(ended_at, 'now')) AS INTEGER)
            WHERE status = 'archived' AND archived_at IS NULL
          `);
        }

        if (!sessionColNames.has("contribution_count")) {
          db.run("ALTER TABLE sessions ADD COLUMN contribution_count INTEGER NOT NULL DEFAULT 0");
          // Backfill from existing session_contributions rows
          db.run(`
            UPDATE sessions
            SET contribution_count = (
              SELECT COUNT(*) FROM session_contributions
              WHERE session_id = sessions.session_id
            )
          `);
        }

        // Create triggers idempotently — IF NOT EXISTS handles fresh DBs that
        // already got these from GOAL_SESSION_DDL.
        db.run(`
          CREATE TRIGGER IF NOT EXISTS trg_sc_insert
          AFTER INSERT ON session_contributions
          BEGIN
            UPDATE sessions SET contribution_count = contribution_count + 1
            WHERE session_id = NEW.session_id;
          END
        `);
        db.run(`
          CREATE TRIGGER IF NOT EXISTS trg_sc_delete
          AFTER DELETE ON session_contributions
          BEGIN
            UPDATE sessions SET contribution_count = contribution_count - 1
            WHERE session_id = OLD.session_id;
          END
        `);
      }
    }

    // Migration → v10: add worktree_strategy_json to sessions.
    // Stores the resolved workspace base-branch per role as JSON so operators
    // can see which roles branched off which source at session creation time.
    // Format: { "coder": "HEAD", "reviewer": "grove/<sessionId>/coder" }
    {
      const sessionTableExists =
        (db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
          .get() as { name: string } | null) !== null;
      if (sessionTableExists) {
        const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as readonly {
          name: string;
        }[];
        const sessionColNames = new Set(sessionCols.map((c) => c.name));
        if (!sessionColNames.has("worktree_strategy_json")) {
          db.run("ALTER TABLE sessions ADD COLUMN worktree_strategy_json TEXT");
        }
      }
    }

    // Migration → v11: create project_settings table (key-value store for
    // per-grove settings like the migrated namespace from `grove migrate`).
    // Handled by SCHEMA_DDL CREATE TABLE IF NOT EXISTS — no ALTER needed.

    // Migration → v13: add stop_status to sessions for semantic loop results.
    {
      const sessionTableExists =
        (db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
          .get() as { name: string } | null) !== null;
      if (sessionTableExists) {
        const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as readonly {
          name: string;
        }[];
        const sessionColNames = new Set(sessionCols.map((c) => c.name));
        if (!sessionColNames.has("stop_status")) {
          db.run("ALTER TABLE sessions ADD COLUMN stop_status TEXT");
        }
      }
    }

    // Migration → v14: persist session/claim deletion lifecycle metadata.
    {
      const sessionTableExists =
        (db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
          .get() as { name: string } | null) !== null;
      if (sessionTableExists) {
        const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as readonly {
          name: string;
        }[];
        const sessionColNames = new Set(sessionCols.map((c) => c.name));
        if (!sessionColNames.has("uid")) {
          db.run("ALTER TABLE sessions ADD COLUMN uid TEXT");
          const rows = db
            .prepare("SELECT session_id FROM sessions WHERE uid IS NULL OR uid = ''")
            .all() as readonly { session_id: string }[];
          const update = db.prepare("UPDATE sessions SET uid = ? WHERE session_id = ?");
          for (const row of rows) update.run(crypto.randomUUID(), row.session_id);
        }
        if (!sessionColNames.has("finalizers_json")) {
          db.run("ALTER TABLE sessions ADD COLUMN finalizers_json TEXT NOT NULL DEFAULT '[]'");
        }
        if (!sessionColNames.has("deletion_timestamp")) {
          db.run("ALTER TABLE sessions ADD COLUMN deletion_timestamp TEXT");
        }
        if (!sessionColNames.has("deletion_audit_json")) {
          db.run("ALTER TABLE sessions ADD COLUMN deletion_audit_json TEXT NOT NULL DEFAULT '[]'");
        }
      }
    }

    {
      const scCols = db.prepare("PRAGMA table_info(session_contributions)").all() as readonly {
        name: string;
      }[];
      if (scCols.length > 0 && !new Set(scCols.map((c) => c.name)).has("owner_ref_json")) {
        db.run("ALTER TABLE session_contributions ADD COLUMN owner_ref_json TEXT");
      }
    }

    db.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      CURRENT_SCHEMA_VERSION,
      new Date().toISOString(),
    ]);

    if (needsLegacyBackfill) {
      // Backfill junction tables for pre-existing contributions once while
      // upgrading legacy databases. INSERT OR IGNORE prevents duplicates.
      db.run(`
        INSERT OR IGNORE INTO contribution_tags (cid, tag)
        SELECT c.cid, j.value
        FROM contributions c, json_each(c.tags_json) j
        WHERE NOT EXISTS (
          SELECT 1 FROM contribution_tags ct WHERE ct.cid = c.cid AND ct.tag = j.value
        )
      `);
      db.run(`
        INSERT OR IGNORE INTO artifacts (contribution_cid, name, content_hash)
        SELECT c.cid, j.key, j.value
        FROM contributions c, json_each(json_extract(c.manifest_json, '$.artifacts')) j
        WHERE NOT EXISTS (
          SELECT 1
          FROM artifacts a
          WHERE a.contribution_cid = c.cid AND a.name = j.key AND a.content_hash = j.value
        )
      `);
    }
  });
  initSchema.immediate();

  return db;
}

/**
 * Read the effective namespace for this grove's SQLite store.
 *
 * Written by `grove migrate` when upgrading a legacy installation.
 * Returns `"default"` if no migration has been applied yet.
 */
export function readStoreNamespace(db: Database): string {
  // Tolerate missing table so callers (e.g. `grove migrate --dry-run` opening
  // a legacy DB read-only) do not crash before schema migrations have run.
  try {
    const row = db.prepare("SELECT value FROM project_settings WHERE key = 'namespace'").get() as {
      value: string;
    } | null;
    return row?.value ?? "default";
  } catch (err) {
    if ((err as Error).message?.includes("no such table")) return "default";
    throw err;
  }
}

/**
 * Persist the store namespace in project_settings (upsert).
 * Used by `grove migrate` and `grove init` to wire the local store to
 * the project's canonical `{uuid}/{worktree}` namespace.
 */
export function writeStoreNamespace(db: Database, namespace: string): void {
  db.run("INSERT OR REPLACE INTO project_settings (key, value) VALUES ('namespace', ?)", [
    namespace,
  ]);
}

// ---------------------------------------------------------------------------
// SqliteIdempotencyStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed idempotency store for cross-process deduplication.
 *
 * Complements the in-memory Map in contribute.ts: the Map provides
 * single-flight (pending Promise coalescence) within a process; this
 * store provides durable lookup so a CLI retry in a new process can
 * detect that a key was already used.
 */
export class SqliteIdempotencyStore {
  private readonly db: Database;
  private readonly lookupStmt: Statement;
  private readonly reserveStmt: Statement;
  private readonly commitStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    this.lookupStmt = db.prepare(
      "SELECT fingerprint, result_json, status FROM idempotency_keys WHERE cache_key = ? AND stored_at > ?",
    );
    this.reserveStmt = db.prepare(
      "INSERT OR IGNORE INTO idempotency_keys (cache_key, fingerprint, status, stored_at) VALUES (?, ?, 'pending', ?)",
    );
    this.commitStmt = db.prepare(
      "UPDATE idempotency_keys SET result_json = ?, status = 'committed', stored_at = ? WHERE cache_key = ? AND fingerprint = ?",
    );
  }

  lookup(
    cacheKey: string,
    ttlMs: number,
  ):
    | { readonly fingerprint: string; readonly resultJson: string; readonly status: string }
    | undefined {
    const cutoff = Date.now() - ttlMs;
    const row = this.lookupStmt.get(cacheKey, cutoff) as {
      fingerprint: string;
      result_json: string;
      status: string;
    } | null;
    if (row === null) return undefined;
    return {
      fingerprint: row.fingerprint,
      resultJson: row.result_json,
      status: row.status,
    };
  }

  reserve(cacheKey: string, fingerprint: string): boolean {
    // Purge expired COMMITTED rows so the key becomes reusable after TTL.
    // Never delete pending rows — they may represent in-flight writes in
    // other processes running past the TTL (slow CAS, hooks, contention).
    this.db.run(
      "DELETE FROM idempotency_keys WHERE cache_key = ? AND status = 'committed' AND stored_at <= ?",
      [cacheKey, Date.now() - 5 * 60 * 1000],
    );
    const result = this.reserveStmt.run(cacheKey, fingerprint, Date.now());
    return result.changes === 1;
  }

  /** Remove a pending reservation on failure (pre-commit rollback). */
  rollback(cacheKey: string): void {
    this.db.run("DELETE FROM idempotency_keys WHERE cache_key = ? AND status = 'pending'", [
      cacheKey,
    ]);
  }

  store(cacheKey: string, fingerprint: string, resultJson: string): void {
    this.commitStmt.run(resultJson, Date.now(), cacheKey, fingerprint);
  }

  clear(): void {
    this.db.run("DELETE FROM idempotency_keys");
  }
}

/**
 * Convenience factory that creates a shared Database and returns both stores.
 * The returned close() disposes the database connection.
 *
 * Pass `sessionId` to get a session-scoped handoff store. When set, all
 * handoff reads/writes/mutations filter by session_id, enabling proactive
 * deadline timers and ack receipts without cross-session corruption.
 */
export function createSqliteStores(
  dbPath: string,
  opts?: { readonly sessionId?: string | undefined },
): {
  db: Database;
  contributionStore: SqliteContributionStore;
  claimStore: SqliteClaimStore;
  bountyStore: SqliteBountyStore;
  outcomeStore: SqliteOutcomeStore;
  goalSessionStore: SqliteGoalSessionStore;
  handoffStore: SqliteHandoffStore;
  idempotencyStore: SqliteIdempotencyStore;
  close: () => void;
} {
  const db = initSqliteDb(dbPath);
  return {
    db,
    contributionStore: new SqliteContributionStore(db),
    claimStore: new SqliteClaimStore(db),
    bountyStore: new SqliteBountyStore(db),
    outcomeStore: new SqliteOutcomeStore(db),
    goalSessionStore: new SqliteGoalSessionStore(db),
    handoffStore: new SqliteHandoffStore(db, opts?.sessionId),
    idempotencyStore: new SqliteIdempotencyStore(db),
    close: () => {
      db.run("PRAGMA optimize");
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared query builder (DRY: used by list, search, count)
// ---------------------------------------------------------------------------

interface BuiltQuery {
  readonly sql: string;
  readonly params: SQLQueryBindings[];
}

interface BuildFilteredQueryOptions {
  readonly baseSelect: string;
  readonly query: ContributionQuery | undefined;
  readonly extraConditions?: readonly string[];
  readonly extraParams?: readonly SQLQueryBindings[];
  readonly orderBy?: string;
}

/**
 * Build a complete filtered query from a base SELECT, optional extra WHERE
 * conditions, ordering, and a ContributionQuery.
 *
 * Handles: field filters, tag junction joins, ordering, pagination.
 */
function buildFilteredQuery(opts: BuildFilteredQueryOptions): BuiltQuery {
  const { baseSelect, query, orderBy } = opts;
  const conditions: string[] = opts.extraConditions ? [...opts.extraConditions] : [];
  const params: SQLQueryBindings[] = opts.extraParams ? [...opts.extraParams] : [];

  if (query?.kind !== undefined) {
    conditions.push("c.kind = ?");
    params.push(query.kind);
  }
  if (query?.mode !== undefined) {
    conditions.push("c.mode = ?");
    params.push(query.mode);
  }
  if (query?.agentId !== undefined) {
    conditions.push("c.agent_id = ?");
    params.push(query.agentId);
  }
  if (query?.agentName !== undefined) {
    conditions.push("c.agent_name = ?");
    params.push(query.agentName);
  }
  if (query?.platform !== undefined) {
    conditions.push("json_extract(c.manifest_json, '$.agent.platform') = ?");
    params.push(query.platform);
  }

  // Session filtering via junction table — only contributions linked to this session.
  if (query?.sessionId !== undefined) {
    conditions.push(
      `EXISTS (SELECT 1 FROM session_contributions sc WHERE sc.cid = c.cid AND sc.session_id = ?)`,
    );
    params.push(query.sessionId);
  }

  // Tag filtering via junction table — contribution must have ALL queried tags.
  // Uses intersecting EXISTS subqueries for indexed point lookups on (tag, cid).
  if (query?.tags !== undefined && query.tags.length > 0) {
    const uniqueTags = [...new Set(query.tags)];
    if (uniqueTags.length > SQLITE_BIND_LIMIT) {
      throw new Error(`Too many tag filters: maximum ${SQLITE_BIND_LIMIT}`);
    }
    for (const tag of uniqueTags) {
      conditions.push(
        `EXISTS (SELECT 1 FROM contribution_tags ct WHERE ct.cid = c.cid AND ct.tag = ?)`,
      );
      params.push(tag);
    }
  }

  let sql = baseSelect;
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (orderBy !== undefined) {
    const effectiveOrderBy =
      query?.order === "created_at_desc" && orderBy === "c.created_at ASC"
        ? "c.created_at DESC"
        : orderBy;
    sql += ` ORDER BY ${effectiveOrderBy}`;
  }

  // Pagination
  if (query?.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(query.limit);
  }
  if (query?.offset !== undefined) {
    if (query?.limit === undefined) {
      sql += " LIMIT -1";
    }
    sql += " OFFSET ?";
    params.push(query.offset);
  }

  return { sql, params };
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/** Deserialize a manifest_json row into a Contribution (CID already verified at write time). */
function rowToContribution(row: { manifest_json: string }): Contribution {
  return fromManifest(JSON.parse(row.manifest_json) as unknown, { verify: false });
}

interface ClaimRow {
  readonly claim_id: string;
  readonly target_ref: string;
  readonly agent_id: string;
  readonly status: string;
  readonly intent_summary: string;
  readonly created_at: string;
  readonly heartbeat_at: string;
  readonly lease_expires_at: string;
  readonly context_json: string | null;
  readonly owner_ref_json: string | null;
  readonly finalizers_json: string;
  readonly deletion_timestamp: string | null;
  readonly agent_json: string;
  readonly attempt_count: number;
  readonly revision: number;
}

function rowToClaim(row: ClaimRow, statusOverride?: ClaimStatus): Claim {
  const base: Claim = {
    claimId: row.claim_id,
    targetRef: row.target_ref,
    agent: JSON.parse(row.agent_json) as AgentIdentity,
    status: (statusOverride ?? row.status) as ClaimStatus,
    intentSummary: row.intent_summary,
    createdAt: row.created_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    ...(row.owner_ref_json !== null
      ? { ownerRef: JSON.parse(row.owner_ref_json) as OwnerRef }
      : {}),
    finalizers: JSON.parse(row.finalizers_json) as readonly Finalizer[],
    ...(row.deletion_timestamp !== null ? { deletionTimestamp: row.deletion_timestamp } : {}),
    ...(row.attempt_count > 0 && { attemptCount: row.attempt_count }),
    revision: row.revision,
  };
  if (row.context_json !== null) {
    return {
      ...base,
      context: JSON.parse(row.context_json) as Readonly<Record<string, JsonValue>>,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// SqliteContributionStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed ContributionStore with FTS5 search.
 *
 * Uses INSERT OR IGNORE for idempotent puts, a contribution_tags junction
 * table for indexed tag queries, and cached prepared statements for hot paths.
 */
export class SqliteContributionStore implements ContributionStore {
  readonly storeIdentity: string;
  private readonly db: Database;

  /** Optional callback invoked after a successful write (put/putMany). */
  onWrite?: () => void;

  /**
   * Optional callback invoked after a successful Contribution write — the
   * domain-typed feed for the local-mode `WatchHub` (#388 PR2). The
   * `LocalRuntime` adapter projects via `contributionToEntity` and calls
   * `WatchHub.recordWrite`. Only fires for newly-inserted contributions
   * (idempotent re-puts of the same CID do not re-fire).
   */
  onContributionWrite?: (op: "ADDED" | "MODIFIED" | "DELETED", c: Contribution) => void;

  // Cached prepared statements for fixed queries
  private readonly stmtGetByCid: Statement;
  private readonly stmtGetByContentHash: Statement;
  private readonly stmtInsertContribution: Statement;
  private readonly stmtInsertRelation: Statement;
  private readonly stmtInsertFts: Statement;
  private readonly stmtInsertTag: Statement;
  private readonly stmtInsertArtifact: Statement;
  private readonly stmtChildren: Statement;
  private readonly stmtAncestors: Statement;

  constructor(db: Database) {
    this.db = db;
    this.storeIdentity = db.filename;

    this.stmtGetByCid = db.query("SELECT manifest_json FROM contributions WHERE cid = ?");
    this.stmtGetByContentHash = db.query(
      "SELECT cid, manifest_json FROM contributions WHERE content_hash = ?",
    );
    this.stmtInsertContribution = db.query(
      `INSERT OR IGNORE INTO contributions (cid, kind, mode, summary, description,
       agent_id, agent_name, created_at, tags_json, content_hash, manifest_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtInsertRelation = db.query(
      `INSERT INTO relations (source_cid, target_cid, relation_type, metadata_json)
       VALUES (?, ?, ?, ?)`,
    );
    this.stmtInsertFts = db.query(
      "INSERT INTO contributions_fts (cid, summary, description) VALUES (?, ?, ?)",
    );
    this.stmtInsertTag = db.query("INSERT INTO contribution_tags (cid, tag) VALUES (?, ?)");
    this.stmtInsertArtifact = db.query(
      "INSERT INTO artifacts (contribution_cid, name, content_hash) VALUES (?, ?, ?)",
    );
    this.stmtChildren = db.query(`
      SELECT DISTINCT c.manifest_json FROM contributions c
      INNER JOIN relations r ON r.source_cid = c.cid
      WHERE r.target_cid = ?
    `);
    this.stmtAncestors = db.query(`
      SELECT DISTINCT c.manifest_json FROM contributions c
      INNER JOIN relations r ON r.target_cid = c.cid
      WHERE r.source_cid = ?
    `);
  }

  put = async (contribution: Contribution): Promise<ContributionPutResult> => {
    const result = this.putSync(contribution);
    if (result.isNew) {
      this.onWrite?.();
      this.onContributionWrite?.("ADDED", contribution);
    }
    return result;
  };

  /**
   * Write a contribution and run cowriteFn() inside the same SQLite transaction.
   * Used for atomic contribution + handoff creation (outbox pattern).
   *
   * cowriteFn must be synchronous (SQLite transactions in bun:sqlite are sync).
   *
   * Capability extension: `contributeOperation` duck-types for this method at
   * runtime. When both the ContributionStore and HandoffStore are SQLite-backed
   * (i.e. both expose `putWithCowrite` and `insertSync`), the write goes through
   * `writeAtomic` — a single SQLite transaction covering contribution + all handoffs.
   * Stores that do NOT implement this method fall back to `writeSerial` (best-effort
   * handoffs). Implementing stores must not add this method unless they can actually
   * satisfy the synchronous-cowrite contract.
   */
  putWithCowrite(contribution: Contribution, cowriteFn: () => void): ContributionPutResult {
    const result = this.putSync(contribution, cowriteFn);
    if (result.isNew) {
      this.onWrite?.();
      this.onContributionWrite?.("ADDED", contribution);
    }
    return result;
  }

  putMany = async (
    contributions: readonly Contribution[],
  ): Promise<readonly ContributionPutResult[]> => {
    if (contributions.length === 0) return [];
    const results: ContributionPutResult[] = [];
    const tx = this.db.transaction(() => {
      for (const c of contributions) {
        results.push(this.insertContributionInCurrentTransaction(c));
      }
    });
    tx();
    if (results.some((result) => result.isNew)) this.onWrite?.();
    if (this.onContributionWrite) {
      for (let i = 0; i < contributions.length; i += 1) {
        if (results[i]?.isNew) {
          this.onContributionWrite("ADDED", contributions[i] as Contribution);
        }
      }
    }
    return results;
  };

  get = async (cid: string): Promise<Contribution | undefined> => {
    const row = this.stmtGetByCid.get(cid) as { manifest_json: string } | null;
    if (row === null) return undefined;
    return rowToContribution(row);
  };

  getByContentHash = async (contentHash: string): Promise<Contribution | undefined> => {
    const row = this.stmtGetByContentHash.get(contentHash) as { manifest_json: string } | null;
    if (row === null) return undefined;
    return rowToContribution(row);
  };

  getMany = async (cids: readonly string[]): Promise<ReadonlyMap<string, Contribution>> => {
    const result = new Map<string, Contribution>();
    if (cids.length === 0) return result;

    const uniqueCids = [...new Set(cids)];
    for (let i = 0; i < uniqueCids.length; i += SQLITE_BIND_LIMIT) {
      const chunk = uniqueCids.slice(i, i + SQLITE_BIND_LIMIT);
      const placeholders = chunk.map(() => "?").join(", ");
      const sql = `SELECT manifest_json FROM contributions WHERE cid IN (${placeholders})`;
      const rows = this.db.prepare(sql).all(...chunk) as readonly { manifest_json: string }[];
      for (const row of rows) {
        const contribution = rowToContribution(row);
        result.set(contribution.cid, contribution);
      }
    }
    return result;
  };

  list = async (query?: ContributionQuery): Promise<readonly Contribution[]> => {
    const { sql, params } = buildFilteredQuery({
      baseSelect: "SELECT c.manifest_json FROM contributions c",
      query,
      orderBy: "c.created_at ASC",
    });
    const rows = this.db.prepare(sql).all(...params) as readonly { manifest_json: string }[];
    return rows.map(rowToContribution);
  };

  children = async (cid: string): Promise<readonly Contribution[]> => {
    const rows = this.stmtChildren.all(cid) as readonly { manifest_json: string }[];
    return rows.map(rowToContribution);
  };

  incomingSources = async (targetCids: readonly string[]): Promise<readonly Contribution[]> => {
    if (targetCids.length === 0) return [];

    const seen = new Set<string>();
    const results: Contribution[] = [];

    // Chunk to stay under SQLITE_MAX_VARIABLE_NUMBER (999)
    const chunkSize = 500;
    for (let i = 0; i < targetCids.length; i += chunkSize) {
      const chunk = targetCids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const sql = `
        SELECT DISTINCT c.manifest_json
        FROM contributions c
        JOIN relations r ON r.source_cid = c.cid
        WHERE r.target_cid IN (${placeholders})
      `;
      const rows = this.db.prepare(sql).all(...chunk) as readonly { manifest_json: string }[];
      for (const row of rows) {
        const contribution = rowToContribution(row);
        if (!seen.has(contribution.cid)) {
          seen.add(contribution.cid);
          results.push(contribution);
        }
      }
    }

    return results;
  };

  ancestors = async (cid: string): Promise<readonly Contribution[]> => {
    const rows = this.stmtAncestors.all(cid) as readonly { manifest_json: string }[];
    return rows.map(rowToContribution);
  };

  relationsOf = async (cid: string, relationType?: RelationType): Promise<readonly Relation[]> => {
    let sql = "SELECT target_cid, relation_type, metadata_json FROM relations WHERE source_cid = ?";
    const params: SQLQueryBindings[] = [cid];

    if (relationType !== undefined) {
      sql += " AND relation_type = ?";
      params.push(relationType);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly {
      target_cid: string;
      relation_type: string;
      metadata_json: string | null;
    }[];

    return rows.map((row): Relation => {
      const base: Relation = {
        targetCid: row.target_cid,
        relationType: row.relation_type as RelationType,
      };
      if (row.metadata_json !== null) {
        return {
          ...base,
          metadata: JSON.parse(row.metadata_json) as Readonly<Record<string, JsonValue>>,
        };
      }
      return base;
    });
  };

  relatedTo = async (
    cid: string,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> => {
    let sql = `
      SELECT DISTINCT c.manifest_json FROM contributions c
      INNER JOIN relations r ON r.source_cid = c.cid
      WHERE r.target_cid = ?
    `;
    const params: SQLQueryBindings[] = [cid];

    if (relationType !== undefined) {
      sql += " AND r.relation_type = ?";
      params.push(relationType);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly { manifest_json: string }[];
    return rows.map(rowToContribution);
  };

  search = async (query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> => {
    // FTS5 query: escape special characters by quoting the search term
    const ftsQuery = `"${query.replace(/"/g, '""')}"`;

    const { sql, params } = buildFilteredQuery({
      baseSelect: `SELECT c.manifest_json FROM contributions c
       INNER JOIN contributions_fts fts ON fts.cid = c.cid`,
      query: filters,
      extraConditions: ["contributions_fts MATCH ?"],
      extraParams: [ftsQuery],
    });
    const rows = this.db.prepare(sql).all(...params) as readonly { manifest_json: string }[];
    return rows.map(rowToContribution);
  };

  findExisting = async (
    agentId: string,
    targetCid: string,
    kind: ContributionKind,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> => {
    let sql = `
      SELECT DISTINCT c.manifest_json FROM contributions c
      INNER JOIN relations r ON r.source_cid = c.cid
      WHERE c.agent_id = ? AND c.kind = ? AND r.target_cid = ?
    `;
    const params: SQLQueryBindings[] = [agentId, kind, targetCid];

    if (relationType !== undefined) {
      sql += " AND r.relation_type = ?";
      params.push(relationType);
    }

    sql += " ORDER BY c.created_at DESC";

    const rows = this.db.prepare(sql).all(...params) as readonly {
      manifest_json: string;
    }[];
    return rows.map(rowToContribution);
  };

  count = async (query?: ContributionQuery): Promise<number> => {
    const { sql, params } = buildFilteredQuery({
      baseSelect: "SELECT COUNT(*) as cnt FROM contributions c",
      query,
    });
    const row = this.db.prepare(sql).get(...params) as { cnt: number } | null;
    return row?.cnt ?? 0;
  };

  countSince = async (query: { agentId?: string; since: string }): Promise<number> => {
    const sql =
      query.agentId !== undefined
        ? "SELECT COUNT(*) as cnt FROM contributions WHERE agent_id = ? AND created_at >= ?"
        : "SELECT COUNT(*) as cnt FROM contributions WHERE created_at >= ?";
    const params = query.agentId !== undefined ? [query.agentId, query.since] : [query.since];
    const row = this.db.prepare(sql).get(...params) as { cnt: number } | null;
    return row?.cnt ?? 0;
  };

  thread = async (
    rootCid: string,
    opts?: { readonly maxDepth?: number; readonly limit?: number },
  ): Promise<readonly ThreadNode[]> => {
    const maxDepth = opts?.maxDepth ?? 50;

    // Check root exists
    const rootRow = this.stmtGetByCid.get(rootCid) as { manifest_json: string } | null;
    if (rootRow === null) return [];

    // Deduplicate in the outer query: a contribution with multiple responds_to
    // parents can appear at different depths in the CTE. GROUP BY cid + MIN(depth)
    // keeps the shallowest occurrence, matching the InMemory BFS behavior.
    const sql = `
      WITH RECURSIVE thread_walk(cid, depth, created_at) AS (
        SELECT ?, 0, c.created_at
        FROM contributions c WHERE c.cid = ?
        UNION ALL
        SELECT r.source_cid, tw.depth + 1, child.created_at
        FROM thread_walk tw
        INNER JOIN relations r
          ON r.target_cid = tw.cid AND r.relation_type = 'responds_to'
        INNER JOIN contributions child ON child.cid = r.source_cid
        WHERE tw.depth < ?
      )
      SELECT deduped.cid, deduped.depth, c.manifest_json
      FROM (
        SELECT cid, MIN(depth) AS depth, MIN(created_at) AS created_at
        FROM thread_walk
        GROUP BY cid
      ) deduped
      INNER JOIN contributions c ON c.cid = deduped.cid
      ORDER BY deduped.depth ASC, deduped.created_at ASC
      ${opts?.limit !== undefined ? "LIMIT ?" : ""}
    `;

    const params: SQLQueryBindings[] = [rootCid, rootCid, maxDepth];
    if (opts?.limit !== undefined) {
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly {
      cid: string;
      depth: number;
      manifest_json: string;
    }[];

    return rows.map(
      (row): ThreadNode => ({
        contribution: rowToContribution(row),
        depth: row.depth,
      }),
    );
  };

  replyCounts = async (cids: readonly string[]): Promise<ReadonlyMap<string, number>> => {
    const result = new Map<string, number>();

    // Initialize all requested CIDs to 0
    for (const cid of cids) {
      result.set(cid, 0);
    }

    if (cids.length === 0) return result;

    // Chunk into groups of 500 to stay under SQLITE_MAX_VARIABLE_NUMBER (999)
    const chunkSize = 500;
    for (let i = 0; i < cids.length; i += chunkSize) {
      const chunk = cids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const sql = `
        SELECT target_cid, COUNT(*) as cnt
        FROM relations
        WHERE target_cid IN (${placeholders}) AND relation_type = 'responds_to'
        GROUP BY target_cid
      `;
      const rows = this.db.prepare(sql).all(...chunk) as readonly {
        target_cid: string;
        cnt: number;
      }[];
      for (const row of rows) {
        result.set(row.target_cid, row.cnt);
      }
    }

    return result;
  };

  hotThreads = async (opts?: HotThreadsOptions): Promise<readonly ThreadSummary[]> => {
    const limit = opts?.limit ?? 20;
    const params: SQLQueryBindings[] = [];

    // Deduplicate tags for consistent filtering
    const uniqueTags =
      opts?.tags !== undefined && opts.tags.length > 0 ? [...new Set(opts.tags)] : undefined;

    // Build EXISTS subqueries for tag filtering — indexed point lookups on (tag, cid).
    let tagWhere = "";
    if (uniqueTags !== undefined) {
      for (const tag of uniqueTags) {
        tagWhere += ` AND EXISTS (SELECT 1 FROM contribution_tags ct WHERE ct.cid = c.cid AND ct.tag = ?)`;
        params.push(tag);
      }
    }

    const sql = `
      SELECT c.manifest_json,
             COUNT(r.source_cid) as reply_count,
             MAX(reply_c.created_at) as last_reply_at
      FROM contributions c
      INNER JOIN relations r ON r.target_cid = c.cid AND r.relation_type = 'responds_to'
      INNER JOIN contributions reply_c ON reply_c.cid = r.source_cid
      WHERE 1=1${tagWhere}
      GROUP BY c.cid
      HAVING COUNT(r.source_cid) >= 1
      ORDER BY reply_count DESC, last_reply_at DESC
      LIMIT ?
    `;

    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as readonly {
      manifest_json: string;
      reply_count: number;
      last_reply_at: string;
    }[];

    return rows.map(
      (row): ThreadSummary => ({
        contribution: rowToContribution(row),
        replyCount: row.reply_count,
        lastReplyAt: row.last_reply_at,
      }),
    );
  };

  async listEntities(query?: ContributionQuery): Promise<readonly ContributionEntity[]> {
    const items = await this.list(query);
    const namespace = readStoreNamespace(this.db);
    return items.map((c) => contributionToEntity(c, namespace));
  }

  /**
   * No-op when used via createSqliteStores() — the factory's close() owns the
   * shared Database handle. Calling this will NOT close the underlying DB.
   */
  close(): void {
    // Intentional no-op: DB lifecycle is managed by the factory or SqliteStore facade.
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /** Synchronous put — uses INSERT OR IGNORE for atomic idempotency.
   *  @param cowrite — optional function run inside the same SQLite transaction after the insert.
   */
  public putSync(contribution: Contribution, cowrite?: () => void): ContributionPutResult {
    const tx = this.db.transaction(() =>
      this.insertContributionInCurrentTransaction(contribution, cowrite),
    );
    return tx();
  }

  private insertContributionInCurrentTransaction(
    contribution: Contribution,
    cowrite?: () => void,
  ): ContributionPutResult {
    // Verify CID integrity before persisting
    if (!verifyCid(contribution)) {
      throw new Error(
        `CID integrity check failed for '${contribution.cid}': CID does not match manifest content`,
      );
    }

    const manifestJson = JSON.stringify(toManifest(contribution));
    const tagsJson = JSON.stringify(contribution.tags);
    // Normalize to UTC for reliable lexicographic ORDER BY on the indexed column.
    // The manifest_json keeps the original value for CID integrity.
    const createdAtUtc = toUtcIso(contribution.createdAt);
    const contentHash = computeContributionContentHash(contribution);

    // INSERT OR IGNORE: if CID or content_hash already exists, this is a no-op.
    const result = this.stmtInsertContribution.run(
      contribution.cid,
      contribution.kind,
      contribution.mode,
      contribution.summary,
      contribution.description ?? null,
      contribution.agent.agentId,
      contribution.agent.agentName ?? null,
      createdAtUtc,
      tagsJson,
      contentHash,
      manifestJson,
    );

    // If no row was inserted, return the existing row selected by content hash.
    if (result.changes === 0) {
      const existing = this.stmtGetByContentHash.get(contentHash) as {
        cid: string;
        manifest_json: string;
      } | null;
      if (existing !== null) {
        return {
          cid: existing.cid,
          isNew: false,
          contribution: rowToContribution(existing),
        };
      }
      return { cid: contribution.cid, isNew: false };
    }

    // Insert relations
    for (const rel of contribution.relations) {
      this.stmtInsertRelation.run(
        contribution.cid,
        rel.targetCid,
        rel.relationType,
        rel.metadata !== undefined ? JSON.stringify(rel.metadata) : null,
      );
    }

    // Insert into FTS index
    this.stmtInsertFts.run(contribution.cid, contribution.summary, contribution.description ?? "");

    // Insert tags into junction table
    for (const tag of contribution.tags) {
      this.stmtInsertTag.run(contribution.cid, tag);
    }

    // Insert artifact references into junction table
    for (const [name, artifactContentHash] of Object.entries(contribution.artifacts)) {
      this.stmtInsertArtifact.run(contribution.cid, name, artifactContentHash);
    }

    // Optional cowrite: runs inside the same transaction (used for atomic handoff creation)
    cowrite?.();
    return { cid: contribution.cid, isNew: true, contribution };
  }

  /**
   * Return all distinct content hashes referenced by artifacts.
   *
   * Used by garbage collection to determine which CAS blobs are still
   * referenced and which can be safely deleted.
   */
  allContentHashes(): ReadonlySet<string> {
    const rows = this.db.prepare("SELECT DISTINCT content_hash FROM artifacts").all() as readonly {
      content_hash: string;
    }[];
    return new Set(rows.map((r) => r.content_hash));
  }
}

// ---------------------------------------------------------------------------
// SqliteClaimStore
// ---------------------------------------------------------------------------

const CLAIM_SELECT_COLS = `claim_id, target_ref, agent_id, status, intent_summary,
  created_at, heartbeat_at, lease_expires_at, context_json, owner_ref_json, finalizers_json,
  deletion_timestamp, agent_json, attempt_count, revision`;

/**
 * SQLite-backed ClaimStore with lease-based coordination.
 *
 * Uses EXCLUSIVE transactions for claim creation, atomic UPDATE WHERE
 * for heartbeat and state transitions, and UPDATE RETURNING for expiry.
 */
export class SqliteClaimStore implements ClaimStore {
  readonly storeIdentity: string;
  private readonly db: Database;

  /**
   * Optional callback invoked after a successful Claim transition that
   * matters for the local-mode WatchHub (#388 PR2). Pure heartbeat-only
   * updates that don't change status or the lease boundary are NOT fired —
   * matches the rule documented on `OperationDeps.onEntityWrite`.
   */
  onClaimWrite?: (op: "ADDED" | "MODIFIED" | "DELETED", c: Claim) => void;

  // Cached prepared statements
  private readonly stmtGetClaim: Statement;

  constructor(db: Database) {
    this.db = db;
    this.storeIdentity = db.filename;

    this.stmtGetClaim = db.query(`SELECT ${CLAIM_SELECT_COLS} FROM claims WHERE claim_id = ?`);
  }

  createClaim = async (claim: Claim): Promise<Claim> => {
    this.validateClaimContext(claim);

    // Normalize timestamps to UTC for reliable SQL text comparison
    const createdAtUtc = toUtcIso(claim.createdAt);
    const heartbeatUtc = toUtcIso(claim.heartbeatAt);
    const leaseExpiresUtc = toUtcIso(claim.leaseExpiresAt);
    // Atomic check-and-insert: IMMEDIATE transaction prevents TOCTOU races
    const createTx = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT claim_id FROM claims WHERE claim_id = ?")
        .get(claim.claimId) as { claim_id: string } | null;

      if (existing !== null) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "already exists",
          message: `Claim with id '${claim.claimId}' already exists`,
        });
      }

      // Prevent duplicate active claims on the same target
      const now = new Date().toISOString();
      const activeOnTarget = this.db
        .prepare(
          "SELECT claim_id FROM claims WHERE target_ref = ? AND status = 'active' AND lease_expires_at >= ?",
        )
        .get(claim.targetRef, now) as { claim_id: string } | null;

      if (activeOnTarget !== null) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "target already has an active claim",
          message: `Target '${claim.targetRef}' already has an active claim '${activeOnTarget.claim_id}'`,
        });
      }

      this.insertClaimRow(claim, createdAtUtc, heartbeatUtc, leaseExpiresUtc);
    });
    try {
      createTx.immediate();
    } catch (err) {
      if (err instanceof Error && err.message.includes("database is locked")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        createTx.immediate();
      } else {
        throw err;
      }
    }

    const created = this.readClaim(claim.claimId);
    if (created === null) throw new Error(`Failed to read back claim '${claim.claimId}'`);
    this.onClaimWrite?.("ADDED", created);
    return created;
  };

  claimOrRenew = async (claim: Claim): Promise<Claim> => {
    this.validateClaimContext(claim);

    const createdAtUtc = toUtcIso(claim.createdAt);
    const heartbeatUtc = toUtcIso(claim.heartbeatAt);
    const leaseExpiresUtc = toUtcIso(claim.leaseExpiresAt);

    let resultClaimId: string = claim.claimId;
    let didRenew = false;

    const tx = this.db.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const activeOnTarget = this.db
        .prepare(
          `SELECT claim_id, agent_id FROM claims
           WHERE target_ref = ? AND status = 'active' AND lease_expires_at >= ?`,
        )
        .get(claim.targetRef, nowIso) as { claim_id: string; agent_id: string } | null;

      if (activeOnTarget !== null) {
        // Same agent → renew the existing claim from current time
        if (activeOnTarget.agent_id === claim.agent.agentId) {
          didRenew = true;
          // Use the requested lease duration (derived from the claim payload),
          // but anchor it to now so retries always extend the lease forward.
          const requestedDurationMs =
            new Date(claim.leaseExpiresAt).getTime() - new Date(claim.createdAt).getTime();
          const durationMs =
            requestedDurationMs > 0 ? requestedDurationMs : DEFAULT_LEASE_DURATION_MS;
          const freshExpiry = new Date(now.getTime() + durationMs).toISOString();
          if (claim.ownerRef !== undefined) {
            this.db
              .prepare(
                `UPDATE claims SET heartbeat_at = ?, lease_expires_at = ?, intent_summary = ?,
                   owner_ref_json = ?, revision = revision + 1
                 WHERE claim_id = ?`,
              )
              .run(
                nowIso,
                freshExpiry,
                claim.intentSummary,
                JSON.stringify(claim.ownerRef),
                activeOnTarget.claim_id,
              );
          } else {
            this.db
              .prepare(
                `UPDATE claims SET heartbeat_at = ?, lease_expires_at = ?, intent_summary = ?,
                   revision = revision + 1
                 WHERE claim_id = ?`,
              )
              .run(nowIso, freshExpiry, claim.intentSummary, activeOnTarget.claim_id);
          }
          resultClaimId = activeOnTarget.claim_id;
          return;
        }
        // Different agent → reject
        throw new ClaimConflictError({
          targetRef: claim.targetRef,
          heldByAgentId: activeOnTarget.agent_id,
          heldByClaimId: activeOnTarget.claim_id,
        });
      }

      // No active claim → create new
      const existingId = this.db
        .prepare("SELECT claim_id FROM claims WHERE claim_id = ?")
        .get(claim.claimId) as { claim_id: string } | null;
      if (existingId !== null) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "already exists",
          message: `Claim with id '${claim.claimId}' already exists`,
        });
      }

      this.insertClaimRow(claim, createdAtUtc, heartbeatUtc, leaseExpiresUtc);
    });
    try {
      tx.immediate();
    } catch (err) {
      if (err instanceof Error && err.message.includes("database is locked")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        tx.immediate();
      } else {
        throw err;
      }
    }

    const result = this.readClaim(resultClaimId);
    if (result === null) throw new Error(`Failed to read back claim '${resultClaimId}'`);
    // Renew anchors the lease forward — that IS the lease boundary moving,
    // which the watch protocol cares about, so fire MODIFIED. New insert
    // path fires ADDED.
    this.onClaimWrite?.(didRenew ? "MODIFIED" : "ADDED", result);
    return result;
  };

  getClaim = async (claimId: string): Promise<Claim | undefined> => {
    return this.readClaim(claimId) ?? undefined;
  };

  heartbeat = async (claimId: string, leaseDurationMs?: number): Promise<Claim> => {
    const now = new Date();
    const duration = leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    const newExpiry = new Date(now.getTime() + duration);

    // Atomic UPDATE WHERE: only succeeds if claim is active with valid lease
    const rows = this.db
      .prepare(
        `UPDATE claims
         SET heartbeat_at = ?, lease_expires_at = ?, revision = revision + 1
         WHERE claim_id = ? AND status = 'active' AND lease_expires_at >= ?
         RETURNING ${CLAIM_SELECT_COLS}`,
      )
      .all(
        now.toISOString(),
        newExpiry.toISOString(),
        claimId,
        now.toISOString(),
      ) as readonly ClaimRow[];

    if (rows.length > 0 && rows[0] !== undefined) {
      const claim = rowToClaim(rows[0]);
      // Heartbeat advances heartbeat_at + lease_expires_at + revision; views
      // render the lease deadline from the cached entity, so without firing
      // a MODIFIED write the cache would still show the prior lease and the
      // view would render the claim as expired/stale even though the store
      // is fresh. PR2 (#388) earlier excluded heartbeat to suppress no-op
      // ticks, but the lease fields ARE state changes that consumers depend
      // on — see Codex round-1 finding "Claim heartbeats never update the
      // local watch cache".
      this.onClaimWrite?.("MODIFIED", claim);
      return claim;
    }

    // UPDATE matched nothing — determine why for a specific error message
    const existing = this.readClaim(claimId);
    if (existing === null) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim '${claimId}' not found`,
      });
    }
    if (existing.status !== "active") {
      throw new StateConflictError({
        resource: "Claim",
        reason: `status is '${existing.status}'`,
        message: `Cannot heartbeat claim '${claimId}' with status '${existing.status}' (must be active)`,
      });
    }
    throw new StateConflictError({
      resource: "Claim",
      reason: "lease expired",
      message: `Cannot heartbeat claim '${claimId}': lease expired at ${existing.leaseExpiresAt}`,
    });
  };

  release = async (claimId: string): Promise<Claim> => {
    return this.transitionClaim(claimId, "released" as ClaimStatus);
  };

  complete = async (claimId: string): Promise<Claim> => {
    return this.transitionClaim(claimId, "completed" as ClaimStatus);
  };

  expireStale = async (options?: ExpireStaleOptions): Promise<readonly ExpiredClaim[]> => {
    const now = new Date();
    const nowIso = now.toISOString();

    // Both lease expiry and stall detection run in a single transaction
    // to prevent concurrent heartbeats from landing between the two passes.
    const expireTx = this.db.transaction(() => {
      const results: ExpiredClaim[] = [];

      // Step 1: Expire claims with expired leases
      const leaseExpired = this.db
        .prepare(
          `UPDATE claims SET status = 'expired', revision = revision + 1
           WHERE status = 'active' AND lease_expires_at < ?
           RETURNING ${CLAIM_SELECT_COLS}`,
        )
        .all(nowIso) as readonly ClaimRow[];

      for (const row of leaseExpired) {
        results.push({ claim: rowToClaim(row), reason: ExpiryReason.LeaseExpired });
      }

      // Step 2: Expire stalled agents (heartbeat gap exceeds threshold)
      if (options?.stallThresholdMs !== undefined) {
        const stallCutoff = new Date(now.getTime() - options.stallThresholdMs).toISOString();
        const stalled = this.db
          .prepare(
            `UPDATE claims SET status = 'expired', revision = revision + 1
             WHERE status = 'active' AND heartbeat_at < ?
             RETURNING ${CLAIM_SELECT_COLS}`,
          )
          .all(stallCutoff) as readonly ClaimRow[];

        for (const row of stalled) {
          results.push({ claim: rowToClaim(row), reason: ExpiryReason.Stalled });
        }
      }

      return results;
    });

    const results = expireTx.immediate();
    if (this.onClaimWrite) {
      for (const r of results) this.onClaimWrite("MODIFIED", r.claim);
    }
    return results;
  };

  activeClaims = async (targetRef?: string): Promise<readonly Claim[]> => {
    const now = new Date().toISOString();
    let sql = `SELECT ${CLAIM_SELECT_COLS} FROM claims WHERE status = 'active' AND lease_expires_at >= ?`;
    const params: SQLQueryBindings[] = [now];

    if (targetRef !== undefined) {
      sql += " AND target_ref = ?";
      params.push(targetRef);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly ClaimRow[];
    return rows.map((row) => rowToClaim(row));
  };

  listClaims = async (query?: ClaimQuery): Promise<readonly Claim[]> => {
    let sql = `SELECT ${CLAIM_SELECT_COLS} FROM claims WHERE 1=1`;
    const params: SQLQueryBindings[] = [];

    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      const placeholders = statuses.map(() => "?").join(", ");
      sql += ` AND status IN (${placeholders})`;
      params.push(...statuses);
    }
    if (query?.agentId !== undefined) {
      sql += " AND agent_id = ?";
      params.push(query.agentId);
    }
    if (query?.targetRef !== undefined) {
      sql += " AND target_ref = ?";
      params.push(query.targetRef);
    }
    if (query?.ownerRef !== undefined) {
      sql += " AND owner_ref_json = ?";
      params.push(JSON.stringify(query.ownerRef));
    }

    sql += " ORDER BY created_at DESC";
    const rows = this.db.prepare(sql).all(...params) as readonly ClaimRow[];
    return rows.map((row) => rowToClaim(row));
  };

  releaseOwnedBy = async (ownerRef: OwnerRef): Promise<number> => {
    const nowIso = new Date().toISOString();
    const rows = this.db
      .prepare(
        `UPDATE claims
         SET status = 'released', heartbeat_at = ?, revision = revision + 1
         WHERE status = 'active' AND owner_ref_json = ?
         RETURNING ${CLAIM_SELECT_COLS}`,
      )
      .all(nowIso, JSON.stringify(ownerRef)) as readonly ClaimRow[];

    if (this.onClaimWrite) {
      for (const row of rows) this.onClaimWrite("MODIFIED", rowToClaim(row));
    }
    return rows.length;
  };

  deleteTerminalOwnedBy = async (ownerRef: OwnerRef): Promise<number> => {
    const rows = this.db
      .prepare(
        `DELETE FROM claims
         WHERE status IN ('completed', 'expired', 'released') AND owner_ref_json = ?
         RETURNING ${CLAIM_SELECT_COLS}`,
      )
      .all(JSON.stringify(ownerRef)) as readonly ClaimRow[];

    if (this.onClaimWrite) {
      for (const row of rows) this.onClaimWrite("DELETED", rowToClaim(row));
    }
    return rows.length;
  };

  cleanCompleted = async (retentionMs: number): Promise<number> => {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    // Use heartbeat_at (last activity) as the retention baseline, not created_at.
    // A long-running claim that completed moments ago has a recent heartbeat_at,
    // so it won't be prematurely deleted. An old expired claim whose agent died
    // long ago has a stale heartbeat_at, so it gets cleaned up correctly.
    const result = this.db
      .prepare(
        `DELETE FROM claims
         WHERE status IN ('completed', 'expired', 'released')
         AND heartbeat_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  };

  countActiveClaims = async (filter?: ActiveClaimFilter): Promise<number> => {
    const now = new Date().toISOString();
    let sql =
      "SELECT COUNT(*) as cnt FROM claims WHERE status = 'active' AND lease_expires_at >= ?";
    const params: SQLQueryBindings[] = [now];

    if (filter?.agentId !== undefined) {
      sql += " AND agent_id = ?";
      params.push(filter.agentId);
    }
    if (filter?.targetRef !== undefined) {
      sql += " AND target_ref = ?";
      params.push(filter.targetRef);
    }

    const row = this.db.prepare(sql).get(...params) as { cnt: number } | null;
    return row?.cnt ?? 0;
  };

  detectStalled = async (stallTimeoutMs: number): Promise<readonly Claim[]> => {
    const now = new Date();
    const stallCutoff = new Date(now.getTime() - stallTimeoutMs).toISOString();
    const nowIso = now.toISOString();

    const rows = this.db
      .prepare(
        `SELECT ${CLAIM_SELECT_COLS} FROM claims
         WHERE status = 'active'
           AND lease_expires_at >= ?
           AND heartbeat_at < ?`,
      )
      .all(nowIso, stallCutoff) as readonly ClaimRow[];

    return rows.map((row) => rowToClaim(row));
  };

  async listEntities(query?: ClaimQuery): Promise<readonly ClaimEntity[]> {
    // listEntities semantics: query.status filters on the **effective**
    // (lease-aware) phase, not the raw persisted phase. So we fetch
    // without the status filter, project, and then filter on the
    // projected phase. Consumers that truly want raw persisted phase
    // should call listClaims() directly.
    const baseQuery: ClaimQuery | undefined =
      query === undefined ? undefined : { ...query, status: undefined };
    const items = await this.listClaims(baseQuery);
    const namespace = readStoreNamespace(this.db);
    const entities = items.map((c) => claimToEntity(c, () => Date.now(), namespace));
    if (query?.status === undefined) return entities;
    const wanted = Array.isArray(query.status) ? new Set(query.status) : new Set([query.status]);
    return entities.filter((e) => wanted.has(e.status.phase));
  }

  /**
   * No-op when used via createSqliteStores() — the factory's close() owns the
   * shared Database handle. Calling this will NOT close the underlying DB.
   */
  close(): void {
    // Intentional no-op: DB lifecycle is managed by the factory or SqliteStore facade.
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  private validateClaimContext(claim: Claim): void {
    if (claim.context !== undefined) {
      const result = ContextSchema.safeParse(claim.context);
      if (!result.success) {
        throw new Error(`Invalid claim context: ${result.error.message}`);
      }
    }
  }

  private insertClaimRow(
    claim: Claim,
    createdAtUtc: string,
    heartbeatUtc: string,
    leaseExpiresUtc: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO claims (claim_id, target_ref, agent_id, status, intent_summary,
         created_at, heartbeat_at, lease_expires_at, context_json, owner_ref_json,
         finalizers_json, deletion_timestamp, agent_json, attempt_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        claim.claimId,
        claim.targetRef,
        claim.agent.agentId,
        claim.status,
        claim.intentSummary,
        createdAtUtc,
        heartbeatUtc,
        leaseExpiresUtc,
        claim.context !== undefined ? JSON.stringify(claim.context) : null,
        claim.ownerRef !== undefined ? JSON.stringify(claim.ownerRef) : null,
        JSON.stringify(claim.finalizers ?? []),
        claim.deletionTimestamp ?? null,
        JSON.stringify(claim.agent),
        claim.attemptCount ?? 0,
      );
  }

  private readClaim(claimId: string): Claim | null {
    const row = this.stmtGetClaim.get(claimId) as ClaimRow | null;
    if (row === null) return null;
    return rowToClaim(row);
  }

  private transitionClaim(claimId: string, newStatus: ClaimStatus): Claim {
    // Atomic UPDATE WHERE: only succeeds if claim is currently active
    // AND the lease has not expired. Rejecting lease-expired transitions
    // prevents a stale claimant from releasing/completing a claim whose
    // target lock may already belong to another agent (finding: Codex
    // round-3 one-active-claim-per-target invariant).
    const nowIso = new Date().toISOString();
    const rows = this.db
      .prepare(
        `UPDATE claims SET status = ?, revision = revision + 1
         WHERE claim_id = ? AND status = 'active' AND lease_expires_at >= ?
         RETURNING ${CLAIM_SELECT_COLS}`,
      )
      .all(newStatus, claimId, nowIso) as readonly ClaimRow[];

    if (rows.length > 0 && rows[0] !== undefined) {
      const claim = rowToClaim(rows[0]);
      this.onClaimWrite?.("MODIFIED", claim);
      return claim;
    }

    // UPDATE matched nothing — determine why
    const existing = this.readClaim(claimId);
    if (existing === null) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim '${claimId}' not found`,
      });
    }
    if (existing.status !== "active") {
      throw new StateConflictError({
        resource: "Claim",
        reason: `status is '${existing.status}'`,
        message: `Cannot transition claim '${claimId}' from '${existing.status}' to '${newStatus}' (must be active)`,
      });
    }
    throw new StateConflictError({
      resource: "Claim",
      reason: "lease expired",
      message: `Cannot ${newStatus === "completed" ? "complete" : "release"} claim '${claimId}': lease expired at ${existing.leaseExpiresAt}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Legacy convenience class (backwards-compatible)
// ---------------------------------------------------------------------------

/**
 * Combined-facade store backed by a single SQLite file.
 *
 * **Type contract changed in #287.** The facade now formally implements
 * `ContributionStore` only. It exposes the split sub-stores as public
 * readonly properties (`store.contributions`, `store.claims`) for callers
 * that need a kind-specific interface:
 *
 * ```ts
 * const store = new SqliteStore(dbPath);
 *
 * // Works — SqliteStore satisfies ContributionStore:
 * const cs: ContributionStore = store;
 *
 * // Does NOT typecheck anymore — use store.claims instead:
 * // const csm: ClaimStore = store;                     // error
 * const csm: ClaimStore = store.claims;                 // correct
 * ```
 *
 * Why: `ContributionStore.listEntities()` and `ClaimStore.listEntities()`
 * share a method name but return different `Entity` kinds. A combined
 * facade that implements both cannot dispatch a bare `listEntities()`
 * call unambiguously. The split sub-stores each have a single, well-typed
 * `listEntities()`. All other ClaimStore methods (createClaim, heartbeat,
 * release, complete, …) remain available on the facade for convenience.
 *
 * Prefer `createSqliteStores(dbPath)` for new code — it returns a
 * `{ contributionStore, claimStore, close }` bundle directly.
 */
export class SqliteStore implements ContributionStore {
  readonly storeIdentity: string;
  readonly dbPath: string;
  private readonly db: Database;
  /**
   * Split sub-stores exposed publicly so callers that want a clean
   * `ClaimStore` (unambiguous `listEntities()`) can reach for
   * `store.claims` rather than treating this facade as a `ClaimStore`.
   * The facade itself formally implements only `ContributionStore` so
   * that `listEntities()` has a single, unambiguous kind.
   */
  readonly contributions: SqliteContributionStore;
  readonly claims: SqliteClaimStore;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = initSqliteDb(dbPath);
    this.storeIdentity = this.db.filename;
    this.contributions = new SqliteContributionStore(this.db);
    this.claims = new SqliteClaimStore(this.db);
  }

  // ContributionStore delegation
  put = (contribution: Contribution): Promise<ContributionPutResult> =>
    this.contributions.put(contribution);
  putMany = (contributions: readonly Contribution[]): Promise<readonly ContributionPutResult[]> =>
    this.contributions.putMany(contributions);
  get = (cid: string): Promise<Contribution | undefined> => this.contributions.get(cid);
  getByContentHash = (contentHash: string): Promise<Contribution | undefined> =>
    this.contributions.getByContentHash(contentHash);
  getMany = (cids: readonly string[]): Promise<ReadonlyMap<string, Contribution>> =>
    this.contributions.getMany(cids);
  list = (query?: ContributionQuery): Promise<readonly Contribution[]> =>
    this.contributions.list(query);
  children = (cid: string): Promise<readonly Contribution[]> => this.contributions.children(cid);
  incomingSources = (targetCids: readonly string[]): Promise<readonly Contribution[]> =>
    this.contributions.incomingSources(targetCids);
  ancestors = (cid: string): Promise<readonly Contribution[]> => this.contributions.ancestors(cid);
  relationsOf = (cid: string, relationType?: RelationType): Promise<readonly Relation[]> =>
    this.contributions.relationsOf(cid, relationType);
  relatedTo = (cid: string, relationType?: RelationType): Promise<readonly Contribution[]> =>
    this.contributions.relatedTo(cid, relationType);
  search = (query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> =>
    this.contributions.search(query, filters);
  findExisting = (
    agentId: string,
    targetCid: string,
    kind: ContributionKind,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> =>
    this.contributions.findExisting(agentId, targetCid, kind, relationType);
  count = (query?: ContributionQuery): Promise<number> => this.contributions.count(query);
  countSince = (query: { agentId?: string; since: string }): Promise<number> =>
    this.contributions.countSince(query);
  thread = (
    rootCid: string,
    opts?: { readonly maxDepth?: number; readonly limit?: number },
  ): Promise<readonly ThreadNode[]> => this.contributions.thread(rootCid, opts);
  replyCounts = (cids: readonly string[]): Promise<ReadonlyMap<string, number>> =>
    this.contributions.replyCounts(cids);
  hotThreads = (opts?: HotThreadsOptions): Promise<readonly ThreadSummary[]> =>
    this.contributions.hotThreads(opts);

  // ClaimStore delegation
  createClaim = (claim: Claim): Promise<Claim> => this.claims.createClaim(claim);
  claimOrRenew = (claim: Claim): Promise<Claim> => this.claims.claimOrRenew(claim);
  getClaim = (claimId: string): Promise<Claim | undefined> => this.claims.getClaim(claimId);
  heartbeat = (claimId: string, leaseDurationMs?: number): Promise<Claim> =>
    this.claims.heartbeat(claimId, leaseDurationMs);
  release = (claimId: string): Promise<Claim> => this.claims.release(claimId);
  releaseOwnedBy = (ownerRef: OwnerRef): Promise<number> => this.claims.releaseOwnedBy(ownerRef);
  complete = (claimId: string): Promise<Claim> => this.claims.complete(claimId);
  deleteTerminalOwnedBy = (ownerRef: OwnerRef): Promise<number> =>
    this.claims.deleteTerminalOwnedBy(ownerRef);
  expireStale = (options?: ExpireStaleOptions): Promise<readonly ExpiredClaim[]> =>
    this.claims.expireStale(options);
  activeClaims = (targetRef?: string): Promise<readonly Claim[]> =>
    this.claims.activeClaims(targetRef);
  listClaims = (query?: ClaimQuery): Promise<readonly Claim[]> => this.claims.listClaims(query);
  cleanCompleted = (retentionMs: number): Promise<number> =>
    this.claims.cleanCompleted(retentionMs);
  countActiveClaims = (filter?: ActiveClaimFilter): Promise<number> =>
    this.claims.countActiveClaims(filter);
  detectStalled = (stallTimeoutMs: number): Promise<readonly Claim[]> =>
    this.claims.detectStalled(stallTimeoutMs);

  /**
   * ContributionStore.listEntities — delegates to the contribution sub-store.
   *
   * The facade no longer tries to service ClaimStore.listEntities through
   * the same method (see class docstring): callers that need claim
   * entities should use `store.claims.listEntities(...)` explicitly,
   * which has a single, well-typed signature.
   */
  listEntities(query?: ContributionQuery): Promise<readonly ContributionEntity[]> {
    return this.contributions.listEntities(query);
  }

  close(): void {
    this.db.close();
  }
}
