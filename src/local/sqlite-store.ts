/**
 * SQLite-backed contribution graph store.
 *
 * Uses Bun's built-in bun:sqlite for zero-dependency local storage.
 * Implements both ContributionStore and ClaimStore protocols.
 *
 * Schema uses a hybrid approach: materialized columns for indexed queries
 * plus full JSON manifest for round-trip fidelity. FTS5 provides full-text
 * search on summary and description fields.
 */

import type { SQLQueryBindings } from "bun:sqlite";
import { Database } from "bun:sqlite";

import { fromManifest, toManifest, verifyCid } from "../core/manifest.js";
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

const DEFAULT_LEASE_DURATION_MS = 60_000;
const CURRENT_SCHEMA_VERSION = 1;

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
    heartbeat_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    intent_summary TEXT NOT NULL,
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
// Helper: build WHERE clause from ContributionQuery
// ---------------------------------------------------------------------------

interface WhereClause {
  readonly conditions: string[];
  readonly params: SQLQueryBindings[];
}

function buildWhereClause(query?: ContributionQuery): WhereClause {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

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

  return { conditions, params };
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed store for contributions, relations, and claims.
 *
 * Provides both ContributionStore and ClaimStore interfaces with
 * WAL mode, prepared statements, and FTS5 full-text search.
 */
export class SqliteStore implements ContributionStore, ClaimStore {
  readonly dbPath: string;
  private readonly db: Database;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);

    // busy_timeout MUST be set before any potentially contentious operation.
    // This ensures concurrent opens wait rather than fail immediately.
    this.db.run("PRAGMA busy_timeout = 5000");

    // Only switch to WAL if not already enabled — avoids contention when
    // another process already set WAL mode on this database file.
    const mode = (this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
      .journal_mode;
    if (mode !== "wal") {
      this.db.run("PRAGMA journal_mode = WAL");
    }

    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");

    // IMMEDIATE transaction for schema init — acquires write lock upfront
    // so concurrent openers wait via busy_timeout instead of failing.
    const initSchema = this.db.transaction(() => {
      this.db.exec(SCHEMA_DDL);
      this.db.exec(FTS_DDL);
      this.db.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        CURRENT_SCHEMA_VERSION,
        new Date().toISOString(),
      ]);
    });
    initSchema.immediate();
  }

  // ========================================================================
  // ContributionStore
  // ========================================================================

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
    return this.getSync(cid);
  };

  list = async (query?: ContributionQuery): Promise<readonly Contribution[]> => {
    const { conditions, params } = buildWhereClause(query);
    const allParams: SQLQueryBindings[] = [...params];

    // Handle tags filter — contribution must have ALL queried tags
    if (query?.tags !== undefined && query.tags.length > 0) {
      for (const tag of query.tags) {
        conditions.push("EXISTS (SELECT 1 WHERE instr(c.tags_json, json_quote(?)) > 0)");
        allParams.push(tag);
      }
    }

    let sql = "SELECT c.manifest_json FROM contributions c";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY c.created_at ASC";

    if (query?.limit !== undefined) {
      sql += " LIMIT ?";
      allParams.push(query.limit);
    }
    if (query?.offset !== undefined) {
      if (query?.limit === undefined) {
        sql += " LIMIT -1";
      }
      sql += " OFFSET ?";
      allParams.push(query.offset);
    }

    const rows = this.db.prepare(sql).all(...allParams) as readonly { manifest_json: string }[];
    return rows.map((row) => fromManifest(JSON.parse(row.manifest_json) as unknown));
  };

  children = async (cid: string): Promise<readonly Contribution[]> => {
    // Children: contributions that have a relation pointing TO this CID
    const sql = `
      SELECT DISTINCT c.manifest_json FROM contributions c
      INNER JOIN relations r ON r.source_cid = c.cid
      WHERE r.target_cid = ?
    `;
    const rows = this.db.prepare(sql).all(cid) as readonly { manifest_json: string }[];
    return rows.map((row) => fromManifest(JSON.parse(row.manifest_json) as unknown));
  };

  ancestors = async (cid: string): Promise<readonly Contribution[]> => {
    // Ancestors: contributions that this CID's relations point to
    const sql = `
      SELECT DISTINCT c.manifest_json FROM contributions c
      INNER JOIN relations r ON r.target_cid = c.cid
      WHERE r.source_cid = ?
    `;
    const rows = this.db.prepare(sql).all(cid) as readonly { manifest_json: string }[];
    return rows.map((row) => fromManifest(JSON.parse(row.manifest_json) as unknown));
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
    return rows.map((row) => fromManifest(JSON.parse(row.manifest_json) as unknown));
  };

  search = async (query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> => {
    const { conditions, params } = buildWhereClause(filters);
    const allParams: SQLQueryBindings[] = [];

    // FTS5 query: match on summary and description columns
    // Escape special FTS5 characters by quoting the search term
    const ftsQuery = `"${query.replace(/"/g, '""')}"`;

    let sql = `
      SELECT c.manifest_json FROM contributions c
      INNER JOIN contributions_fts fts ON fts.cid = c.cid
      WHERE contributions_fts MATCH ?
    `;
    allParams.push(ftsQuery);

    if (conditions.length > 0) {
      sql += ` AND ${conditions.join(" AND ")}`;
      allParams.push(...params);
    }

    // Handle tags filter
    if (filters?.tags !== undefined && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        sql += " AND EXISTS (SELECT 1 WHERE instr(c.tags_json, json_quote(?)) > 0)";
        allParams.push(tag);
      }
    }

    if (filters?.limit !== undefined) {
      sql += " LIMIT ?";
      allParams.push(filters.limit);
    }
    if (filters?.offset !== undefined) {
      if (filters?.limit === undefined) {
        sql += " LIMIT -1";
      }
      sql += " OFFSET ?";
      allParams.push(filters.offset);
    }

    const rows = this.db.prepare(sql).all(...allParams) as readonly { manifest_json: string }[];
    return rows.map((row) => fromManifest(JSON.parse(row.manifest_json) as unknown));
  };

  count = async (query?: ContributionQuery): Promise<number> => {
    const { conditions, params } = buildWhereClause(query);
    const allParams: SQLQueryBindings[] = [...params];

    if (query?.tags !== undefined && query.tags.length > 0) {
      for (const tag of query.tags) {
        conditions.push("EXISTS (SELECT 1 WHERE instr(c.tags_json, json_quote(?)) > 0)");
        allParams.push(tag);
      }
    }

    let sql = "SELECT COUNT(*) as cnt FROM contributions c";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    const row = this.db.prepare(sql).get(...allParams) as { cnt: number } | null;
    return row?.cnt ?? 0;
  };

  // ========================================================================
  // ClaimStore
  // ========================================================================

  createClaim = async (claim: Claim): Promise<Claim> => {
    // Normalize timestamps to UTC for reliable SQL text comparison
    const heartbeatUtc = toUtcIso(claim.heartbeatAt);
    const leaseExpiresUtc = toUtcIso(claim.leaseExpiresAt);

    // Atomic check-and-insert: IMMEDIATE transaction prevents TOCTOU races
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
          `INSERT INTO claims (claim_id, target_ref, agent_id, status, heartbeat_at,
           lease_expires_at, intent_summary, agent_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claim.claimId,
          claim.targetRef,
          claim.agent.agentId,
          claim.status,
          heartbeatUtc,
          leaseExpiresUtc,
          claim.intentSummary,
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

    this.db
      .prepare("UPDATE claims SET heartbeat_at = ?, lease_expires_at = ? WHERE claim_id = ?")
      .run(now.toISOString(), newExpiry.toISOString(), claimId);

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

    // Find stale claims first
    const staleRows = this.db
      .prepare(
        `SELECT claim_id, target_ref, agent_id, status, heartbeat_at,
         lease_expires_at, intent_summary, agent_json
         FROM claims WHERE status = 'active' AND lease_expires_at < ?`,
      )
      .all(now) as readonly ClaimRow[];

    if (staleRows.length === 0) {
      return [];
    }

    // Update them
    this.db
      .prepare(
        "UPDATE claims SET status = 'expired' WHERE status = 'active' AND lease_expires_at < ?",
      )
      .run(now);

    // Return the now-expired claims
    return staleRows.map((row) => rowToClaim(row, "expired" as ClaimStatus));
  };

  activeClaims = async (targetRef?: string): Promise<readonly Claim[]> => {
    const now = new Date().toISOString();
    let sql = `
      SELECT claim_id, target_ref, agent_id, status, heartbeat_at,
             lease_expires_at, intent_summary, agent_json
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

  // ========================================================================
  // Lifecycle
  // ========================================================================

  close(): void {
    this.db.close();
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /** Synchronous put — used internally, wrapped by put() and putMany(). */
  private putSync(contribution: Contribution): void {
    // Check if already exists (idempotent)
    const existing = this.db
      .prepare("SELECT cid FROM contributions WHERE cid = ?")
      .get(contribution.cid) as { cid: string } | null;

    if (existing !== null) {
      return;
    }

    // Verify CID integrity before persisting
    if (!verifyCid(contribution)) {
      throw new Error(
        `CID integrity check failed for '${contribution.cid}': CID does not match manifest content`,
      );
    }

    const manifestJson = JSON.stringify(toManifest(contribution));
    const tagsJson = JSON.stringify(contribution.tags);

    const tx = this.db.transaction(() => {
      // Insert main contribution row
      this.db
        .prepare(
          `INSERT INTO contributions (cid, kind, mode, summary, description,
           agent_id, agent_name, created_at, tags_json, manifest_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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

      // Insert relations
      for (const rel of contribution.relations) {
        this.db
          .prepare(
            `INSERT INTO relations (source_cid, target_cid, relation_type, metadata_json)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            contribution.cid,
            rel.targetCid,
            rel.relationType,
            rel.metadata !== undefined ? JSON.stringify(rel.metadata) : null,
          );
      }

      // Insert into FTS index
      this.db
        .prepare("INSERT INTO contributions_fts (cid, summary, description) VALUES (?, ?, ?)")
        .run(contribution.cid, contribution.summary, contribution.description ?? "");
    });
    tx();
  }

  /** Synchronous get — reads manifest_json and reconstructs via fromManifest. */
  private getSync(cid: string): Contribution | undefined {
    const row = this.db
      .prepare("SELECT manifest_json FROM contributions WHERE cid = ?")
      .get(cid) as { manifest_json: string } | null;

    if (row === null) {
      return undefined;
    }

    return fromManifest(JSON.parse(row.manifest_json) as unknown);
  }

  /** Read a claim row and convert to a Claim object. */
  private readClaim(claimId: string): Claim | null {
    const row = this.db
      .prepare(
        `SELECT claim_id, target_ref, agent_id, status, heartbeat_at,
         lease_expires_at, intent_summary, agent_json
         FROM claims WHERE claim_id = ?`,
      )
      .get(claimId) as ClaimRow | null;

    if (row === null) {
      return null;
    }

    return rowToClaim(row);
  }

  /** Transition a claim to a new status. Throws if not active. */
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

    this.db.prepare("UPDATE claims SET status = ? WHERE claim_id = ?").run(newStatus, claimId);

    const updated = this.readClaim(claimId);
    if (updated === null) throw new Error(`Failed to read back claim '${claimId}'`);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Row types and converters
// ---------------------------------------------------------------------------

interface ClaimRow {
  readonly claim_id: string;
  readonly target_ref: string;
  readonly agent_id: string;
  readonly status: string;
  readonly heartbeat_at: string;
  readonly lease_expires_at: string;
  readonly intent_summary: string;
  readonly agent_json: string;
}

function rowToClaim(row: ClaimRow, statusOverride?: ClaimStatus): Claim {
  return {
    claimId: row.claim_id,
    targetRef: row.target_ref,
    agent: JSON.parse(row.agent_json) as AgentIdentity,
    status: (statusOverride ?? row.status) as ClaimStatus,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    intentSummary: row.intent_summary,
  };
}
