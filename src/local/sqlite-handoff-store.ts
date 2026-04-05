import type { Database } from "bun:sqlite";
import { NotFoundError } from "../core/errors.js";
import {
  type Handoff,
  type HandoffInput,
  type HandoffQuery,
  HandoffStatus,
  type HandoffStore,
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
    createdAt: row.created_at,
  };
}

export class SqliteHandoffStore implements HandoffStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: HandoffInput): Promise<Handoff> {
    const handoffId = this.insertSync(input);
    const handoff = await this.get(handoffId);
    if (handoff === undefined) {
      throw new NotFoundError({ resource: "Handoff", identifier: handoffId });
    }
    return handoff;
  }

  insertSync(input: HandoffInput): string {
    const handoffId = input.handoffId ?? crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO handoffs (
          handoff_id, source_cid, from_role, to_role, status,
          requires_reply, reply_due_at, resolved_by_cid, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        new Date().toISOString(),
      );
    return handoffId;
  }

  async get(id: string): Promise<Handoff | undefined> {
    const row = this.db
      .prepare(
        `SELECT handoff_id, source_cid, from_role, to_role, status,
                requires_reply, reply_due_at, resolved_by_cid, created_at
         FROM handoffs
         WHERE handoff_id = ?`,
      )
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

    let sql = `SELECT handoff_id, source_cid, from_role, to_role, status,
                      requires_reply, reply_due_at, resolved_by_cid, created_at
               FROM handoffs`;
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

  async markDelivered(id: string): Promise<void> {
    const result = this.db
      .prepare("UPDATE handoffs SET status = ? WHERE handoff_id = ?")
      .run(HandoffStatus.Delivered, id);
    if (result.changes === 0) {
      throw new NotFoundError({ resource: "Handoff", identifier: id });
    }
  }

  async markReplied(id: string, resolvedByCid: string): Promise<void> {
    const result = this.db
      .prepare("UPDATE handoffs SET status = ?, resolved_by_cid = ? WHERE handoff_id = ?")
      .run(HandoffStatus.Replied, resolvedByCid, id);
    if (result.changes === 0) {
      throw new NotFoundError({ resource: "Handoff", identifier: id });
    }
  }

  async expireStale(now?: string): Promise<readonly Handoff[]> {
    const cutoff = now ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE handoffs
         SET status = ?
         WHERE status = ? AND reply_due_at IS NOT NULL AND reply_due_at < ?`,
      )
      .run(HandoffStatus.Expired, HandoffStatus.PendingPickup, cutoff);

    const rows = this.db
      .prepare(
        `SELECT handoff_id, source_cid, from_role, to_role, status,
                requires_reply, reply_due_at, resolved_by_cid, created_at
         FROM handoffs
         WHERE status = ? AND reply_due_at IS NOT NULL AND reply_due_at < ?
         ORDER BY created_at ASC`,
      )
      .all(HandoffStatus.Expired, cutoff) as readonly HandoffRow[];
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
