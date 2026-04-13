/**
 * SQLite-backed goal and session store.
 *
 * Uses the shared Database instance from initSqliteDb().
 * Goals use a single-row upsert pattern (id=1 CHECK constraint).
 * Sessions track work periods with an optional goal reference.
 *
 * Session staleness is managed via `archived_at` (Unix epoch INTEGER):
 *   - NULL  → session is live and visible by default
 *   - non-NULL → session is archived and excluded from default list queries
 *
 * Contribution counts are maintained as a denormalized column on `sessions`,
 * updated by INSERT/DELETE triggers on `session_contributions`. This avoids
 * a full GROUP BY subquery on every listSessions() call.
 */

import type { Database, Statement } from "bun:sqlite";
import type { GroveContract } from "../core/contract.js";
import type { CreateSessionInput, Session, SessionQuery } from "../core/session.js";
import { resolveRoleWorkspaceStrategies } from "../core/topology.js";
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
    worktree_strategy_json TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    stop_reason TEXT,
    archived_at INTEGER,
    contribution_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS session_contributions (
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    cid TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (session_id, cid)
  );

  CREATE INDEX IF NOT EXISTS idx_session_contributions_session_id ON session_contributions(session_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived_at);

  CREATE TRIGGER IF NOT EXISTS trg_sc_insert
  AFTER INSERT ON session_contributions
  BEGIN
    UPDATE sessions SET contribution_count = contribution_count + 1
    WHERE session_id = NEW.session_id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_sc_delete
  AFTER DELETE ON session_contributions
  BEGIN
    UPDATE sessions SET contribution_count = contribution_count - 1
    WHERE session_id = OLD.session_id;
  END;
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
  worktree_strategy_json: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  stop_reason: string | null;
  archived_at: number | null;
  contribution_count: number;
}

/**
 * Row type for list queries — omits topology_json and config_json which are
 * excluded from SELECT for performance. Types match runtime reality.
 */
interface SessionListRow {
  session_id: string;
  goal: string | null;
  preset_name: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  stop_reason: string | null;
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

  /** Archive a session, setting its ended_at timestamp and archived_at epoch. */
  archiveSession(sessionId: string): Promise<void>;

  /** Record a contribution CID against a session. */
  addContributionToSession(sessionId: string, cid: string): Promise<void>;

  /** Get all contribution CIDs for a session. */
  getSessionContributions(sessionId: string): Promise<readonly string[]>;

  /** Get the frozen contract config for a session by ID. */
  getSessionConfig(sessionId: string): Promise<GroveContract | undefined>;

  /** Synchronous variant — used by runtime bootstrap where async is unavailable. */
  getSessionConfigSync(sessionId: string): GroveContract | undefined;

  /**
   * Archive sessions that have been inactive longer than ttlMs.
   * Only affects sessions whose status is not 'active' or 'pending'.
   * Returns the number of sessions archived.
   */
  gcStaleSessions(ttlMs?: number): number;

  /** Release resources. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default TTL for auto-archiving inactive sessions (24 hours). */
export const SESSION_GC_TTL_MS: number = 24 * 60 * 60 * 1000;

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

/** Convert a SessionRow (full) to a Session domain object. */
function rowToSession(row: SessionRow): Session {
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
    worktreeStrategies: row.worktree_strategy_json
      ? (JSON.parse(row.worktree_strategy_json) as Record<string, string>)
      : undefined,
  };
}

/** Convert a SessionListRow (no heavy columns) to a Session domain object. */
function listRowToSession(row: SessionListRow): Session {
  return {
    id: row.session_id,
    goal: row.goal ?? undefined,
    presetName: row.preset_name ?? undefined,
    status: row.status as Session["status"],
    createdAt: row.started_at,
    completedAt: row.ended_at ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    topology: undefined,
    contributionCount: row.contribution_count,
    // config intentionally omitted from list results for performance
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** SQLite-backed GoalSessionStore. */
export class SqliteGoalSessionStore implements GoalSessionStore {
  readonly db: Database;

  // Prepared statements (lazy init)
  private stmtGetGoal: Statement | undefined;
  private stmtUpsertGoal: Statement | undefined;
  private stmtGetSession: Statement | undefined;
  private stmtInsertSession: Statement | undefined;
  private stmtArchiveSession: Statement | undefined;
  private stmtInsertContribution: Statement | undefined;
  private stmtGetContributions: Statement | undefined;
  // Typed update statements for common patterns
  private stmtCompleteSession: Statement | undefined; // status + ended_at + stop_reason
  private stmtStatusOnly: Statement | undefined; // status only
  private stmtEndedAndReason: Statement | undefined; // ended_at + stop_reason only

  constructor(db: Database) {
    this.db = db;
    db.exec(GOAL_SESSION_DDL);
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

  /**
   * List sessions with denormalized contribution counts.
   *
   * Default behavior excludes archived sessions (archived_at IS NOT NULL) and
   * caps results at 20, ordered by creation time descending. Pass
   * `{ status: 'archived' }` to retrieve archived sessions, or
   * `{ includeArchived: true }` to retrieve all sessions without status filter.
   *
   * topology_json and config_json are intentionally omitted — use
   * getSession()/getSessionConfig() for those.
   */
  listSessions = async (query?: SessionQuery): Promise<readonly Session[]> => {
    const baseSelect = `
      SELECT s.session_id, s.goal, s.preset_name, s.status, s.started_at, s.ended_at,
             s.stop_reason, s.contribution_count
      FROM sessions s
    `;

    const conditions: string[] = [];
    const params: string[] = [];

    if (query?.status !== undefined) {
      // Explicit status filter — takes precedence over includeArchived
      conditions.push("s.status = ?");
      params.push(query.status);
    } else if (!query?.includeArchived) {
      // Default: exclude archived sessions
      conditions.push("s.archived_at IS NULL");
    }

    if (query?.presetName !== undefined) {
      conditions.push("s.preset_name = ?");
      params.push(query.presetName);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    // Apply LIMIT only for default (unfiltered) queries; explicit queries get all results.
    const limitClause = query?.status === undefined && !query?.includeArchived ? " LIMIT 20" : "";

    const rows = this.db
      .prepare(`${baseSelect}${where} ORDER BY s.started_at DESC${limitClause}`)
      .all(...params) as SessionListRow[];

    return rows.map(listRowToSession);
  };

  /** Create a new session with a generated UUID. */
  createSession = async (input: CreateSessionInput): Promise<Session> => {
    this.stmtInsertSession ??= this.db.prepare(`
      INSERT INTO sessions (session_id, goal, preset_name, topology_json, config_json, worktree_strategy_json, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `);

    const sessionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const topologyJson = input.topology ? JSON.stringify(input.topology) : null;
    const configJson = input.config ? JSON.stringify(input.config) : "{}";
    // Resolve and store workspace strategies so operators can see which roles
    // branched off which source branch at session creation time.
    const worktreeStrategies = input.topology
      ? Object.fromEntries(resolveRoleWorkspaceStrategies(input.topology, sessionId))
      : null;
    const worktreeStrategyJson = worktreeStrategies ? JSON.stringify(worktreeStrategies) : null;

    this.stmtInsertSession.run(
      sessionId,
      input.goal ?? null,
      input.presetName ?? null,
      topologyJson,
      configJson,
      worktreeStrategyJson,
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
      worktreeStrategies: worktreeStrategies ?? undefined,
    };
  };

  /** Get a single session by ID using the denormalized contribution_count column. */
  getSession = async (sessionId: string): Promise<Session | undefined> => {
    this.stmtGetSession ??= this.db.prepare("SELECT * FROM sessions WHERE session_id = ?");
    const row = this.stmtGetSession.get(sessionId) as SessionRow | null;
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

  /**
   * Update mutable session fields using cached prepared statements for the
   * three common call patterns. Falls back to dynamic SQL for unusual combos.
   *
   * When status is set to 'archived', also sets archived_at and ended_at so
   * that callers using updateSession({ status: 'archived' }) behave identically
   * to calling archiveSession() directly.
   */
  updateSession = async (
    sessionId: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason">>,
  ): Promise<void> => {
    const hasStatus = updates.status !== undefined;
    const hasCompletedAt = updates.completedAt !== undefined;
    const hasStopReason = updates.stopReason !== undefined;

    // Route archiving through archiveSession() for consistency
    if (hasStatus && updates.status === "archived") {
      await this.archiveSession(sessionId);
      // Also apply completedAt/stopReason overrides if provided
      if (hasCompletedAt || hasStopReason) {
        await this.updateSession(sessionId, {
          ...(hasCompletedAt ? { completedAt: updates.completedAt } : {}),
          ...(hasStopReason ? { stopReason: updates.stopReason } : {}),
        });
      }
      return;
    }

    const status = updates.status;
    const completedAt = updates.completedAt;
    const stopReason = updates.stopReason;

    // Pattern: all three fields — most common from session completion
    if (hasStatus && hasCompletedAt && hasStopReason && status && completedAt && stopReason) {
      this.stmtCompleteSession ??= this.db.prepare(
        "UPDATE sessions SET status = ?, ended_at = ?, stop_reason = ? WHERE session_id = ?",
      );
      this.stmtCompleteSession.run(status, completedAt, stopReason, sessionId);
      return;
    }

    // Pattern: status only
    if (hasStatus && !hasCompletedAt && !hasStopReason && status) {
      this.stmtStatusOnly ??= this.db.prepare(
        "UPDATE sessions SET status = ? WHERE session_id = ?",
      );
      this.stmtStatusOnly.run(status, sessionId);
      return;
    }

    // Pattern: ended_at + stop_reason (no status)
    if (!hasStatus && hasCompletedAt && hasStopReason && completedAt && stopReason) {
      this.stmtEndedAndReason ??= this.db.prepare(
        "UPDATE sessions SET ended_at = ?, stop_reason = ? WHERE session_id = ?",
      );
      this.stmtEndedAndReason.run(completedAt, stopReason, sessionId);
      return;
    }

    // Fallback: dynamic SQL for remaining combinations
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];

    if (status) {
      setClauses.push("status = ?");
      params.push(status);
    }
    if (completedAt) {
      setClauses.push("ended_at = ?");
      params.push(completedAt);
    }
    if (stopReason) {
      setClauses.push("stop_reason = ?");
      params.push(stopReason);
    }

    if (setClauses.length === 0) return;

    params.push(sessionId);
    this.db
      .prepare(`UPDATE sessions SET ${setClauses.join(", ")} WHERE session_id = ?`)
      .run(...params);
  };

  /**
   * Archive a session: sets status='archived', ended_at (if not already set),
   * and archived_at to the current Unix epoch.
   */
  archiveSession = async (sessionId: string): Promise<void> => {
    this.stmtArchiveSession ??= this.db.prepare(`
      UPDATE sessions
      SET status = 'archived',
          ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          archived_at = strftime('%s', 'now')
      WHERE session_id = ?
    `);
    this.stmtArchiveSession.run(sessionId);
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

  /**
   * Archive sessions inactive longer than ttlMs that are not active/pending.
   *
   * Safe to call repeatedly — sessions already archived (archived_at IS NOT NULL)
   * are skipped. Returns the number of sessions newly archived.
   */
  gcStaleSessions(ttlMs: number = SESSION_GC_TTL_MS): number {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    // Use ended_at as the staleness basis when available (falls back to started_at
    // for sessions that never formally ended). This prevents long-running sessions
    // from being GC'd immediately after completion just because they started > TTL ago.
    const result = this.db.run(
      `UPDATE sessions
       SET status = 'archived',
           ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           archived_at = strftime('%s', 'now')
       WHERE archived_at IS NULL
         AND status NOT IN ('active', 'pending')
         AND COALESCE(ended_at, started_at) < ?`,
      [cutoff],
    );
    return result.changes;
  }

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
