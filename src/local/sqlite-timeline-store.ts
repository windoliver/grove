import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import type { TimelineEventEntity, WorkBlockEntity } from "../core/entity.js";
import { timelineEventToEntity, workBlockToEntity } from "../core/entity.js";
import { NotFoundError } from "../core/errors.js";
import type { TimelineEvent, WorkBlock } from "../core/timeline.js";
import { timelineScope } from "../core/timeline.js";
import { parseTimelineEvent, parseWorkBlock } from "../core/timeline-schemas.js";
import type {
  AllScopeTimelineEventQuery,
  TimelineEventInput,
  TimelineEventQuery,
  TimelineStore,
  WorkBlockPatch,
  WorkBlockQuery,
} from "../core/timeline-store.js";
import type { WatchOp } from "../core/watch-events.js";
import { readStoreNamespace } from "./sqlite-store.js";

export const SQLITE_TIMELINE_DDL = `
  CREATE TABLE IF NOT EXISTS work_blocks (
    work_block_id TEXT PRIMARY KEY,
    session_id TEXT,
    goal TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    input_refs_json TEXT NOT NULL DEFAULT '[]',
    output_refs_json TEXT NOT NULL DEFAULT '[]',
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    approval_refs_json TEXT NOT NULL DEFAULT '[]',
    contribution_cids_json TEXT NOT NULL DEFAULT '[]',
    artifact_hashes_json TEXT NOT NULL DEFAULT '[]',
    claim_ids_json TEXT NOT NULL DEFAULT '[]',
    cost_summary_json TEXT,
    links_json TEXT NOT NULL DEFAULT '[]',
    context_json TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_blocks_session_status
    ON work_blocks(session_id, status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_work_blocks_actor
    ON work_blocks(actor_id, updated_at);

  CREATE TABLE IF NOT EXISTS timeline_cursors (
    scope TEXT PRIMARY KEY,
    current_rv INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS timeline_events (
    event_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    resource_version INTEGER NOT NULL,
    session_id TEXT,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    actor_id TEXT,
    actor_json TEXT,
    work_block_id TEXT,
    target_refs_json TEXT NOT NULL DEFAULT '[]',
    payload_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(scope, resource_version)
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_events_scope_rv
    ON timeline_events(scope, resource_version);
  CREATE INDEX IF NOT EXISTS idx_timeline_events_work_block
    ON timeline_events(work_block_id, resource_version);
  CREATE INDEX IF NOT EXISTS idx_timeline_events_type
    ON timeline_events(type, recorded_at);
`;

interface WorkBlockRow {
  readonly work_block_id: string;
  readonly session_id: string | null;
  readonly goal: string;
  readonly actor_json: string;
  readonly origin: string;
  readonly status: string;
  readonly started_at: string | null;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly input_refs_json: string;
  readonly output_refs_json: string;
  readonly evidence_refs_json: string;
  readonly approval_refs_json: string;
  readonly contribution_cids_json: string;
  readonly artifact_hashes_json: string;
  readonly claim_ids_json: string;
  readonly cost_summary_json: string | null;
  readonly links_json: string;
  readonly context_json: string | null;
  readonly revision: number;
  readonly created_at: string;
}

interface TimelineEventRow {
  readonly event_id: string;
  readonly resource_version: number;
  readonly session_id: string | null;
  readonly type: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly actor_json: string | null;
  readonly work_block_id: string | null;
  readonly target_refs_json: string;
  readonly payload_json: string;
}

export class SqliteTimelineStore implements TimelineStore {
  readonly storeIdentity: string;

  onWorkBlockWrite?: (op: WatchOp, block: WorkBlock) => void;
  onTimelineEventWrite?: (op: "ADDED", event: TimelineEvent) => void;

  private readonly db: Database;
  private readonly getWorkBlockStmt: Statement;
  private readonly workBlockExistsStmt: Statement;
  private readonly upsertWorkBlockStmt: Statement;
  private readonly getTimelineEventStmt: Statement;
  private readonly insertTimelineEventStmt: Statement;
  private readonly currentCursorStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    this.storeIdentity = `${db.filename}:timeline`;
    this.getWorkBlockStmt = db.prepare("SELECT * FROM work_blocks WHERE work_block_id = ?");
    this.workBlockExistsStmt = db.prepare(
      "SELECT 1 AS present FROM work_blocks WHERE work_block_id = ?",
    );
    this.upsertWorkBlockStmt = db.prepare(`
      INSERT INTO work_blocks (
        work_block_id,
        session_id,
        goal,
        actor_id,
        actor_json,
        origin,
        status,
        started_at,
        updated_at,
        completed_at,
        input_refs_json,
        output_refs_json,
        evidence_refs_json,
        approval_refs_json,
        contribution_cids_json,
        artifact_hashes_json,
        claim_ids_json,
        cost_summary_json,
        links_json,
        context_json,
        revision,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_block_id) DO UPDATE SET
        session_id = excluded.session_id,
        goal = excluded.goal,
        actor_id = excluded.actor_id,
        actor_json = excluded.actor_json,
        origin = excluded.origin,
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        input_refs_json = excluded.input_refs_json,
        output_refs_json = excluded.output_refs_json,
        evidence_refs_json = excluded.evidence_refs_json,
        approval_refs_json = excluded.approval_refs_json,
        contribution_cids_json = excluded.contribution_cids_json,
        artifact_hashes_json = excluded.artifact_hashes_json,
        claim_ids_json = excluded.claim_ids_json,
        cost_summary_json = excluded.cost_summary_json,
        links_json = excluded.links_json,
        context_json = excluded.context_json,
        revision = excluded.revision,
        created_at = excluded.created_at
    `);
    this.getTimelineEventStmt = db.prepare("SELECT * FROM timeline_events WHERE event_id = ?");
    this.insertTimelineEventStmt = db.prepare(`
      INSERT INTO timeline_events (
        event_id,
        scope,
        resource_version,
        session_id,
        type,
        occurred_at,
        recorded_at,
        actor_id,
        actor_json,
        work_block_id,
        target_refs_json,
        payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.currentCursorStmt = db.prepare("SELECT current_rv FROM timeline_cursors WHERE scope = ?");
  }

  async putWorkBlock(block: WorkBlock): Promise<WorkBlock> {
    const parsed = parseWorkBlock(block);
    const existed = this.workBlockExists(parsed.workBlockId);
    this.writeWorkBlock(parsed);
    this.onWorkBlockWrite?.(existed ? "MODIFIED" : "ADDED", parsed);
    return parsed;
  }

  async patchWorkBlock(workBlockId: string, patch: WorkBlockPatch): Promise<WorkBlock> {
    const patched = this.patchWorkBlockSync(workBlockId, patch);
    this.onWorkBlockWrite?.("MODIFIED", patched);
    return patched;
  }

  async getWorkBlock(workBlockId: string): Promise<WorkBlock | undefined> {
    const row = this.getWorkBlockStmt.get(workBlockId) as WorkBlockRow | null;
    return row === null ? undefined : rowToWorkBlock(row);
  }

  async listWorkBlocks(query?: WorkBlockQuery): Promise<readonly WorkBlock[]> {
    const conditions: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (query?.sessionId !== undefined) {
      conditions.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query?.actorId !== undefined) {
      conditions.push("actor_id = ?");
      params.push(query.actorId);
    }
    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      if (statuses.length === 0) return [];
      conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }

    let sql = "SELECT * FROM work_blocks";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY updated_at DESC";
    if (query?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }
    if (query?.offset !== undefined) {
      if (query.limit === undefined) {
        sql += " LIMIT -1";
      }
      sql += " OFFSET ?";
      params.push(query.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly WorkBlockRow[];
    return rows.map(rowToWorkBlock);
  }

  async listWorkBlockEntities(query?: WorkBlockQuery): Promise<readonly WorkBlockEntity[]> {
    const blocks = await this.listWorkBlocks(query);
    const namespace = readStoreNamespace(this.db);
    return blocks.map((block) => workBlockToEntity(block, namespace));
  }

  async appendTimelineEvent(input: TimelineEventInput): Promise<TimelineEvent> {
    const result = this.appendTimelineEventSync(input);
    if (result.created) {
      this.onTimelineEventWrite?.("ADDED", result.event);
    }
    return result.event;
  }

  async getTimelineEvent(eventId: string): Promise<TimelineEvent | undefined> {
    const row = this.getTimelineEventStmt.get(eventId) as TimelineEventRow | null;
    return row === null ? undefined : rowToTimelineEvent(row);
  }

  async listTimelineEvents(query?: TimelineEventQuery): Promise<readonly TimelineEvent[]> {
    const scope = timelineScope(query?.sessionId);
    const conditions = ["scope = ?"];
    const params: SQLQueryBindings[] = [scope];

    if (query?.afterRv !== undefined) {
      conditions.push("resource_version > ?");
      params.push(Number(query.afterRv));
    }
    if (query?.workBlockId !== undefined) {
      conditions.push("work_block_id = ?");
      params.push(query.workBlockId);
    }

    let sql = `SELECT * FROM timeline_events WHERE ${conditions.join(" AND ")}
      ORDER BY resource_version ASC`;
    if (query?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly TimelineEventRow[];
    return rows.map(rowToTimelineEvent);
  }

  async listTimelineEventEntities(
    query?: TimelineEventQuery,
  ): Promise<readonly TimelineEventEntity[]> {
    const events = await this.listTimelineEvents(query);
    const namespace = readStoreNamespace(this.db);
    return events.map((event) => timelineEventToEntity(event, namespace));
  }

  async listAllTimelineEventEntities(
    query?: AllScopeTimelineEventQuery,
  ): Promise<readonly TimelineEventEntity[]> {
    const conditions: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (query?.afterRv !== undefined) {
      conditions.push("resource_version > ?");
      params.push(Number(query.afterRv));
    }
    if (query?.workBlockId !== undefined) {
      conditions.push("work_block_id = ?");
      params.push(query.workBlockId);
    }

    let sql = "SELECT * FROM timeline_events";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY scope ASC, resource_version ASC";
    if (query?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly TimelineEventRow[];
    const namespace = readStoreNamespace(this.db);
    return rows.map((row) => timelineEventToEntity(rowToTimelineEvent(row), namespace));
  }

  async currentTimelineResourceVersion(sessionId?: string): Promise<string> {
    const row = this.currentCursorStmt.get(timelineScope(sessionId)) as {
      readonly current_rv: number;
    } | null;
    return row === null ? "0" : String(row.current_rv);
  }

  close(): void {
    // DB lifecycle is owned by the caller/factory.
  }

  private workBlockExists(workBlockId: string): boolean {
    return this.workBlockExistsStmt.get(workBlockId) !== null;
  }

  private writeWorkBlock(block: WorkBlock): void {
    this.upsertWorkBlockStmt.run(...workBlockBindings(block));
  }

  private patchWorkBlockSync(workBlockId: string, patch: WorkBlockPatch): WorkBlock {
    const tx = this.db.transaction((): WorkBlock => {
      const row = this.getWorkBlockStmt.get(workBlockId) as WorkBlockRow | null;
      if (row === null) {
        throw new NotFoundError({ resource: "WorkBlock", identifier: workBlockId });
      }
      const existing = rowToWorkBlock(row);
      const patched = parseWorkBlock({
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
        revision: existing.revision + 1,
      });
      this.writeWorkBlock(patched);
      return patched;
    });

    return tx.immediate();
  }

  private appendTimelineEventSync(input: TimelineEventInput): {
    readonly event: TimelineEvent;
    readonly created: boolean;
  } {
    const tx = this.db.transaction(
      (): { readonly event: TimelineEvent; readonly created: boolean } => {
        const existingRow = this.getTimelineEventStmt.get(input.eventId) as TimelineEventRow | null;
        if (existingRow !== null) {
          return { event: rowToTimelineEvent(existingRow), created: false };
        }

        const recordedAt = input.recordedAt ?? new Date().toISOString();
        const scope = timelineScope(input.sessionId);
        this.db.run("INSERT OR IGNORE INTO timeline_cursors(scope, current_rv) VALUES (?, 0)", [
          scope,
        ]);
        this.db.run("UPDATE timeline_cursors SET current_rv = current_rv + 1 WHERE scope = ?", [
          scope,
        ]);
        const row = this.currentCursorStmt.get(scope) as { readonly current_rv: number } | null;
        if (row === null) {
          throw new Error(`Timeline cursor '${scope}' was not initialized`);
        }
        const event = parseTimelineEvent({
          ...input,
          resourceVersion: String(row.current_rv),
          recordedAt,
        });
        this.insertTimelineEventStmt.run(...timelineEventBindings(event, scope));
        return { event, created: true };
      },
    );

    return tx.immediate();
  }
}

function workBlockBindings(block: WorkBlock): readonly SQLQueryBindings[] {
  return [
    block.workBlockId,
    block.sessionId ?? null,
    block.goal,
    block.actor.agentId,
    JSON.stringify(block.actor),
    block.origin,
    block.status,
    block.startedAt ?? null,
    block.updatedAt,
    block.completedAt ?? null,
    JSON.stringify(block.inputRefs),
    JSON.stringify(block.outputRefs),
    JSON.stringify(block.evidenceRefs),
    JSON.stringify(block.approvalRefs),
    JSON.stringify(block.contributionCids),
    JSON.stringify(block.artifactHashes),
    JSON.stringify(block.claimIds),
    block.costSummary === undefined ? null : JSON.stringify(block.costSummary),
    block.links === undefined ? "null" : JSON.stringify(block.links),
    block.context === undefined ? null : JSON.stringify(block.context),
    block.revision,
    block.createdAt,
  ];
}

function timelineEventBindings(event: TimelineEvent, scope: string): readonly SQLQueryBindings[] {
  return [
    event.eventId,
    scope,
    Number(event.resourceVersion),
    event.sessionId ?? null,
    event.type,
    event.occurredAt,
    event.recordedAt,
    event.actor?.agentId ?? null,
    event.actor === undefined ? null : JSON.stringify(event.actor),
    event.workBlockId ?? null,
    JSON.stringify(event.targetRefs),
    JSON.stringify(event.payload),
  ];
}

function rowToWorkBlock(row: WorkBlockRow): WorkBlock {
  const links = JSON.parse(row.links_json) as unknown;
  return parseWorkBlock({
    workBlockId: row.work_block_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    goal: row.goal,
    actor: JSON.parse(row.actor_json),
    origin: row.origin,
    status: row.status,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    inputRefs: JSON.parse(row.input_refs_json),
    outputRefs: JSON.parse(row.output_refs_json),
    evidenceRefs: JSON.parse(row.evidence_refs_json),
    approvalRefs: JSON.parse(row.approval_refs_json),
    contributionCids: JSON.parse(row.contribution_cids_json),
    artifactHashes: JSON.parse(row.artifact_hashes_json),
    claimIds: JSON.parse(row.claim_ids_json),
    ...(row.cost_summary_json === null ? {} : { costSummary: JSON.parse(row.cost_summary_json) }),
    ...(links === null ? {} : { links }),
    ...(row.context_json === null ? {} : { context: JSON.parse(row.context_json) }),
    revision: row.revision,
    createdAt: row.created_at,
  });
}

function rowToTimelineEvent(row: TimelineEventRow): TimelineEvent {
  return parseTimelineEvent({
    eventId: row.event_id,
    resourceVersion: String(row.resource_version),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    type: row.type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    ...(row.actor_json === null ? {} : { actor: JSON.parse(row.actor_json) }),
    ...(row.work_block_id === null ? {} : { workBlockId: row.work_block_id }),
    targetRefs: JSON.parse(row.target_refs_json),
    payload: JSON.parse(row.payload_json),
  });
}
