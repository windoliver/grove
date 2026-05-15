import { randomUUID } from "node:crypto";
import {
  appendDeletionAudit,
  DEFAULT_SESSION_FINALIZERS,
  Finalizer,
} from "./lifecycle-metadata.js";
import type {
  AppendSessionRoleSkillResult,
  CreateSessionInput,
  RuntimeSkillSessionStore,
  Session,
  SessionDeleteBlocker,
  SessionDeleteOptions,
  SessionDeleteResult,
  SessionQuery,
  SessionStore,
} from "./session.js";
import { appendSkillToSessionConfigTopology, appendSkillToTopology } from "./session.js";

/**
 * In-memory session store. Suitable for testing and single-process CLI usage.
 * Sessions are lost on process restart.
 */
export class InMemorySessionStore implements SessionStore, RuntimeSkillSessionStore {
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
      config: input.config,
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

  async listSessionDeleteBlockers(id: string): Promise<readonly SessionDeleteBlocker[]> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }];
    return [];
  }

  async deleteSession(id: string, options?: SessionDeleteOptions): Promise<SessionDeleteResult> {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) {
      return {
        sessionId: id,
        deleted: false,
        forced: false,
        blockers: [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }],
      };
    }
    const existing = this.sessions[idx];
    if (!existing) {
      return { sessionId: id, deleted: false, forced: false, blockers: [] };
    }
    const warning =
      options?.force === true
        ? `force delete skipped finalizer waits for session ${id}`
        : undefined;
    if (warning !== undefined) {
      this.sessions[idx] = {
        ...existing,
        deletionTimestamp: existing.deletionTimestamp ?? new Date().toISOString(),
        deletionAudit: appendDeletionAudit(existing.deletionAudit, {
          at: new Date().toISOString(),
          actor: options?.actor ?? "unknown",
          warning,
        }),
      };
    }
    this.sessions.splice(idx, 1);
    this.contributions.delete(id);
    return {
      sessionId: id,
      deleted: true,
      forced: options?.force === true,
      blockers: [],
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  async appendSessionRoleSkill(
    sessionId: string,
    roleName: string,
    skillName: string,
  ): Promise<AppendSessionRoleSkillResult> {
    const idx = this.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return "session_missing";
    const existing = this.sessions[idx];
    if (!existing?.topology) return "role_missing";

    const topologyResult = appendSkillToTopology(existing.topology, roleName, skillName);
    const configResult = appendSkillToSessionConfigTopology(existing.config, roleName, skillName);

    if (!topologyResult.foundRole) return "role_missing";
    if (!topologyResult.changed && !configResult.changed) return "already_present";

    this.sessions[idx] = {
      ...existing,
      topology: topologyResult.topology,
      config: configResult.config,
    };
    return "appended";
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
