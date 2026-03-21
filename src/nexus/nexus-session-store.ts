/**
 * Nexus VFS-backed session store.
 *
 * Stores sessions as JSON files at /zones/{zoneId}/sessions/{id}.json.
 */

import type { Session, SessionStore } from "../core/session-manager.js";
import type { NexusClient } from "./client.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class NexusSessionStore implements SessionStore {
  private readonly client: NexusClient;
  private readonly zoneId: string;

  constructor(client: NexusClient, zoneId: string) {
    this.client = client;
    this.zoneId = zoneId;
  }

  async create(session: Session): Promise<void> {
    const path = `/zones/${this.zoneId}/sessions/${session.id}.json`;
    await this.client.write(path, encoder.encode(JSON.stringify(session)));
  }

  async get(id: string): Promise<Session | undefined> {
    const path = `/zones/${this.zoneId}/sessions/${id}.json`;
    try {
      const data = await this.client.read(path);
      if (!data) return undefined;
      return JSON.parse(decoder.decode(data)) as Session;
    } catch {
      return undefined;
    }
  }

  async update(
    id: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason">>,
  ): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    const updated = { ...existing, ...updates };
    const path = `/zones/${this.zoneId}/sessions/${id}.json`;
    await this.client.write(path, encoder.encode(JSON.stringify(updated)));
  }

  async list(presetName?: string): Promise<readonly Session[]> {
    try {
      const result = await this.client.list(`/zones/${this.zoneId}/sessions`);
      const sessions: Session[] = [];
      for (const f of result.files) {
        try {
          const data = await this.client.read(`/zones/${this.zoneId}/sessions/${f.name}`);
          if (data) {
            const s = JSON.parse(decoder.decode(data)) as Session;
            if (!presetName || s.presetName === presetName) sessions.push(s);
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

  async latest(presetName?: string): Promise<Session | undefined> {
    const all = await this.list(presetName);
    return all[0];
  }
}
