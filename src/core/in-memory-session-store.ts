import type { Session, SessionStore } from "./session-manager.js";

/**
 * In-memory session store. Suitable for testing and single-process CLI usage.
 * Sessions are lost on process restart.
 */
export class InMemorySessionStore implements SessionStore {
  private sessions: Session[] = [];

  async create(session: Session): Promise<void> {
    this.sessions.push(session);
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.find((s) => s.id === id);
  }

  async update(
    id: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason">>,
  ): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    this.sessions[idx] = { ...this.sessions[idx]!, ...updates };
  }

  async list(presetName?: string): Promise<readonly Session[]> {
    const filtered = presetName
      ? this.sessions.filter((s) => s.presetName === presetName)
      : this.sessions;
    // Most recent first — reverse preserves insertion-order tiebreak
    // when timestamps are identical (sub-millisecond creates)
    return [...filtered].reverse();
  }

  async latest(presetName?: string): Promise<Session | undefined> {
    const all = await this.list(presetName);
    return all[0];
  }
}
