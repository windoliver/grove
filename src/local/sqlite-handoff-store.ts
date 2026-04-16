import type { Database } from "bun:sqlite";
import { NotFoundError, StateConflictError } from "../core/errors.js";
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
    session_id TEXT,
    ipc_message_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_handoffs_to_role_status ON handoffs(to_role, status);
  CREATE INDEX IF NOT EXISTS idx_handoffs_source_cid ON handoffs(source_cid);
  CREATE INDEX IF NOT EXISTS idx_handoffs_from_role ON handoffs(from_role);
  CREATE INDEX IF NOT EXISTS idx_handoffs_reply_due_pending
    ON handoffs(reply_due_at) WHERE status = 'pending_pickup';
  CREATE INDEX IF NOT EXISTS idx_handoffs_session_id ON handoffs(session_id);
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
  readonly session_id: string | null;
  readonly ipc_message_id: string | null;
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
    ...(row.ipc_message_id !== null ? { ipcMessageId: row.ipc_message_id } : {}),
    createdAt: row.created_at,
  };
}

const SELECT_COLS = `handoff_id, source_cid, from_role, to_role, status,
                requires_reply, reply_due_at, resolved_by_cid, seen_at, acked_at,
                session_id, ipc_message_id, created_at`;

/**
 * SQLite-backed handoff store with optional session scoping.
 *
 * When constructed with a `sessionId`, every write stamps the row with that
 * id and every read/mutation filters by it — providing the same session
 * isolation as NexusHandoffStore. This makes it safe to run proactive
 * deadline timers and ack/seen receipts on the local path without cross-
 * session state corruption.
 *
 * When constructed without a `sessionId` (legacy / unscoped callers), the
 * store behaves like before: writes leave session_id NULL, reads don't
 * filter by session. This preserves compatibility with CLI tools and
 * tests that want to see every handoff in the DB.
 *
 * The `listForCurrentSession` / `isInCurrentSession` capability methods
 * are only exposed in scoped mode — their presence is the signal to
 * callers (DeadlineWatcher, grove_ack_handoff) that this backend can
 * safely answer "does this handoff belong to me?"
 */
export class SqliteHandoffStore implements HandoffStore {
  private readonly db: Database;
  private readonly sessionId: string | undefined;

  constructor(db: Database, sessionId?: string) {
    this.db = db;
    this.sessionId = sessionId;
    // Column-safe migration for pre-#164 databases. Runs outside the
    // serialized initSqliteDb transaction, so two concurrent processes
    // upgrading the same DB can both observe the missing column and race
    // on ALTER TABLE — catch "duplicate column" and treat as success.
    const columns = (
      this.db.prepare("PRAGMA table_info(handoffs)").all() as readonly { name: string }[]
    ).map((c) => c.name);
    if (!columns.includes("seen_at")) this.safeAddColumn("seen_at");
    if (!columns.includes("acked_at")) this.safeAddColumn("acked_at");
    if (!columns.includes("session_id")) this.safeAddColumn("session_id");
    if (!columns.includes("ipc_message_id")) this.safeAddColumn("ipc_message_id");

    // Conditionally expose session-scoped capability methods only when
    // operating in scoped mode. Unscoped stores leave them undefined so
    // callers correctly interpret that as "no session scoping available".
    if (sessionId === undefined) {
      // Remove the methods so the presence check (method !== undefined)
      // returns false on unscoped stores.
      (this as { listForCurrentSession?: unknown }).listForCurrentSession = undefined;
      (this as { isInCurrentSession?: unknown }).isInCurrentSession = undefined;
    }
  }

  private safeAddColumn(column: string): void {
    try {
      this.db.run(`ALTER TABLE handoffs ADD COLUMN ${column} TEXT`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) throw err;
    }
  }

  /**
   * Return a WHERE fragment + params that restrict queries to the current
   * session. Returns empty when the store is unscoped (legacy mode).
   *
   * Scoped queries match BOTH `session_id = ?` AND `session_id IS NULL`:
   * the null branch is a migration shim for rows created before the
   * session_id column existed. Without it, in-flight handoffs from a
   * pre-#164 process would become invisible after upgrade and strand
   * the coder→reviewer loop. Rows written by a scoped store always
   * have a non-null session_id, so this only affects legacy data.
   */
  private scopeClause(): { sql: string; params: readonly string[] } {
    if (this.sessionId === undefined) return { sql: "", params: [] };
    return { sql: "(session_id = ? OR session_id IS NULL)", params: [this.sessionId] };
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
   * Stamps the row with the current sessionId when the store is scoped.
   */
  insertSync(input: HandoffInput): string {
    const handoffId = input.handoffId ?? crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO handoffs (
          handoff_id, source_cid, from_role, to_role, status,
          requires_reply, reply_due_at, resolved_by_cid, seen_at, acked_at,
          session_id, ipc_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        this.sessionId ?? null,
        null,
        new Date().toISOString(),
      );
    return handoffId;
  }

  async get(id: string): Promise<Handoff | undefined> {
    // Scoped: a handoff from a different session must not leak through
    // get() or it could be mutated via mark* methods by the wrong process.
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const where = scopeSql ? `handoff_id = ? AND ${scopeSql}` : "handoff_id = ?";
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM handoffs WHERE ${where}`)
      .get(id, ...scopeParams) as HandoffRow | null;
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

    // Scope by session when set — prevents list() from returning handoffs
    // from other sessions that share the same .grove/grove.db file.
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    if (scopeSql) {
      clauses.push(scopeSql);
      params.push(...scopeParams);
    }

    let sql = `SELECT ${SELECT_COLS} FROM handoffs`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY created_at ASC";
    if (query?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly HandoffRow[];
    return rows.map(rowToHandoff);
  }

  // All transitions below are implemented as single conditional UPDATEs
  // with status + session_id guards in the WHERE clause. Closes TOCTOU
  // against concurrent expireStale / markReplied AND prevents a process
  // scoped to session A from mutating session B's rows.

  async markDelivered(id: string): Promise<void> {
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    const result = this.db
      .prepare(
        `UPDATE handoffs SET status = ?
         WHERE handoff_id = ? AND status = ?${scopeExtra}`,
      )
      .run(HandoffStatus.Delivered, id, HandoffStatus.PendingPickup, ...scopeParams);
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      if (current.status !== HandoffStatus.Delivered) {
        validateTransition(id, current.status, HandoffStatus.Delivered);
      }
      // Already delivered — idempotent no-op
    }
  }

  async markReplied(id: string, resolvedByCid: string): Promise<void> {
    const now = new Date().toISOString();
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    // Valid transitions: delivered → replied, processed → replied.
    // pending_pickup → replied is NOT allowed — callers must markDelivered
    // first. The state machine enforces the IPC ack invariant.
    const result = this.db
      .prepare(
        `UPDATE handoffs SET status = ?, resolved_by_cid = ?
         WHERE handoff_id = ? AND status IN (?, ?)
           AND (reply_due_at IS NULL OR reply_due_at >= ?)${scopeExtra}`,
      )
      .run(
        HandoffStatus.Replied,
        resolvedByCid,
        id,
        HandoffStatus.Delivered,
        HandoffStatus.Processed,
        now,
        ...scopeParams,
      );
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      if (
        (current.status === HandoffStatus.Delivered ||
          current.status === HandoffStatus.Processed) &&
        current.replyDueAt !== undefined &&
        current.replyDueAt < now
      ) {
        this.db
          .prepare(
            `UPDATE handoffs SET status = ?
             WHERE handoff_id = ? AND status IN (?, ?)${scopeExtra}`,
          )
          .run(
            HandoffStatus.Expired,
            id,
            HandoffStatus.Delivered,
            HandoffStatus.Processed,
            ...scopeParams,
          );
        throw new StateConflictError({
          resource: "Handoff",
          reason: `Reply deadline passed at ${current.replyDueAt} (now ${now})`,
        });
      }
      validateTransition(id, current.status, HandoffStatus.Replied);
    }
  }

  async markProcessed(id: string): Promise<void> {
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    const result = this.db
      .prepare(
        `UPDATE handoffs SET status = ?
         WHERE handoff_id = ? AND status = ?${scopeExtra}`,
      )
      .run(HandoffStatus.Processed, id, HandoffStatus.Delivered, ...scopeParams);
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      if (current.status !== HandoffStatus.Processed) {
        validateTransition(id, current.status, HandoffStatus.Processed);
      }
      // Already processed — idempotent no-op
    }
  }

  async markDeadLettered(id: string): Promise<void> {
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    const result = this.db
      .prepare(
        `UPDATE handoffs SET status = ?
         WHERE handoff_id = ? AND status IN (?, ?)${scopeExtra}`,
      )
      .run(
        HandoffStatus.DeadLettered,
        id,
        HandoffStatus.PendingPickup,
        HandoffStatus.Delivered,
        ...scopeParams,
      );
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      if (current.status !== HandoffStatus.DeadLettered) {
        validateTransition(id, current.status, HandoffStatus.DeadLettered);
      }
      // Already dead-lettered — idempotent no-op
    }
  }

  async setIpcMessageId(id: string, ipcMessageId: string): Promise<void> {
    // IPC message IDs are set at-most-once after successful IPC relay; a
    // scoped store only mutates its own session's rows.
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    const result = this.db
      .prepare(
        `UPDATE handoffs SET ipc_message_id = ?
         WHERE handoff_id = ?${scopeExtra}`,
      )
      .run(ipcMessageId, id, ...scopeParams);
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
    }
  }

  async markSeen(id: string): Promise<void> {
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    const result = this.db
      .prepare(
        `UPDATE handoffs SET seen_at = ?
         WHERE handoff_id = ? AND seen_at IS NULL${scopeExtra}`,
      )
      .run(new Date().toISOString(), id, ...scopeParams);
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      // Already seen — idempotent no-op
    }
  }

  async markAcked(id: string): Promise<void> {
    const now = new Date().toISOString();
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    const result = this.db
      .prepare(
        `UPDATE handoffs
         SET acked_at = ?, seen_at = COALESCE(seen_at, ?)
         WHERE handoff_id = ? AND acked_at IS NULL${scopeExtra}`,
      )
      .run(now, now, id, ...scopeParams);
    if (result.changes === 0) {
      const current = await this.get(id);
      if (current === undefined) {
        throw new NotFoundError({ resource: "Handoff", identifier: id });
      }
      // Already acked — idempotent no-op
    }
  }

  /**
   * Session-scoped enumeration. Only defined in scoped mode — unscoped
   * stores have this property set to undefined in the constructor so
   * callers correctly detect the capability is unavailable.
   */
  async listForCurrentSession(query?: HandoffQuery): Promise<readonly Handoff[]> {
    // In scoped mode, list() is already scoped by session — just delegate.
    return this.list(query);
  }

  /**
   * O(1) session ownership check. Only defined in scoped mode. Returns
   * true iff the row exists AND belongs to the caller's session.
   */
  async isInCurrentSession(handoffId: string): Promise<boolean> {
    if (this.sessionId === undefined) return false;
    const row = this.db
      .prepare("SELECT 1 FROM handoffs WHERE handoff_id = ? AND session_id = ?")
      .get(handoffId, this.sessionId);
    return row !== null;
  }


  async expireStale(now?: string): Promise<readonly Handoff[]> {
    const cutoff = now ?? new Date().toISOString();
    // Expire both pending_pickup AND delivered unresolved handoffs with
    // past deadlines. Scoped by session so session A's watcher cannot
    // flip session B's rows. RETURNING ensures idempotency (only newly-
    // transitioned rows).
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    const rows = this.db
      .prepare(
        `UPDATE handoffs
         SET status = ?
         WHERE status IN (?, ?, ?)
           AND reply_due_at IS NOT NULL AND reply_due_at < ?${scopeExtra}
         RETURNING ${SELECT_COLS}`,
      )
      .all(
        HandoffStatus.Expired,
        HandoffStatus.PendingPickup,
        HandoffStatus.Delivered,
        HandoffStatus.Processed,
        cutoff,
        ...scopeParams,
      ) as readonly HandoffRow[];
    return rows.map(rowToHandoff);
  }

  async countPending(toRole: string): Promise<number> {
    const { sql: scopeSql, params: scopeParams } = this.scopeClause();
    const scopeExtra = scopeSql ? ` AND ${scopeSql}` : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM handoffs
         WHERE to_role = ? AND status = ?${scopeExtra}`,
      )
      .get(toRole, HandoffStatus.PendingPickup, ...scopeParams) as { count: number } | null;
    return row?.count ?? 0;
  }

  close(): void {
    /* no-op */
  }
}
