/**
 * Nexus VFS-backed HandoffStore.
 *
 * Stores all handoffs for a session in a single file:
 *   handoffs/{sessionId}.json  →  { handoffs: Handoff[] }
 *
 * This avoids many small files while keeping cross-agent visibility.
 * Concurrent updates use etag-based CAS with retry — conflicts are rare
 * since handoffs within a session are mostly sequential.
 *
 * When no sessionId is available (e.g. handoff created outside a session),
 * falls back to a shared "handoffs/_global.json" file.
 */

import {
  type Handoff,
  type HandoffInput,
  type HandoffQuery,
  HandoffStatus,
  type HandoffStore,
} from "../core/handoff.js";
import type { NexusClient } from "./client.js";

const HANDOFFS_DIR = "handoffs";
const GLOBAL_FILE = `${HANDOFFS_DIR}/_global.json`;
const MAX_CAS_RETRIES = 5;

interface HandoffFile {
  handoffs: Handoff[];
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function sessionFile(sessionId: string): string {
  return `${HANDOFFS_DIR}/${sessionId}.json`;
}

export class NexusHandoffStore implements HandoffStore {
  private readonly client: NexusClient;
  private readonly sessionId: string | undefined;

  constructor(
    client: NexusClient,
    /** Active session ID — determines which file handoffs are written to. */
    sessionId?: string | undefined,
  ) {
    this.client = client;
    this.sessionId = sessionId;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private filePath(): string {
    return this.sessionId ? sessionFile(this.sessionId) : GLOBAL_FILE;
  }

  private async readFile(path: string): Promise<{ handoffs: Handoff[]; etag: string }> {
    const result = await this.client.readWithMeta(path);
    if (!result) return { handoffs: [], etag: "" };
    const text = new TextDecoder().decode(result.content);
    const parsed = JSON.parse(text) as HandoffFile;
    return { handoffs: parsed.handoffs ?? [], etag: result.etag ?? "" };
  }

  /**
   * Read-modify-write with CAS retry.
   * fn receives current handoffs, returns modified handoffs.
   * Returns the final handoff list after successful write.
   */
  private async casUpdate(
    path: string,
    fn: (handoffs: Handoff[]) => Handoff[],
  ): Promise<Handoff[]> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const { handoffs, etag } = await this.readFile(path);
      const updated = fn(handoffs);
      try {
        await this.client.write(path, encode({ handoffs: updated }), {
          // First write: if_none_match prevents overwrite race on creation
          // Subsequent: if_match ensures we're updating what we read
          ...(etag ? { ifMatch: etag } : { ifNoneMatch: "*", force: false }),
        });
        return updated;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Conflict = another writer updated between our read and write — retry
        if (msg.includes("412") || msg.includes("conflict") || msg.includes("mismatch")) {
          // Brief backoff before retry
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        // First write hit a conflict because file was just created — retry as update
        if (msg.includes("412") || msg.includes("none_match")) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Handoff CAS update failed after ${MAX_CAS_RETRIES} retries on ${path}`);
  }

  // ---------------------------------------------------------------------------
  // HandoffStore implementation
  // ---------------------------------------------------------------------------

  async create(input: HandoffInput): Promise<Handoff> {
    const handoff: Handoff = {
      handoffId: input.handoffId ?? crypto.randomUUID(),
      sourceCid: input.sourceCid,
      fromRole: input.fromRole,
      toRole: input.toRole,
      status: HandoffStatus.PendingPickup,
      requiresReply: input.requiresReply ?? false,
      ...(input.replyDueAt !== undefined ? { replyDueAt: input.replyDueAt } : {}),
      createdAt: new Date().toISOString(),
    };

    await this.casUpdate(this.filePath(), (existing) => {
      // Idempotent: skip if already present
      if (existing.some((h) => h.handoffId === handoff.handoffId)) return existing;
      return [...existing, handoff];
    });

    return handoff;
  }

  async get(handoffId: string): Promise<Handoff | undefined> {
    // Check session file first, then scan all files
    const { handoffs } = await this.readFile(this.filePath());
    const found = handoffs.find((h) => h.handoffId === handoffId);
    if (found) return found;

    // Fall back: scan all session files (for cross-session lookups)
    return this.scanAll((h) => h.handoffId === handoffId);
  }

  async list(query?: HandoffQuery): Promise<readonly Handoff[]> {
    // When sessionId is set, only read the session file (fast path)
    const allHandoffs = this.sessionId
      ? (await this.readFile(this.filePath())).handoffs
      : await this.readAllHandoffs();

    let results = allHandoffs;
    if (query?.toRole !== undefined) results = results.filter((h) => h.toRole === query.toRole);
    if (query?.fromRole !== undefined)
      results = results.filter((h) => h.fromRole === query.fromRole);
    if (query?.sourceCid !== undefined)
      results = results.filter((h) => h.sourceCid === query.sourceCid);
    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      results = results.filter((h) => (statuses as string[]).includes(h.status));
    }
    results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (query?.limit !== undefined) results = results.slice(0, query.limit);
    return results;
  }

  async markDelivered(handoffId: string): Promise<void> {
    await this.updateHandoff(handoffId, (h) => ({ ...h, status: HandoffStatus.Delivered }));
  }

  async markReplied(handoffId: string, resolvedByCid: string): Promise<void> {
    await this.updateHandoff(handoffId, (h) => ({
      ...h,
      status: HandoffStatus.Replied,
      resolvedByCid,
    }));
  }

  async expireStale(now?: string): Promise<readonly Handoff[]> {
    const cutoff = now ?? new Date().toISOString();
    const expired: Handoff[] = [];

    // Only scan the current session file for expiry (on-demand sweep)
    await this.casUpdate(this.filePath(), (handoffs) =>
      handoffs.map((h) => {
        if (
          h.status === HandoffStatus.PendingPickup &&
          h.replyDueAt !== undefined &&
          h.replyDueAt < cutoff
        ) {
          const updated = { ...h, status: HandoffStatus.Expired };
          expired.push(updated);
          return updated;
        }
        return h;
      }),
    );

    return expired;
  }

  async countPending(toRole: string): Promise<number> {
    const pending = await this.list({ toRole, status: HandoffStatus.PendingPickup });
    return pending.length;
  }

  close(): void {
    // NexusClient is shared — caller owns its lifecycle
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async updateHandoff(handoffId: string, fn: (h: Handoff) => Handoff): Promise<void> {
    await this.casUpdate(this.filePath(), (handoffs) =>
      handoffs.map((h) => (h.handoffId === handoffId ? fn(h) : h)),
    );
  }

  private async scanAll(predicate: (h: Handoff) => boolean): Promise<Handoff | undefined> {
    const all = await this.readAllHandoffs();
    return all.find(predicate);
  }

  private async readAllHandoffs(): Promise<Handoff[]> {
    try {
      const listing = await this.client.list(HANDOFFS_DIR);
      const files = listing.files.filter((e) => !e.isDirectory && e.name.endsWith(".json"));
      const results = await Promise.all(
        files.map(async (f: import("./client.js").ListEntry) => {
          try {
            return (await this.readFile(f.path)).handoffs;
          } catch {
            return [];
          }
        }),
      );
      return results.flat();
    } catch {
      return [];
    }
  }
}
