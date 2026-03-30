/**
 * SQLite-backed goal and session store.
 *
 * Uses the shared Database instance from initSqliteDb().
 * Goals use a single-row upsert pattern (id=1 CHECK constraint).
 * Sessions track work periods with an optional goal reference.
 * Session contributions are tracked in a join table for COUNT queries.
 */

import type { Database, Statement } from "bun:sqlite";
import type { GoalData, SessionInput, SessionRecord } from "../tui/provider.js";

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
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    ended_at TEXT
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
  status: string;
  started_at: string;
  ended_at: string | null;
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
  listSessions(query?: {
    status?: "active" | "archived";
    presetName?: string;
  }): Promise<readonly SessionRecord[]>;

  /** Create a new session. */
  createSession(input: SessionInput): Promise<SessionRecord>;

  /** Get a session by ID. */
  getSession(sessionId: string): Promise<SessionRecord | undefined>;

  /** Archive a session, setting its ended_at timestamp. */
  archiveSession(sessionId: string): Promise<void>;

  /** Record a contribution CID against a session. */
  addContributionToSession(sessionId: string, cid: string): Promise<void>;

  /** Get all contribution CIDs for a session. */
  getSessionContributions(sessionId: string): Promise<readonly string[]>;

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

/** Convert a SessionWithCountRow to a SessionRecord domain object. */
function rowToSessionRecord(row: SessionWithCountRow): SessionRecord {
  return {
    sessionId: row.session_id,
    goal: row.goal ?? undefined,
    presetName: row.preset_name ?? undefined,
    status: row.status as SessionRecord["status"],
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    contributionCount: row.contribution_count,
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

  /** List sessions with computed contribution counts, optionally filtered by status and/or preset. */
  listSessions = async (query?: {
    status?: "active" | "archived";
    presetName?: string;
  }): Promise<readonly SessionRecord[]> => {
    const baseSelect = `
      SELECT s.*, COALESCE(c.cnt, 0) AS contribution_count
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
    return rows.map(rowToSessionRecord);
  };

  /** Create a new session with a generated UUID. */
  createSession = async (input: SessionInput): Promise<SessionRecord> => {
    this.stmtInsertSession ??= this.db.prepare(`
      INSERT INTO sessions (session_id, goal, preset_name, status, started_at)
      VALUES (?, ?, ?, 'active', ?)
    `);

    const sessionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    this.stmtInsertSession.run(sessionId, input.goal ?? null, input.presetName ?? null, startedAt);

    return {
      sessionId,
      goal: input.goal,
      presetName: input.presetName,
      status: "active",
      startedAt,
      endedAt: undefined,
      contributionCount: 0,
    };
  };

  /** Get a single session by ID with computed contribution count. */
  getSession = async (sessionId: string): Promise<SessionRecord | undefined> => {
    this.stmtGetSession ??= this.db.prepare(`
      SELECT s.*, COALESCE(c.cnt, 0) AS contribution_count
      FROM sessions s
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS cnt
        FROM session_contributions
        GROUP BY session_id
      ) c ON c.session_id = s.session_id
      WHERE s.session_id = ?
    `);

    const row = this.stmtGetSession.get(sessionId) as SessionWithCountRow | null;
    return row !== null ? rowToSessionRecord(row) : undefined;
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
