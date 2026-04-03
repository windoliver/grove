/**
 * SQLite-backed goal and session store.
 *
 * Uses the shared Database instance from initSqliteDb().
 * Goals use a single-row upsert pattern (id=1 CHECK constraint).
 * Sessions track work periods with an optional goal reference.
 * Session contributions are tracked in a join table for COUNT queries.
 */

import type { Database, Statement } from "bun:sqlite";
import type { GroveContract } from "../core/contract.js";
import type { CreateSessionInput, Session, SessionQuery } from "../core/session.js";
import type { AgentTopology } from "../core/topology.js";
import type { GoalData } from "../tui/provider.js";

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

/** DDL for goal and session tables. Exported for use in schema initialization. */
export const GOAL_SESSION_DDL = `
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    goal TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    set_at TEXT NOT NULL,
    set_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    goal TEXT,
    preset_name TEXT,
    topology_json TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    stop_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS session_contributions (
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    cid TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (session_id, cid)
  );

  CREATE INDEX IF NOT EXISTS idx_session_contributions_session_id ON session_contributions(session_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
`;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface GoalRow {
  id: number;
  goal: string;
  acceptance: string;
  status: string;
  set_at: string;
  set_by: string;
}

interface SessionRow {
  session_id: string;
  goal: string | null;
  preset_name: string | null;
  topology_json: string | null;
  config_json: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  stop_reason: string | null;
}

interface SessionWithCountRow extends SessionRow {
  contribution_count: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Store interface for goal and session persistence. */
export interface GoalSessionStore {
  /** Get the current goal (single-row table). */
  getGoal(): Promise<GoalData | undefined>;

  /** Set (upsert) the current goal. */
  setGoal(goal: string, acceptance: readonly string[], setBy: string): Promise<GoalData>;

  /** List sessions, optionally filtered by status and/or preset. */
  listSessions(query?: SessionQuery): Promise<readonly Session[]>;

  /** Create a new session. */
  createSession(input: CreateSessionInput): Promise<Session>;

  /** Get a session by ID. */
  getSession(sessionId: string): Promise<Session | undefined>;

  /** Update mutable session fields (status, completedAt, stopReason). */
  updateSession(
    sessionId: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason">>,
  ): Promise<void>;

  /** Archive a session, setting its ended_at timestamp. */
  archiveSession(sessionId: string): Promise<void>;

  /** Record a contribution CID against a session. */
  addContributionToSession(sessionId: string, cid: string): Promise<void>;

  /** Get all contribution CIDs for a session. */
  getSessionContributions(sessionId: string): Promise<readonly string[]>;

  /** Get the frozen contract config for a session by ID. */
  getSessionConfig(sessionId: string): Promise<GroveContract | undefined>;

  /** Synchronous variant — used by runtime bootstrap where async is unavailable. */
  getSessionConfigSync(sessionId: string): GroveContract | undefined;

  /** Release resources. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a GoalRow to a GoalData domain object. */
function rowToGoalData(row: GoalRow): GoalData {
  return {
    goal: row.goal,
    acceptance: JSON.parse(row.acceptance) as readonly string[],
    status: row.status as GoalData["status"],
    setAt: row.set_at,
    setBy: row.set_by,
  };
}

/** Convert a SessionWithCountRow to a Session domain object. */
function rowToSession(row: SessionWithCountRow): Session {
  let config: GroveContract | undefined;
  if (row.config_json && row.config_json !== "{}") {
    try {
      config = JSON.parse(row.config_json) as GroveContract;
    } catch {
      // Malformed config_json — treat as missing
    }
  }
  return {
    id: row.session_id,
    goal: row.goal ?? undefined,
    presetName: row.preset_name ?? undefined,
    status: row.status as Session["status"],
    createdAt: row.started_at,
    completedAt: row.ended_at ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    topology: row.topology_json ? (JSON.parse(row.topology_json) as AgentTopology) : undefined,
    contributionCount: row.contribution_count,
    config,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** SQLite-backed GoalSessionStore. */
export class SqliteGoalSessionStore implements GoalSessionStore {
  private readonly db: Database;

  // Prepared statements (lazy init)
  private stmtGetGoal: Statement | undefined;
  private stmtUpsertGoal: Statement | undefined;
  private stmtGetSession: Statement | undefined;
  private stmtInsertSession: Statement | undefined;
  private stmtArchiveSession: Statement | undefined;
  private stmtInsertContribution: Statement | undefined;
  private stmtGetContributions: Statement | undefined;

  constructor(db: Database) {
    this.db = db;
    db.exec(GOAL_SESSION_DDL);
    // Migration: add preset_name column for existing databases
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN preset_name TEXT");
    } catch {
      // Column already exists — expected for new or already-migrated databases
    }
    // Migration: add topology_json column for existing databases
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN topology_json TEXT");
    } catch {
      // Column already exists — expected for new or already-migrated databases
    }
    // Migration: add stop_reason column for existing databases
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN stop_reason TEXT");
    } catch {
      // Column already exists — expected for new or already-migrated databases
    }
    // Migration: add config_json column for existing databases
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'");
    } catch {
      // Column already exists — expected for new or already-migrated databases
    }
  }

  // -----------------------------------------------------------------------
  // Goals
  // -----------------------------------------------------------------------

  /** Get the current goal (single-row table, id=1). */
  getGoal = async (): Promise<GoalData | undefined> => {
    this.stmtGetGoal ??= this.db.prepare("SELECT * FROM goals WHERE id = 1");
    const row = this.stmtGetGoal.get() as GoalRow | null;
    return row !== null ? rowToGoalData(row) : undefined;
  };

  /** Set (upsert) the current goal. Replaces any existing goal. */
  setGoal = async (
    goal: string,
    acceptance: readonly string[],
    setBy: string,
  ): Promise<GoalData> => {
    this.stmtUpsertGoal ??= this.db.prepare(`
      INSERT INTO goals (id, goal, acceptance, status, set_at, set_by)
      VALUES (1, ?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        goal = excluded.goal,
        acceptance = excluded.acceptance,
        status = excluded.status,
        set_at = excluded.set_at,
        set_by = excluded.set_by
    `);

    const setAt = new Date().toISOString();
    const acceptanceJson = JSON.stringify(acceptance);
    this.stmtUpsertGoal.run(goal, acceptanceJson, setAt, setBy);

    return {
      goal,
      acceptance,
      status: "active",
      setAt,
      setBy,
    };
  };

  // -----------------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------------

  /** List sessions with computed contribution counts, optionally filtered by status and/or preset.
   *  Excludes config_json and topology_json for performance — use getSession()/getSessionConfig(). */
  listSessions = async (query?: SessionQuery): Promise<readonly Session[]> => {
    const baseSelect = `
      SELECT s.session_id, s.goal, s.preset_name, s.status, s.started_at, s.ended_at,
             s.stop_reason,
             COALESCE(c.cnt, 0) AS contribution_count
      FROM sessions s
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS cnt
        FROM session_contributions
        GROUP BY session_id
      ) c ON c.session_id = s.session_id
    `;

    const conditions: string[] = [];
    const params: string[] = [];

    if (query?.status !== undefined) {
      conditions.push("s.status = ?");
      params.push(query.status);
    }
    if (query?.presetName !== undefined) {
      conditions.push("s.preset_name = ?");
      params.push(query.presetName);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`${baseSelect}${where} ORDER BY s.started_at DESC`)
      .all(...params) as SessionWithCountRow[];
    return rows.map((row) => ({
      id: row.session_id,
      goal: row.goal ?? undefined,
      presetName: row.preset_name ?? undefined,
      status: row.status as Session["status"],
      createdAt: row.started_at,
      completedAt: row.ended_at ?? undefined,
      stopReason: row.stop_reason ?? undefined,
      topology: undefined,
      contributionCount: row.contribution_count,
      // config and topology intentionally omitted from list results for performance
    }));
  };

  /** Create a new session with a generated UUID. */
  createSession = async (input: CreateSessionInput): Promise<Session> => {
    this.stmtInsertSession ??= this.db.prepare(`
      INSERT INTO sessions (session_id, goal, preset_name, topology_json, config_json, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `);

    const sessionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const topologyJson = input.topology ? JSON.stringify(input.topology) : null;
    const configJson = input.config ? JSON.stringify(input.config) : "{}";
    this.stmtInsertSession.run(
      sessionId,
      input.goal ?? null,
      input.presetName ?? null,
      topologyJson,
      configJson,
      startedAt,
    );

    return {
      id: sessionId,
      goal: input.goal,
      presetName: input.presetName,
      status: "active",
      createdAt: startedAt,
      completedAt: undefined,
      topology: input.topology,
      contributionCount: 0,
      config: input.config,
    };
  };

  /** Get a single session by ID with computed contribution count. */
  getSession = async (sessionId: string): Promise<Session | undefined> => {
    this.stmtGetSession ??= this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM session_contributions WHERE session_id = s.session_id) AS contribution_count
      FROM sessions s
      WHERE s.session_id = ?
    `);

    const row = this.stmtGetSession.get(sessionId) as SessionWithCountRow | null;
    return row !== null ? rowToSession(row) : undefined;
  };

  /** Get the frozen contract config for a session by ID. */
  getSessionConfig = async (sessionId: string): Promise<GroveContract | undefined> => {
    return this.getSessionConfigSync(sessionId);
  };

  /** Synchronous variant — used by runtime bootstrap where async is unavailable. */
  getSessionConfigSync = (sessionId: string): GroveContract | undefined => {
    const row = this.db
      .prepare("SELECT config_json FROM sessions WHERE session_id = ?")
      .get(sessionId) as { config_json: string | null } | null;
    if (!row?.config_json || row.config_json === "{}") return undefined;
    try {
      return JSON.parse(row.config_json) as GroveContract;
    } catch {
      return undefined;
    }
  };

  /** Update mutable session fields. */
  updateSession = async (
    sessionId: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason">>,
  ): Promise<void> => {
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];

    if (updates.status !== undefined) {
      setClauses.push("status = ?");
      params.push(updates.status);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push("ended_at = ?");
      params.push(updates.completedAt);
    }
    if (updates.stopReason !== undefined) {
      setClauses.push("stop_reason = ?");
      params.push(updates.stopReason);
    }

    if (setClauses.length === 0) return;

    params.push(sessionId);
    this.db
      .prepare(`UPDATE sessions SET ${setClauses.join(", ")} WHERE session_id = ?`)
      .run(...params);
  };

  /** Archive a session by setting status to 'archived' and recording ended_at. */
  archiveSession = async (sessionId: string): Promise<void> => {
    this.stmtArchiveSession ??= this.db.prepare(`
      UPDATE sessions SET status = 'archived', ended_at = ? WHERE session_id = ?
    `);

    const endedAt = new Date().toISOString();
    this.stmtArchiveSession.run(endedAt, sessionId);
  };

  /** Record a contribution CID against a session. Ignores duplicates. */
  addContributionToSession = async (sessionId: string, cid: string): Promise<void> => {
    this.stmtInsertContribution ??= this.db.prepare(`
      INSERT OR IGNORE INTO session_contributions (session_id, cid, added_at)
      VALUES (?, ?, ?)
    `);

    const addedAt = new Date().toISOString();
    this.stmtInsertContribution.run(sessionId, cid, addedAt);
  };

  /** Get all contribution CIDs for a session, ordered by when they were added. */
  getSessionContributions = async (sessionId: string): Promise<readonly string[]> => {
    this.stmtGetContributions ??= this.db.prepare(`
      SELECT cid FROM session_contributions
      WHERE session_id = ?
      ORDER BY added_at ASC
    `);

    const rows = this.stmtGetContributions.all(sessionId) as { cid: string }[];
    return rows.map((r) => r.cid);
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Release resources.
   *
   * No-op when used via createSqliteStores() — the factory's close() owns the
   * shared Database instance.
   */
  close(): void {
    // Intentionally empty — db lifecycle is managed by the factory.
  }
}
