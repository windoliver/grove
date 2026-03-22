/**
 * Manages session lifecycle within a grove.
 *
 * A grove has one preset (the topology/contract). Sessions are instances
 * of that preset, each with a different goal. Previous sessions are
 * preserved in the DAG for reference.
 *
 * Flow:
 *   grove init --preset review-loop  -> creates GROVE.md (one-time)
 *   grove up                         -> SessionManager.createSession(goal)
 *   next time: grove up              -> SessionManager.createSession(newGoal)
 */

import { randomUUID } from "node:crypto";

/** A session instance within a grove. */
export interface Session {
  readonly id: string;
  readonly goal: string;
  readonly presetName: string;
  readonly createdAt: string;
  readonly status: "pending" | "running" | "completed" | "cancelled";
  readonly completedAt?: string;
  readonly stopReason?: string;
}

/** Session creation input. */
export interface CreateSessionInput {
  readonly goal: string;
  readonly presetName: string;
}

/** Session store interface — persists session metadata. */
export interface SessionStore {
  create(session: Session): Promise<void>;
  get(id: string): Promise<Session | undefined>;
  update(
    id: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason">>,
  ): Promise<void>;
  list(presetName?: string): Promise<readonly Session[]>;
  latest(presetName?: string): Promise<Session | undefined>;
}

/**
 * Manages sessions for a grove.
 */
export class SessionManager {
  private readonly store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /** Create a new session. */
  async createSession(input: CreateSessionInput): Promise<Session> {
    const session: Session = {
      id: randomUUID().slice(0, 8),
      goal: input.goal,
      presetName: input.presetName,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    await this.store.create(session);
    return session;
  }

  /** Mark a session as running. */
  async startSession(id: string): Promise<void> {
    await this.store.update(id, { status: "running" });
  }

  /** Mark a session as completed. */
  async completeSession(id: string, reason?: string): Promise<void> {
    await this.store.update(id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      ...(reason !== undefined ? { stopReason: reason } : {}),
    });
  }

  /** Cancel a session. */
  async cancelSession(id: string, reason?: string): Promise<void> {
    await this.store.update(id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      stopReason: reason ?? "User cancelled",
    });
  }

  /** Get the most recent session. */
  async latestSession(presetName?: string): Promise<Session | undefined> {
    return this.store.latest(presetName);
  }

  /** List all sessions, optionally filtered by preset. */
  async listSessions(presetName?: string): Promise<readonly Session[]> {
    return this.store.list(presetName);
  }

  /** Check if there's an active (running) session. */
  async hasActiveSession(): Promise<boolean> {
    const sessions = await this.store.list();
    return sessions.some((s) => s.status === "running");
  }
}
