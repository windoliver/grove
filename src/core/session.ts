/**
 * Unified session types — canonical definitions used by core, CLI, server, and TUI.
 *
 * Replaces the previously split Session (session-manager.ts) and
 * SessionRecord (tui/provider.ts) types with a single source of truth.
 */

import type { CasMutationResult, CasOpts } from "./cas.js";
import type { GroveContract } from "./contract.js";
import type { DeletionAuditEvent, SessionFinalizer } from "./lifecycle-metadata.js";
import type { LoopStopStatus } from "./loop-runner.js";
import type { AgentTopology } from "./topology.js";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Canonical session lifecycle status.
 *
 * pending   → session created, agents not yet spawned
 * active    → agents are running
 * completed → session finished successfully
 * cancelled → session was cancelled (by user or error)
 * archived  → session was explicitly archived by operator
 */
export type SessionStatus = "pending" | "active" | "completed" | "cancelled" | "archived";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** A session instance within a grove. */
export interface Session {
  readonly id: string;
  readonly uid: string;
  readonly goal?: string | undefined;
  readonly presetName?: string | undefined;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly finalizers: readonly SessionFinalizer[];
  readonly deletionTimestamp?: string | undefined;
  readonly deletionAudit?: readonly DeletionAuditEvent[] | undefined;
  readonly completedAt?: string | undefined;
  readonly stopReason?: string | undefined;
  /** Machine-readable final loop status for operator UI and automation. */
  readonly stopStatus?: LoopStopStatus | undefined;
  /**
   * Resolved effective topology at session creation time.
   * Runtime skill acquisition may append an authorized skill to a role's
   * `skills` list; all other topology fields remain immutable after creation.
   */
  readonly topology?: AgentTopology | undefined;
  /** Number of contributions linked to this session. */
  readonly contributionCount: number;
  /** Frozen contract snapshot at session creation time. */
  readonly config?: GroveContract | undefined;
  /**
   * Resolved workspace base-branch per role.
   * Format: { "coder": "HEAD", "reviewer": "grove/<sessionId>/coder" }
   * Edges with `workspace: "branch_from_source"` make the target branch off the source.
   */
  readonly worktreeStrategies?: Record<string, string> | undefined;
  /**
   * Optimistic-concurrency resource version persisted by the store (C6, #304).
   * Optional: legacy stores that have not yet been migrated emit `undefined`,
   * in which case CAS callers should treat the entity as version "1".
   */
  readonly resourceVersion?: number | undefined;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Input for creating a new session. */
export interface CreateSessionInput {
  readonly goal?: string | undefined;
  readonly presetName?: string | undefined;
  /** Fully resolved topology to store with the session. */
  readonly topology?: AgentTopology | undefined;
  /** Frozen contract snapshot to store with the session. */
  readonly config?: GroveContract | undefined;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/** Query filter for listing sessions. */
export interface SessionQuery {
  readonly status?: SessionStatus | undefined;
  readonly presetName?: string | undefined;
  /**
   * When true, include archived sessions in results.
   * Default behavior (false/undefined) excludes archived sessions.
   * Has no effect when `status` is explicitly set — a status filter
   * always takes precedence.
   */
  readonly includeArchived?: boolean | undefined;
}

export interface SessionDeleteOptions {
  readonly force?: boolean | undefined;
  readonly actor?: string | undefined;
}

export interface SessionDeleteBlocker {
  readonly finalizer: SessionFinalizer;
  readonly message: string;
}

export interface SessionDeleteResult {
  readonly sessionId: string;
  readonly deleted: boolean;
  readonly forced: boolean;
  readonly blockers: readonly SessionDeleteBlocker[];
  readonly warning?: string | undefined;
  readonly cleanupErrors?: readonly string[] | undefined;
}

/**
 * Session store interface — persists session metadata.
 *
 * Implementations: InMemorySessionStore, SqliteGoalSessionStore, NexusSessionStore.
 */
export interface SessionStore {
  /** Create a new session and return it with a generated ID. */
  createSession(input: CreateSessionInput): Promise<Session>;

  /** Get a session by ID. Returns undefined if not found. */
  getSession(id: string): Promise<Session | undefined>;

  /**
   * Update mutable session fields (status, completedAt, stopReason, stopStatus).
   *
   * C6 (#304): Accepts an optional `ifMatch` resource version. When supplied,
   * the store performs a compare-and-set against the persisted session
   * `resource_version`. Mismatch returns `{ kind: "rv-mismatch", current }`
   * without writing; match (or absent ifMatch on back-compat path) writes and
   * returns `{ kind: "ok", view }` with the bumped session RV.
   *
   * Missing-session is a no-op (returns `{ kind: "ok", view: undefined }`)
   * to preserve the legacy idempotency contract.
   */
  updateSession(
    id: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason" | "stopStatus">>,
    opts?: CasOpts,
  ): Promise<CasMutationResult<Session | undefined>>;

  /** List sessions with optional filters, ordered by creation time descending. */
  listSessions(query?: SessionQuery): Promise<readonly Session[]>;

  /**
   * Delete a session.
   *
   * C6 (#304): The supplied `options` may carry an `ifMatch` resource version.
   * When supplied, the store performs a compare-and-set against the persisted
   * session `resource_version` BEFORE running finalizers / removing the row.
   * Mismatch returns `{ kind: "rv-mismatch", current }` without writing; match
   * (or absent ifMatch on back-compat path) proceeds with the delete and
   * returns `{ kind: "ok", view }`.
   */
  deleteSession(
    id: string,
    options?: SessionDeleteOptions & CasOpts,
  ): Promise<CasMutationResult<SessionDeleteResult>>;

  listSessionDeleteBlockers(id: string): Promise<readonly SessionDeleteBlocker[]>;

  /**
   * Archive a session, setting its completedAt timestamp.
   *
   * C6 (#304): Accepts an optional `ifMatch` resource version. Semantics
   * mirror `updateSession`: mismatch returns rv-mismatch without writing,
   * match writes and bumps RV. Missing-session is a no-op (kind: "ok",
   * view: undefined) for back-compat.
   */
  archiveSession(id: string, opts?: CasOpts): Promise<CasMutationResult<Session | undefined>>;

  /** Record a contribution CID against a session. */
  addContribution(sessionId: string, cid: string): Promise<void>;

  /** Get all contribution CIDs for a session, ordered by time added. */
  getContributions(sessionId: string): Promise<readonly string[]>;
}

export type AppendSessionRoleSkillResult =
  | "appended"
  | "already_present"
  | "session_missing"
  | "role_missing";

export interface RuntimeSkillSessionStore {
  appendSessionRoleSkill(
    sessionId: string,
    roleName: string,
    skillName: string,
  ): Promise<AppendSessionRoleSkillResult>;
}

export interface AppendSkillToTopologyResult {
  readonly topology: AgentTopology;
  readonly foundRole: boolean;
  readonly changed: boolean;
}

export function appendSkillToTopology(
  topology: AgentTopology,
  roleName: string,
  skillName: string,
): AppendSkillToTopologyResult {
  let foundRole = false;
  let changed = false;
  const roles = topology.roles.map((role) => {
    if (role.name !== roleName) return { ...role };
    foundRole = true;
    const currentSkills = role.skills ?? [];
    if (currentSkills.includes(skillName)) return { ...role };
    changed = true;
    return { ...role, skills: [...currentSkills, skillName] };
  });

  return {
    topology: changed ? { ...topology, roles } : topology,
    foundRole,
    changed,
  };
}

export function appendSkillToSessionConfigTopology(
  config: GroveContract | undefined,
  roleName: string,
  skillName: string,
): {
  readonly config: GroveContract | undefined;
  readonly changed: boolean;
} {
  if (config?.topology === undefined) {
    return { config, changed: false };
  }
  const result = appendSkillToTopology(config.topology, roleName, skillName);
  if (!result.foundRole || !result.changed) {
    return { config, changed: false };
  }
  return {
    config: { ...config, topology: result.topology },
    changed: true,
  };
}
