/**
 * Unified session types — canonical definitions used by core, CLI, server, and TUI.
 *
 * Replaces the previously split Session (session-manager.ts) and
 * SessionRecord (tui/provider.ts) types with a single source of truth.
 */

import type { GroveContract } from "./contract.js";
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
  readonly goal?: string | undefined;
  readonly presetName?: string | undefined;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly completedAt?: string | undefined;
  readonly stopReason?: string | undefined;
  /** Resolved topology at session creation time (immutable once set). */
  readonly topology?: AgentTopology | undefined;
  /** Number of contributions linked to this session. */
  readonly contributionCount: number;
  /** Frozen contract snapshot at session creation time. */
  readonly config?: GroveContract | undefined;
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

  /** Update mutable session fields (status, completedAt, stopReason). */
  updateSession(
    id: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason">>,
  ): Promise<void>;

  /** List sessions with optional filters, ordered by creation time descending. */
  listSessions(query?: SessionQuery): Promise<readonly Session[]>;

  /** Archive a session, setting its completedAt timestamp. */
  archiveSession(id: string): Promise<void>;

  /** Record a contribution CID against a session. */
  addContribution(sessionId: string, cid: string): Promise<void>;

  /** Get all contribution CIDs for a session, ordered by time added. */
  getContributions(sessionId: string): Promise<readonly string[]>;
}
