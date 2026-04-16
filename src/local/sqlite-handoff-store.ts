import type { Database } from "bun:sqlite";
import { NotFoundError } from "../core/errors.js";
import {
  type Handoff,
  type HandoffInput,
  type HandoffQuery,
  HandoffStatus,
  type HandoffStore,
  validateTransition,
} from "../core/handoff.js";

export const HANDOFF_DDL = `
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
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_handoffs_to_role_status ON handoffs(to_role, status);
  CREATE INDEX IF NOT EXISTS idx_handoffs_source_cid ON handoffs(source_cid);
  CREATE INDEX IF NOT EXISTS idx_handoffs_from_role ON handoffs(from_role);
  CREATE INDEX IF NOT EXISTS idx_handoffs_reply_due_pending
    ON handoffs(reply_due_at) WHERE status = 'pending_pickup';
`;

interface HandoffRow {
  readonly handoff_id: string;
  readonly source_cid: string;
  readonly from_role: string;
  readonly to_role: string;
  readonly status: string;
  readonly requires_reply: number;
  readonly reply_due_at: string | null;
  readonly resolved_by_cid: string | null;
  readonly seen_at: string | null;
  readonly acked_at: string | null;
  readonly created_at: string;
}

function rowToHandoff(row: HandoffRow): Handoff {
  return {
    handoffId: row.handoff_id,
    sourceCid: row.source_cid,
    fromRole: row.from_role,
    toRole: row.to_role,
    status: row.status as HandoffStatus,
    requiresReply: row.requires_reply !== 0,
    ...(row.reply_due_at !== null ? { replyDueAt: row.reply_due_at } : {}),
    ...(row.resolved_by_cid !== null ? { resolvedByCid: row.resolved_by_cid } : {}),
    ...(row.seen_at !== null ? { seenAt: row.seen_at } : {}),
    ...(row.acked_at !== null ? { ackedAt: row.acked_at } : {}),
    createdAt: row.created_at,
  };
}

const SELECT_COLS = `handoff_id, source_cid, from_role, to_role, status,
                requires_reply, reply_due_at, resolved_by_cid, seen_at, acked_at, created_at`;

export class SqliteHandoffStore implements HandoffStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    // Column-safe migration: add seen_at/acked_at if missing (pre-#164 databases).
    const columns = (
      this.db.prepare("PRAGMA table_info(handoffs)").all() as readonly { name: string }[]
    ).map((c) => c.name);
    if (!columns.includes("seen_at")) {
      this.db.run("ALTER TABLE handoffs ADD COLUMN seen_at TEXT");
    }
    if (!columns.includes("acked_at")) {
      this.db.run("ALTER TABLE handoffs ADD COLUMN acked_at TEXT");
    }
  }

  async create(input: HandoffInput): Promise<Handoff> {
    const handoffId = this.insertSync(input);
    const handoff = await this.get(handoffId);
    if (handoff === undefined) {
      throw new NotFoundError({ resource: "Handoff", identifier: handoffId });
    }
    return handoff;
  }

  /**
   * Insert a handoff record synchronously inside an active SQLite transaction.
   *
   * Capability extension: `contributeOperation` duck-types for this method when
   * selecting the atomic write path (`writeAtomic`). It is called as the cowrite
   * callback inside `putWithCowrite`, so it must be synchronous. Stores that do
   * NOT implement this method fall back to `writeSerial` (best-effort handoffs).
   */
  insertSync(input: HandoffInput): string {
    const handoffId = input.handoffId ?? crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO handoffs (
          handoff_id, source_cid, from_role, to_role, status,
          requires_reply, reply_due_at, resolved_by_cid, seen_at, acked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoffId,
        input.sourceCid,
        input.fromRole,
        input.toRole,
        HandoffStatus.PendingPickup,
        input.requiresReply ? 1 : 0,
        input.replyDueAt ?? null,
        null,
        null,
        null,
        new Date().toISOString(),
      );
    return handoffId;
  }

  async get(id: string): Promise<Handoff | undefined> {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM handoffs WHERE handoff_id = ?`)
      .get(id) as HandoffRow | null;
    return row === null ? undefined : rowToHandoff(row);
  }

  async list(query?: HandoffQuery): Promise<readonly Handoff[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query?.toRole !== undefined) {
      clauses.push("to_role = ?");
      params.push(query.toRole);
    }
    if (query?.fromRole !== undefined) {
      clauses.push("from_role = ?");
      params.push(query.fromRole);
    }
    if (query?.sourceCid !== undefined) {
      clauses.push("source_cid = ?");
      params.push(query.sourceCid);
    }
    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }

    let sql = `SELECT ${SELECT_COLS} FROM handoffs`;
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }
    sql += " ORDER BY created_at ASC";
    if (query?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly HandoffRow[];
    return rows.map(rowToHandoff);
  }

  // All transitions below are implemented as single conditional UPDATEs
  // with status guards in the WHERE clause. This closes the read-then-write
  // TOCTOU window against concurrent expireStale / markReplied / etc: if
  // the state changed between our check and write, result.changes === 0
  // and we surface the right error (not-found vs invalid-transition).

  async markDelivered(id: string): Promise<void> {
    // Valid transition: pending_pickup → delivered
    const result = this.db
      .prepare(
        `UPDATE handoffs SET status = ?
         WHERE handoff_id = ? AND status = ?`,
      )
      .run(HandoffStatus.Delivered, id, HandoffStatus.PendingPickup);
    if (result.changes === 0) {
      // Either the handoff doesn't exist or it's in a status from which
      // delivered is invalid (replied/expired). Disambiguate via a get().
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      if (current.status !== HandoffStatus.Delivered) {
        validateTransition(id, current.status, HandoffStatus.Delivered);
      }
      // Already delivered — treat as idempotent no-op
    }
  }

  async markReplied(id: string, resolvedByCid: string): Promise<void> {
    // Valid transitions: pending_pickup → replied, delivered → replied
    const result = this.db
      .prepare(
        `UPDATE handoffs SET status = ?, resolved_by_cid = ?
         WHERE handoff_id = ? AND status IN (?, ?)`,
      )
      .run(
        HandoffStatus.Replied,
        resolvedByCid,
        id,
        HandoffStatus.PendingPickup,
        HandoffStatus.Delivered,
      );
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      validateTransition(id, current.status, HandoffStatus.Replied);
    }
  }

  async markSeen(id: string): Promise<void> {
    // Only stamp seenAt if not already set. Conditional WHERE prevents
    // concurrent callers from each writing a different timestamp.
    const result = this.db
      .prepare(
        `UPDATE handoffs SET seen_at = ?
         WHERE handoff_id = ? AND seen_at IS NULL`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes === 0) {
      // Either the handoff doesn't exist, or seenAt was already set (idempotent)
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      // Already seen — no-op
    }
  }

  async markAcked(id: string): Promise<void> {
    // Single conditional UPDATE that atomically stamps ackedAt (and seenAt
    // if unset) only when ackedAt is currently NULL. Uses COALESCE so
    // seenAt preserves its existing value, or fills with now() if null.
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE handoffs
         SET acked_at = ?, seen_at = COALESCE(seen_at, ?)
         WHERE handoff_id = ? AND acked_at IS NULL`,
      )
      .run(now, now, id);
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      // Already acked — no-op
    }
  }

  /**
   * Session-scoped enumeration for deadline rebuild.
   *
   * SQLite stores have no session_id column today — this contract relies
   * on the caller opening ONE SqliteHandoffStore per session database.
   * That is how grove currently runs (one .grove/grove.db per worktree,
   * one active session at a time). If multi-session-per-DB is added later,
   * a session_id column must be introduced and this method updated.
   */
  async listForCurrentSession(query?: HandoffQuery): Promise<readonly Handoff[]> {
    return this.list(query);
  }

  async expireStale(now?: string): Promise<readonly Handoff[]> {
    const cutoff = now ?? new Date().toISOString();
    // Expire both pending_pickup AND delivered unresolved handoffs with past
    // deadlines. RETURNING ensures idempotency (only newly-transitioned rows).
    const rows = this.db
      .prepare(
        `UPDATE handoffs
         SET status = ?
         WHERE status IN (?, ?) AND reply_due_at IS NOT NULL AND reply_due_at < ?
         RETURNING ${SELECT_COLS}`,
      )
      .all(
        HandoffStatus.Expired,
        HandoffStatus.PendingPickup,
        HandoffStatus.Delivered,
        cutoff,
      ) as readonly HandoffRow[];
    return rows.map(rowToHandoff);
  }

  async countPending(toRole: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM handoffs WHERE to_role = ? AND status = ?")
      .get(toRole, HandoffStatus.PendingPickup) as { count: number } | null;
    return row?.count ?? 0;
  }

  close(): void {
    /* no-op */
  }
}
