/**
 * Manages session lifecycle within a grove.
 *
 * Wraps a SessionStore with state-machine validation for status transitions.
 *
 * Flow:
 *   grove init --preset review-loop  -> creates GROVE.md (one-time)
 *   grove up                         -> SessionManager.createSession(goal)
 *   next time: grove up              -> SessionManager.createSession(newGoal)
 */

import { expectCasOk } from "./cas.js";
import type { LoopStopStatus } from "./loop-runner.js";
import type {
  CreateSessionInput,
  Session,
  SessionQuery,
  SessionStatus,
  SessionStore,
} from "./session.js";

/**
 * Manages sessions for a grove with validated state transitions.
 */
export class SessionManager {
  private readonly store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /** Valid state transitions. */
  private static readonly VALID_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
    pending: ["active", "cancelled"],
    active: ["completed", "cancelled", "archived"],
    completed: ["archived"],
    cancelled: ["archived"],
    archived: [],
  };

  /** Create a new session. */
  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.store.createSession(input);
  }

  /** Mark a session as active (agents running). */
  async startSession(id: string): Promise<void> {
    await this.transitionState(id, "active");
  }

  /** Mark a session as completed. */
  async completeSession(id: string, reason?: string, stopStatus?: LoopStopStatus): Promise<void> {
    await this.transitionState(id, "completed", {
      completedAt: new Date().toISOString(),
      ...(reason !== undefined ? { stopReason: reason } : {}),
      ...(stopStatus !== undefined ? { stopStatus } : {}),
    });
  }

  /** Cancel a session. */
  async cancelSession(id: string, reason?: string, stopStatus?: LoopStopStatus): Promise<void> {
    await this.transitionState(id, "cancelled", {
      completedAt: new Date().toISOString(),
      stopReason: reason ?? "User cancelled",
      ...(stopStatus !== undefined ? { stopStatus } : {}),
    });
  }

  /** Archive a session. */
  async archiveSession(id: string): Promise<void> {
    const session = await this.store.getSession(id);
    if (!session) {
      throw new Error(`Session '${id}' not found`);
    }
    const allowed = SessionManager.VALID_TRANSITIONS[session.status] ?? [];
    if (!allowed.includes("archived")) {
      throw new Error(
        `Invalid session state transition: ${session.status} → archived (allowed: ${allowed.join(", ") || "none"})`,
      );
    }
    // C6 (#304): controller does not yet supply ifMatch; rv-mismatch here
    // would indicate a programming error until T6 + T7 wire If-Match.
    const result = await this.store.archiveSession(id);
    expectCasOk(result, `SessionManager.archiveSession(${id})`);
  }

  /** Validate and perform a state transition. */
  private async transitionState(
    id: string,
    newStatus: SessionStatus,
    extraFields?: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.store.getSession(id);
    if (!session) {
      throw new Error(`Session '${id}' not found`);
    }
    const allowed = SessionManager.VALID_TRANSITIONS[session.status] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid session state transition: ${session.status} → ${newStatus} (allowed: ${allowed.join(", ") || "none"})`,
      );
    }
    const result = await this.store.updateSession(id, {
      status: newStatus,
      ...extraFields,
    });
    expectCasOk(result, `SessionManager.transitionState(${id} -> ${newStatus})`);
  }

  /** Get a session by ID. */
  async getSession(id: string): Promise<Session | undefined> {
    return this.store.getSession(id);
  }

  /** Get the most recent session. */
  async latestSession(presetName?: string): Promise<Session | undefined> {
    const sessions = await this.store.listSessions(presetName ? { presetName } : undefined);
    return sessions[0];
  }

  /** List all sessions, optionally filtered. */
  async listSessions(query?: SessionQuery): Promise<readonly Session[]> {
    return this.store.listSessions(query);
  }

  /** Check if there's an active session. */
  async hasActiveSession(): Promise<boolean> {
    const sessions = await this.store.listSessions();
    return sessions.some((s) => s.status === "active");
  }
}
