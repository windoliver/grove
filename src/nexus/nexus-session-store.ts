/**
 * Nexus VFS-backed session store.
 *
 * Stores sessions as JSON files at /zones/{zoneId}/sessions/{id}.json.
 * Contributions are stored at /zones/{zoneId}/sessions/{id}.contributions.json.
 */

import { randomUUID } from "node:crypto";
import type { CreateSessionInput, Session, SessionQuery, SessionStore } from "../core/session.js";
import type { NexusClient } from "./client.js";
import { NexusConflictError } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_SESSION_LINK_UPDATE_ATTEMPTS = 10;

export class NexusSessionStore implements SessionStore {
  private readonly client: NexusClient;
  private readonly zoneId: string;

  constructor(client: NexusClient, zoneId: string) {
    this.client = client;
    this.zoneId = zoneId;
  }

  private sessionPath(id: string): string {
    return `/zones/${this.zoneId}/sessions/${id}.json`;
  }

  private contributionsPath(id: string): string {
    return `/zones/${this.zoneId}/sessions/${id}.contributions.json`;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const session: Session = {
      id: randomUUID().slice(0, 8),
      goal: input.goal,
      presetName: input.presetName,
      topology: input.topology,
      status: "active",
      createdAt: new Date().toISOString(),
      contributionCount: 0,
      config: input.config,
    };
    await this.client.write(this.sessionPath(session.id), encoder.encode(JSON.stringify(session)));
    return session;
  }

  /** Write an existing session record (preserving its ID) — used for mirroring. */
  async putSession(session: Session): Promise<void> {
    await this.client.write(this.sessionPath(session.id), encoder.encode(JSON.stringify(session)));
  }

  /**
   * Read only the session metadata record, without loading contribution counts.
   *
   * MCP startup only needs config/topology/preset fields; avoiding the
   * contribution sidecar read keeps that hot path O(1) in session size.
   */
  async getSessionRecord(id: string): Promise<Session | undefined> {
    try {
      const data = await this.client.read(this.sessionPath(id));
      if (!data) return undefined;
      return JSON.parse(decoder.decode(data)) as Session;
    } catch {
      return undefined;
    }
  }

  async getSession(id: string): Promise<Session | undefined> {
    const session = await this.getSessionRecord(id);
    if (!session) return undefined;
    const cids = await this.getContributions(id);
    return { ...session, contributionCount: cids.length };
  }

  async updateSession(
    id: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason" | "stopStatus">>,
  ): Promise<void> {
    const existing = await this.getSession(id);
    if (!existing) return;
    const updated = { ...existing, ...updates };
    await this.client.write(this.sessionPath(id), encoder.encode(JSON.stringify(updated)));
  }

  async listSessions(query?: SessionQuery): Promise<readonly Session[]> {
    try {
      const result = await this.client.list(`/zones/${this.zoneId}/sessions`);
      const sessions: Session[] = [];
      for (const f of result.files) {
        // Skip contributions files
        if (f.name.endsWith(".contributions.json")) continue;
        try {
          const data = await this.client.read(`/zones/${this.zoneId}/sessions/${f.name}`);
          if (data) {
            const s = JSON.parse(decoder.decode(data)) as Session;
            if (query?.status) {
              if (s.status !== query.status) continue;
            } else if (!query?.includeArchived) {
              if (s.status === "archived") continue;
            }
            if (query?.presetName && s.presetName !== query.presetName) continue;
            const cids = await this.getContributions(s.id);
            sessions.push({ ...s, contributionCount: cids.length });
          }
        } catch {
          // Skip malformed
        }
      }
      return sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    } catch {
      return [];
    }
  }

  async archiveSession(id: string): Promise<void> {
    await this.updateSession(id, {
      status: "archived",
      completedAt: new Date().toISOString(),
    });
  }

  async addContribution(sessionId: string, cid: string): Promise<void> {
    const path = this.contributionsPath(sessionId);
    for (let attempt = 0; attempt < MAX_SESSION_LINK_UPDATE_ATTEMPTS; attempt++) {
      const current = await this.client.readWithMeta(path);
      const cids =
        current === undefined ? [] : (JSON.parse(decoder.decode(current.content)) as string[]);
      if (cids.includes(cid)) return;

      try {
        await this.client.write(path, encoder.encode(JSON.stringify([...cids, cid])), {
          ...(current === undefined ? { ifNoneMatch: "*" } : { ifMatch: current.etag }),
        });
        return;
      } catch (err) {
        if (err instanceof NexusConflictError) continue;
        throw err;
      }
    }
    throw new NexusConflictError({
      message: `Could not attach contribution '${cid}' to session '${sessionId}' after ${MAX_SESSION_LINK_UPDATE_ATTEMPTS} attempts`,
    });
  }

  async getContributions(sessionId: string): Promise<readonly string[]> {
    try {
      const data = await this.client.read(this.contributionsPath(sessionId));
      if (!data) return [];
      return JSON.parse(decoder.decode(data)) as string[];
    } catch {
      return [];
    }
  }
}
