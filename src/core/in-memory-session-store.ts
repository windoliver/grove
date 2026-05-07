import { randomUUID } from "node:crypto";
import { DEFAULT_SESSION_FINALIZERS } from "./lifecycle-metadata.js";
import type { CreateSessionInput, Session, SessionQuery, SessionStore } from "./session.js";

/**
 * In-memory session store. Suitable for testing and single-process CLI usage.
 * Sessions are lost on process restart.
 */
export class InMemorySessionStore implements SessionStore {
  private sessions: Session[] = [];
  private readonly contributions = new Map<string, string[]>();

  async createSession(input: CreateSessionInput): Promise<Session> {
    const id = randomUUID().slice(0, 8);
    const session: Session = {
      id,
      uid: id,
      goal: input.goal,
      presetName: input.presetName,
      topology: input.topology,
      status: "pending",
      createdAt: new Date().toISOString(),
      finalizers: DEFAULT_SESSION_FINALIZERS,
      contributionCount: 0,
    };
    this.sessions.push(session);
    return session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    const cids = this.contributions.get(id) ?? [];
    return { ...session, contributionCount: cids.length };
  }

  async updateSession(
    id: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason" | "stopStatus">>,
  ): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const existing = this.sessions[idx];
    if (!existing) return;
    this.sessions[idx] = { ...existing, ...updates };
  }

  async listSessions(query?: SessionQuery): Promise<readonly Session[]> {
    let filtered = this.sessions;
    if (query?.status) {
      // Explicit status filter takes precedence over includeArchived
      filtered = filtered.filter((s) => s.status === query.status);
    } else if (!query?.includeArchived) {
      // Default: exclude archived sessions
      filtered = filtered.filter((s) => s.status !== "archived");
    }
    if (query?.presetName) {
      filtered = filtered.filter((s) => s.presetName === query.presetName);
    }
    // Most recent first
    return [...filtered].reverse().map((s) => {
      const cids = this.contributions.get(s.id) ?? [];
      return { ...s, contributionCount: cids.length };
    });
  }

  async archiveSession(id: string): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const existing = this.sessions[idx];
    if (!existing) return;
    this.sessions[idx] = {
      ...existing,
      status: "archived",
      completedAt: new Date().toISOString(),
    };
  }

  async addContribution(sessionId: string, cid: string): Promise<void> {
    let cids = this.contributions.get(sessionId);
    if (!cids) {
      cids = [];
      this.contributions.set(sessionId, cids);
    }
    if (!cids.includes(cid)) {
      cids.push(cid);
    }
  }

  async getContributions(sessionId: string): Promise<readonly string[]> {
    return this.contributions.get(sessionId) ?? [];
  }
}
