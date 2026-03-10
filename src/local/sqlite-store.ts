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
  JsonValue,
  Relation,
  RelationType,
} from "../core/models.js";
import type { ClaimStore, ContributionQuery, ContributionStore } from "../core/store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LEASE_DURATION_MS = 300_000;
const CURRENT_SCHEMA_VERSION = 2;

/**
 * Normalize an ISO 8601 timestamp to UTC Z-format.
 * SQL text comparison of timestamps only works reliably when
 * all values use the same format (no timezone offsets).
 */
function toUtcIso(iso: string): string {
  return new Date(iso).toISOString();
}

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
    manifest_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_contributions_kind ON contributions(kind);
  CREATE INDEX IF NOT EXISTS idx_contributions_mode ON contributions(mode);
  CREATE INDEX IF NOT EXISTS idx_contributions_agent ON contributions(agent_id);
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
    agent_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_claims_target ON claims(target_ref);
  CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
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

  // IMMEDIATE transaction for schema init — acquires write lock upfront
  // so concurrent openers wait via busy_timeout instead of failing.
  const initSchema = db.transaction(() => {
    db.exec(SCHEMA_DDL);
    db.exec(FTS_DDL);

    // Check current schema version for migrations
    const currentVersion = (
      db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as {
        v: number | null;
      }
    ).v;

    // Migration v1 → v2: add created_at and context_json to claims
    if (currentVersion !== null && currentVersion < 2) {
      // Check if columns already exist (idempotent migration)
      const columns = db.prepare("PRAGMA table_info(claims)").all() as readonly {
        name: string;
      }[];
      const columnNames = new Set(columns.map((c) => c.name));

      if (!columnNames.has("created_at")) {
        // Default created_at to heartbeat_at for existing claims
        db.run("ALTER TABLE claims ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
        db.run("UPDATE claims SET created_at = heartbeat_at WHERE created_at = ''");
      }
      if (!columnNames.has("context_json")) {
        db.run("ALTER TABLE claims ADD COLUMN context_json TEXT");
      }
    }

    db.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      CURRENT_SCHEMA_VERSION,
      new Date().toISOString(),
    ]);

    // Backfill junction tables for pre-existing contributions.
    // INSERT OR IGNORE prevents duplicates when the tables already have rows.
    db.run(`
      INSERT OR IGNORE INTO contribution_tags (cid, tag)
      SELECT c.cid, j.value
      FROM contributions c, json_each(c.tags_json) j
      WHERE NOT EXISTS (
        SELECT 1 FROM contribution_tags ct WHERE ct.cid = c.cid
      )
    `);
    db.run(`
      INSERT OR IGNORE INTO artifacts (contribution_cid, name, content_hash)
      SELECT c.cid, j.key, j.value
      FROM contributions c, json_each(json_extract(c.manifest_json, '$.artifacts')) j
      WHERE NOT EXISTS (
        SELECT 1 FROM artifacts a WHERE a.contribution_cid = c.cid
      )
    `);
  });
  initSchema.immediate();

  return db;
}

/**
 * Convenience factory that creates a shared Database and returns both stores.
 * The returned close() disposes the database connection.
 */
export function createSqliteStores(dbPath: string): {
  contributionStore: SqliteContributionStore;
  claimStore: SqliteClaimStore;
  close: () => void;
} {
  const db = initSqliteDb(dbPath);
  return {
    contributionStore: new SqliteContributionStore(db),
    claimStore: new SqliteClaimStore(db),
    close: () => db.close(),
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

  // Tag filtering via junction table — contribution must have ALL queried tags
  if (query?.tags !== undefined && query.tags.length > 0) {
    for (const tag of query.tags) {
      conditions.push(
        "EXISTS (SELECT 1 FROM contribution_tags ct WHERE ct.cid = c.cid AND ct.tag = ?)",
      );
      params.push(tag);
    }
  }

  let sql = baseSelect;
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (orderBy !== undefined) {
    sql += ` ORDER BY ${orderBy}`;
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

/** Deserialize a manifest_json row into a Contribution, verifying CID integrity. */
function rowToContribution(row: { manifest_json: string }): Contribution {
  return fromManifest(JSON.parse(row.manifest_json) as unknown);
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
  readonly agent_json: string;
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
  private readonly db: Database;

  // Cached prepared statements for fixed queries
  private readonly stmtGetByCid: Statement;
  private readonly stmtInsertContribution: Statement;
  private readonly stmtInsertRelation: Statement;
  private readonly stmtInsertFts: Statement;
  private readonly stmtInsertTag: Statement;
  private readonly stmtInsertArtifact: Statement;
  private readonly stmtChildren: Statement;
  private readonly stmtAncestors: Statement;

  constructor(db: Database) {
    this.db = db;

    this.stmtGetByCid = db.query("SELECT manifest_json FROM contributions WHERE cid = ?");
    this.stmtInsertContribution = db.query(
      `INSERT OR IGNORE INTO contributions (cid, kind, mode, summary, description,
       agent_id, agent_name, created_at, tags_json, manifest_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  put = async (contribution: Contribution): Promise<void> => {
    this.putSync(contribution);
  };

  putMany = async (contributions: readonly Contribution[]): Promise<void> => {
    const tx = this.db.transaction(() => {
      for (const c of contributions) {
        this.putSync(c);
      }
    });
    tx();
  };

  get = async (cid: string): Promise<Contribution | undefined> => {
    const row = this.stmtGetByCid.get(cid) as { manifest_json: string } | null;
    if (row === null) return undefined;
    return rowToContribution(row);
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

  count = async (query?: ContributionQuery): Promise<number> => {
    const { sql, params } = buildFilteredQuery({
      baseSelect: "SELECT COUNT(*) as cnt FROM contributions c",
      query,
    });
    const row = this.db.prepare(sql).get(...params) as { cnt: number } | null;
    return row?.cnt ?? 0;
  };

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

  /** Synchronous put — uses INSERT OR IGNORE for atomic idempotency. */
  private putSync(contribution: Contribution): void {
    // Verify CID integrity before persisting
    if (!verifyCid(contribution)) {
      throw new Error(
        `CID integrity check failed for '${contribution.cid}': CID does not match manifest content`,
      );
    }

    const manifestJson = JSON.stringify(toManifest(contribution));
    const tagsJson = JSON.stringify(contribution.tags);

    const tx = this.db.transaction(() => {
      // INSERT OR IGNORE: if CID already exists, this is a no-op
      const result = this.stmtInsertContribution.run(
        contribution.cid,
        contribution.kind,
        contribution.mode,
        contribution.summary,
        contribution.description ?? null,
        contribution.agent.agentId,
        contribution.agent.agentName ?? null,
        contribution.createdAt,
        tagsJson,
        manifestJson,
      );

      // If no row was inserted (duplicate CID), skip relations/FTS/tags/artifacts
      if (result.changes === 0) return;

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
      this.stmtInsertFts.run(
        contribution.cid,
        contribution.summary,
        contribution.description ?? "",
      );

      // Insert tags into junction table
      for (const tag of contribution.tags) {
        this.stmtInsertTag.run(contribution.cid, tag);
      }

      // Insert artifact references into junction table
      for (const [name, contentHash] of Object.entries(contribution.artifacts)) {
        this.stmtInsertArtifact.run(contribution.cid, name, contentHash);
      }
    });
    tx();
  }
}

// ---------------------------------------------------------------------------
// SqliteClaimStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed ClaimStore with lease-based coordination.
 *
 * Uses EXCLUSIVE transactions for claim creation and UPDATE RETURNING
 * for atomic expiry.
 */
export class SqliteClaimStore implements ClaimStore {
  private readonly db: Database;

  // Cached prepared statements
  private readonly stmtGetClaim: Statement;
  private readonly stmtUpdateHeartbeat: Statement;
  private readonly stmtTransition: Statement;

  constructor(db: Database) {
    this.db = db;

    this.stmtGetClaim = db.query(
      `SELECT claim_id, target_ref, agent_id, status, intent_summary,
       created_at, heartbeat_at, lease_expires_at, context_json, agent_json
       FROM claims WHERE claim_id = ?`,
    );
    this.stmtUpdateHeartbeat = db.query(
      "UPDATE claims SET heartbeat_at = ?, lease_expires_at = ? WHERE claim_id = ?",
    );
    this.stmtTransition = db.query("UPDATE claims SET status = ? WHERE claim_id = ?");
  }

  createClaim = async (claim: Claim): Promise<Claim> => {
    // Validate context values are JSON-safe (reject Date, Map, Set, etc.)
    if (claim.context !== undefined) {
      const result = ContextSchema.safeParse(claim.context);
      if (!result.success) {
        throw new Error(`Invalid claim context: ${result.error.message}`);
      }
    }

    // Normalize timestamps to UTC for reliable SQL text comparison
    const createdAtUtc = toUtcIso(claim.createdAt);
    const heartbeatUtc = toUtcIso(claim.heartbeatAt);
    const leaseExpiresUtc = toUtcIso(claim.leaseExpiresAt);

    // Atomic check-and-insert: EXCLUSIVE transaction prevents TOCTOU races
    const createTx = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT claim_id FROM claims WHERE claim_id = ?")
        .get(claim.claimId) as { claim_id: string } | null;

      if (existing !== null) {
        throw new Error(`Claim with id '${claim.claimId}' already exists`);
      }

      // Prevent duplicate active claims on the same target
      const now = new Date().toISOString();
      const activeOnTarget = this.db
        .prepare(
          "SELECT claim_id FROM claims WHERE target_ref = ? AND status = 'active' AND lease_expires_at >= ?",
        )
        .get(claim.targetRef, now) as { claim_id: string } | null;

      if (activeOnTarget !== null) {
        throw new Error(
          `Target '${claim.targetRef}' already has an active claim '${activeOnTarget.claim_id}'`,
        );
      }

      this.db
        .prepare(
          `INSERT INTO claims (claim_id, target_ref, agent_id, status, intent_summary,
           created_at, heartbeat_at, lease_expires_at, context_json, agent_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(claim.agent),
        );
    });
    createTx.exclusive();

    const created = this.readClaim(claim.claimId);
    if (created === null) throw new Error(`Failed to read back claim '${claim.claimId}'`);
    return created;
  };

  getClaim = async (claimId: string): Promise<Claim | undefined> => {
    return this.readClaim(claimId) ?? undefined;
  };

  heartbeat = async (claimId: string, leaseDurationMs?: number): Promise<Claim> => {
    const existing = this.readClaim(claimId);
    if (existing === null) {
      throw new Error(`Claim '${claimId}' not found`);
    }
    if (existing.status !== "active") {
      throw new Error(
        `Cannot heartbeat claim '${claimId}' with status '${existing.status}' (must be active)`,
      );
    }

    const now = new Date();

    // Reject heartbeat if lease has already expired
    if (new Date(existing.leaseExpiresAt).getTime() < now.getTime()) {
      throw new Error(
        `Cannot heartbeat claim '${claimId}': lease expired at ${existing.leaseExpiresAt}`,
      );
    }
    const duration = leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    const newExpiry = new Date(now.getTime() + duration);

    this.stmtUpdateHeartbeat.run(now.toISOString(), newExpiry.toISOString(), claimId);

    const updated = this.readClaim(claimId);
    if (updated === null) throw new Error(`Failed to read back claim '${claimId}'`);
    return updated;
  };

  release = async (claimId: string): Promise<Claim> => {
    return this.transitionClaim(claimId, "released" as ClaimStatus);
  };

  complete = async (claimId: string): Promise<Claim> => {
    return this.transitionClaim(claimId, "completed" as ClaimStatus);
  };

  expireStale = async (): Promise<readonly Claim[]> => {
    const now = new Date().toISOString();

    // Atomic UPDATE ... RETURNING — no SELECT-then-UPDATE race window
    const rows = this.db
      .prepare(
        `UPDATE claims SET status = 'expired'
         WHERE status = 'active' AND lease_expires_at < ?
         RETURNING claim_id, target_ref, agent_id, status, intent_summary,
                   created_at, heartbeat_at, lease_expires_at, context_json, agent_json`,
      )
      .all(now) as readonly ClaimRow[];

    return rows.map((row) => rowToClaim(row));
  };

  activeClaims = async (targetRef?: string): Promise<readonly Claim[]> => {
    const now = new Date().toISOString();
    let sql = `
      SELECT claim_id, target_ref, agent_id, status, intent_summary,
             created_at, heartbeat_at, lease_expires_at, context_json, agent_json
      FROM claims WHERE status = 'active' AND lease_expires_at >= ?
    `;
    const params: SQLQueryBindings[] = [now];

    if (targetRef !== undefined) {
      sql += " AND target_ref = ?";
      params.push(targetRef);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly ClaimRow[];
    return rows.map((row) => rowToClaim(row));
  };

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

  private readClaim(claimId: string): Claim | null {
    const row = this.stmtGetClaim.get(claimId) as ClaimRow | null;
    if (row === null) return null;
    return rowToClaim(row);
  }

  private transitionClaim(claimId: string, newStatus: ClaimStatus): Claim {
    const existing = this.readClaim(claimId);
    if (existing === null) {
      throw new Error(`Claim '${claimId}' not found`);
    }
    if (existing.status !== "active") {
      throw new Error(
        `Cannot transition claim '${claimId}' from '${existing.status}' to '${newStatus}' (must be active)`,
      );
    }

    this.stmtTransition.run(newStatus, claimId);

    const updated = this.readClaim(claimId);
    if (updated === null) throw new Error(`Failed to read back claim '${claimId}'`);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Legacy convenience class (backwards-compatible)
// ---------------------------------------------------------------------------

/**
 * Combined store that implements both ContributionStore and ClaimStore.
 *
 * Delegates to SqliteContributionStore and SqliteClaimStore internally.
 * Provided for backwards compatibility — prefer createSqliteStores() for
 * new code.
 */
export class SqliteStore implements ContributionStore, ClaimStore {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly contributions: SqliteContributionStore;
  private readonly claims: SqliteClaimStore;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = initSqliteDb(dbPath);
    this.contributions = new SqliteContributionStore(this.db);
    this.claims = new SqliteClaimStore(this.db);
  }

  // ContributionStore delegation
  put = (contribution: Contribution): Promise<void> => this.contributions.put(contribution);
  putMany = (contributions: readonly Contribution[]): Promise<void> =>
    this.contributions.putMany(contributions);
  get = (cid: string): Promise<Contribution | undefined> => this.contributions.get(cid);
  list = (query?: ContributionQuery): Promise<readonly Contribution[]> =>
    this.contributions.list(query);
  children = (cid: string): Promise<readonly Contribution[]> => this.contributions.children(cid);
  ancestors = (cid: string): Promise<readonly Contribution[]> => this.contributions.ancestors(cid);
  relationsOf = (cid: string, relationType?: RelationType): Promise<readonly Relation[]> =>
    this.contributions.relationsOf(cid, relationType);
  relatedTo = (cid: string, relationType?: RelationType): Promise<readonly Contribution[]> =>
    this.contributions.relatedTo(cid, relationType);
  search = (query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> =>
    this.contributions.search(query, filters);
  count = (query?: ContributionQuery): Promise<number> => this.contributions.count(query);

  // ClaimStore delegation
  createClaim = (claim: Claim): Promise<Claim> => this.claims.createClaim(claim);
  getClaim = (claimId: string): Promise<Claim | undefined> => this.claims.getClaim(claimId);
  heartbeat = (claimId: string, leaseDurationMs?: number): Promise<Claim> =>
    this.claims.heartbeat(claimId, leaseDurationMs);
  release = (claimId: string): Promise<Claim> => this.claims.release(claimId);
  complete = (claimId: string): Promise<Claim> => this.claims.complete(claimId);
  expireStale = (): Promise<readonly Claim[]> => this.claims.expireStale();
  activeClaims = (targetRef?: string): Promise<readonly Claim[]> =>
    this.claims.activeClaims(targetRef);

  close(): void {
    this.db.close();
  }
}
