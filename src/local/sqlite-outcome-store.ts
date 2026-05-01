/**
 * SQLite-backed OutcomeStore implementation.
 *
 * Stores outcome records in a dedicated `outcomes` table, separate
 * from contributions. Uses Bun's built-in bun:sqlite.
 */

import type { Database, Statement } from "bun:sqlite";
import { computeOutcomeContentHash } from "../core/content-dedup.js";
import type {
  OutcomeInput,
  OutcomeQuery,
  OutcomeRecord,
  OutcomeStats,
  OutcomeStore,
} from "../core/outcome.js";

/** DDL for the outcomes table. Exported for use in schema initialization. */
export const OUTCOME_DDL = `
  CREATE TABLE IF NOT EXISTS outcomes (
    cid TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    reason TEXT,
    baseline_cid TEXT,
    content_hash TEXT,
    evaluated_at TEXT NOT NULL,
    evaluated_by TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_outcomes_status ON outcomes(status);
  CREATE INDEX IF NOT EXISTS idx_outcomes_evaluated_by ON outcomes(evaluated_by);
`;

const SQLITE_BIND_LIMIT = 900;

/** SQLite-backed OutcomeStore. */
export class SqliteOutcomeStore implements OutcomeStore {
  private readonly db: Database;
  private readonly stmtUpsert: Statement;
  private readonly stmtGet: Statement;
  private readonly stmtGetByContentHash: Statement;
  private readonly stmtStats: Statement;

  constructor(db: Database) {
    this.db = db;
    db.exec(OUTCOME_DDL);
    this.migrateContentHash();

    this.stmtUpsert = db.prepare(`
      INSERT INTO outcomes (cid, status, reason, baseline_cid, content_hash, evaluated_at, evaluated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cid) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        baseline_cid = excluded.baseline_cid,
        content_hash = excluded.content_hash,
        evaluated_at = excluded.evaluated_at,
        evaluated_by = excluded.evaluated_by
    `);

    this.stmtGet = db.prepare("SELECT * FROM outcomes WHERE cid = ?");
    this.stmtGetByContentHash = db.prepare("SELECT * FROM outcomes WHERE content_hash = ?");

    this.stmtStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'crashed' THEN 1 ELSE 0 END) as crashed,
        SUM(CASE WHEN status = 'invalidated' THEN 1 ELSE 0 END) as invalidated
      FROM outcomes
    `);
  }

  private migrateContentHash(): void {
    const cols = this.db.prepare("PRAGMA table_info(outcomes)").all() as readonly {
      name: string;
    }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("content_hash")) {
      this.db.run("ALTER TABLE outcomes ADD COLUMN content_hash TEXT");
    }

    const rows = this.db
      .prepare("SELECT * FROM outcomes WHERE content_hash IS NULL OR content_hash = ''")
      .all() as OutcomeRow[];
    const updateHash = this.db.prepare("UPDATE outcomes SET content_hash = ? WHERE cid = ?");
    for (const row of rows) {
      const record = rowToRecord(row);
      updateHash.run(computeOutcomeContentHash(record.cid, record), record.cid);
    }

    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_outcomes_content_hash ON outcomes(content_hash)",
    );
  }

  async set(cid: string, input: OutcomeInput): Promise<OutcomeRecord> {
    const contentHash = computeOutcomeContentHash(cid, input);
    const duplicate = this.stmtGetByContentHash.get(contentHash) as OutcomeRow | null;
    if (duplicate !== null) {
      return { ...rowToRecord(duplicate), isNew: false } as OutcomeRecord & {
        readonly isNew: false;
      };
    }

    const evaluatedAt = new Date().toISOString();
    this.stmtUpsert.run(
      cid,
      input.status,
      input.reason ?? null,
      input.baselineCid ?? null,
      contentHash,
      evaluatedAt,
      input.evaluatedBy,
    );

    return {
      cid,
      status: input.status,
      reason: input.reason,
      baselineCid: input.baselineCid,
      evaluatedAt,
      evaluatedBy: input.evaluatedBy,
      isNew: true,
    } as OutcomeRecord & { readonly isNew: true };
  }

  async get(cid: string): Promise<OutcomeRecord | undefined> {
    const row = this.stmtGet.get(cid) as OutcomeRow | null;
    return row ? rowToRecord(row) : undefined;
  }

  async getBatch(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    if (cids.length === 0) return new Map();

    const map = new Map<string, OutcomeRecord>();
    const uniqueCids = [...new Set(cids)];
    for (let i = 0; i < uniqueCids.length; i += SQLITE_BIND_LIMIT) {
      const chunk = uniqueCids.slice(i, i + SQLITE_BIND_LIMIT);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM outcomes WHERE cid IN (${placeholders})`)
        .all(...chunk) as OutcomeRow[];
      for (const row of rows) {
        map.set(row.cid, rowToRecord(row));
      }
    }
    return map;
  }

  async list(query?: OutcomeQuery): Promise<readonly OutcomeRecord[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (query?.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query?.evaluatedBy) {
      clauses.push("evaluated_by = ?");
      params.push(query.evaluatedBy);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    let pagination = "";
    if (query?.limit !== undefined) {
      pagination += " LIMIT ?";
      params.push(query.limit);
    } else if (query?.offset !== undefined) {
      pagination += " LIMIT -1";
    }
    if (query?.offset !== undefined) {
      pagination += " OFFSET ?";
      params.push(query.offset);
    }

    const rows = this.db
      .prepare(`SELECT * FROM outcomes ${where} ORDER BY evaluated_at DESC${pagination}`)
      .all(...params) as OutcomeRow[];

    return rows.map(rowToRecord);
  }

  async getStats(): Promise<OutcomeStats> {
    const row = this.stmtStats.get() as StatsRow;
    const total = row.total ?? 0;
    const accepted = row.accepted ?? 0;
    return {
      total,
      accepted,
      rejected: row.rejected ?? 0,
      crashed: row.crashed ?? 0,
      invalidated: row.invalidated ?? 0,
      acceptanceRate: total > 0 ? accepted / total : 0,
    };
  }

  close(): void {
    // Statements are finalized by the Database when it closes.
    // The Database itself is managed by the caller (shared with other stores).
  }
}

// ---------------------------------------------------------------------------
// Internal types and helpers
// ---------------------------------------------------------------------------

interface OutcomeRow {
  readonly cid: string;
  readonly status: string;
  readonly reason: string | null;
  readonly baseline_cid: string | null;
  readonly evaluated_at: string;
  readonly evaluated_by: string;
}

interface StatsRow {
  readonly total: number | null;
  readonly accepted: number | null;
  readonly rejected: number | null;
  readonly crashed: number | null;
  readonly invalidated: number | null;
}

function rowToRecord(row: OutcomeRow): OutcomeRecord {
  return {
    cid: row.cid,
    status: row.status as OutcomeRecord["status"],
    reason: row.reason ?? undefined,
    baselineCid: row.baseline_cid ?? undefined,
    evaluatedAt: row.evaluated_at,
    evaluatedBy: row.evaluated_by,
  };
}
