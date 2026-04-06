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

// Use absolute zone-prefixed path so MCP and TUI resolve to the same VFS location.
// Relative paths may resolve differently per Nexus zone context.
const HANDOFFS_DIR = "/zones/default/handoffs";
const GLOBAL_FILE = `${HANDOFFS_DIR}/_global.json`;
const MAX_CAS_RETRIES = 8;

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
  private dirEnsured = false;

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

  /** Ensure the handoffs directory exists in VFS (idempotent, cached). */
  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    try {
      await this.client.mkdir(HANDOFFS_DIR, { parents: true });
    } catch {
      // Best-effort — write may auto-create parent dirs on some Nexus versions
    }
    this.dirEnsured = true;
  }

  private async readFile(path: string): Promise<{ handoffs: Handoff[]; etag: string }> {
    const result = await this.client.readWithMeta(path);
    if (!result) {
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs");
        appendFileSync(
          "/tmp/grove-debug.log",
          `[${new Date().toISOString()}] [nexus-handoff.readFile] path=${path} result=null (file not found)\n`,
        );
      } catch {
        /* */
      }
      return { handoffs: [], etag: "" };
    }
    const text = new TextDecoder().decode(result.content);
    try {
      const { appendFileSync } = require("node:fs") as typeof import("node:fs");
      appendFileSync(
        "/tmp/grove-debug.log",
        `[${new Date().toISOString()}] [nexus-handoff.readFile] path=${path} contentLen=${result.content.length} text=${text.slice(0, 80)} etag=${result.etag}\n`,
      );
    } catch {
      /* */
    }
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
    await this.ensureDir();
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const { handoffs, etag } = await this.readFile(path);
      const updated = fn(handoffs);
      try {
        const writeResult = await this.client.write(path, encode({ handoffs: updated }), {
          // Use ifMatch for CAS when we have an etag from a prior read.
          // Do NOT use ifNoneMatch: "*" — Nexus sys_write silently drops writes
          // when if_none_match is set (returns success but doesn't persist).
          ...(etag ? { ifMatch: etag } : {}),
        });
        try {
          const { appendFileSync } = require("node:fs") as typeof import("node:fs");
          appendFileSync(
            "/tmp/grove-debug.log",
            `[${new Date().toISOString()}] [NexusHandoffStore.casUpdate] WRITE OK path=${path} etag=${etag || "(empty)"} bytesWritten=${writeResult.bytesWritten} newEtag=${writeResult.etag} count=${updated.length} attempt=${attempt}\n`,
          );
        } catch {
          /* non-fatal */
        }
        return updated;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          const { appendFileSync } = require("node:fs") as typeof import("node:fs");
          appendFileSync(
            "/tmp/grove-debug.log",
            `[${new Date().toISOString()}] [NexusHandoffStore.casUpdate] WRITE FAIL path=${path} attempt=${attempt} err=${msg}\n`,
          );
        } catch {
          /* non-fatal */
        }
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
        // Rate limit — backoff and retry (handoff writes are critical for IPC tracking)
        if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
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

    const path = this.filePath();
    try {
      await this.casUpdate(path, (existing) => {
        // Idempotent: skip if already present
        if (existing.some((h) => h.handoffId === handoff.handoffId)) return existing;
        return [...existing, handoff];
      });
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs");
        appendFileSync(
          "/tmp/grove-debug.log",
          `[${new Date().toISOString()}] [nexus-handoff] WRITE OK path=${path} id=${handoff.handoffId} ${handoff.fromRole}→${handoff.toRole}\n`,
        );
      } catch {
        /* */
      }
    } catch (err) {
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs");
        appendFileSync(
          "/tmp/grove-debug.log",
          `[${new Date().toISOString()}] [nexus-handoff] WRITE FAIL path=${path} err=${err instanceof Error ? err.message : String(err)}\n`,
        );
      } catch {
        /* */
      }
      throw err;
    }

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
    // Always scan all handoff files — readFile fails cross-client (Nexus VFS
    // doesn't guarantee read-after-write visibility across NexusHttpClient instances).
    // readAllHandoffs uses directory listing which has broader visibility.
    const allHandoffs = await this.readAllHandoffs();
    try {
      const { appendFileSync } = require("node:fs") as typeof import("node:fs");
      appendFileSync(
        "/tmp/grove-debug.log",
        `[${new Date().toISOString()}] [nexus-handoff] LIST sessionId=${this.sessionId ?? "none"} path=${this.filePath()} total=${allHandoffs.length}\n`,
      );
    } catch {
      /* */
    }

    // Filter out malformed entries (test files without required fields)
    let results = allHandoffs.filter((h) => h.handoffId && h.createdAt);
    if (query?.toRole !== undefined) results = results.filter((h) => h.toRole === query.toRole);
    if (query?.fromRole !== undefined)
      results = results.filter((h) => h.fromRole === query.fromRole);
    if (query?.sourceCid !== undefined)
      results = results.filter((h) => h.sourceCid === query.sourceCid);
    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      results = results.filter((h) => (statuses as string[]).includes(h.status));
    }
    results.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
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
      // Nexus list may return entries without the .json extension even though
      // the file was written with .json — accept all non-directory entries.
      const files = listing.files.filter((e) => !e.isDirectory);
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs");
        appendFileSync(
          "/tmp/grove-debug.log",
          `[${new Date().toISOString()}] [NexusHandoffStore.readAllHandoffs] dir=${HANDOFFS_DIR} totalEntries=${listing.files.length} jsonFiles=${files.length} paths=${files.map((f) => f.path).join(",") || "(none)"}\n`,
        );
      } catch {
        /* non-fatal */
      }
      const results = await Promise.all(
        files.map(async (f: import("./client.js").ListEntry) => {
          try {
            const { handoffs } = await this.readFile(f.path);
            try {
              const { appendFileSync } = require("node:fs") as typeof import("node:fs");
              appendFileSync(
                "/tmp/grove-debug.log",
                `[${new Date().toISOString()}] [NexusHandoffStore.readAllHandoffs] read path=${f.path} count=${handoffs.length}\n`,
              );
            } catch {
              /* non-fatal */
            }
            return handoffs;
          } catch (readErr) {
            try {
              const { appendFileSync } = require("node:fs") as typeof import("node:fs");
              appendFileSync(
                "/tmp/grove-debug.log",
                `[${new Date().toISOString()}] [NexusHandoffStore.readAllHandoffs] FAIL path=${f.path} err=${readErr instanceof Error ? readErr.message : String(readErr)}\n`,
              );
            } catch {
              /* non-fatal */
            }
            return [];
          }
        }),
      );
      return results.flat();
    } catch (listErr) {
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs");
        appendFileSync(
          "/tmp/grove-debug.log",
          `[${new Date().toISOString()}] [NexusHandoffStore.readAllHandoffs] LIST FAIL dir=${HANDOFFS_DIR} err=${listErr instanceof Error ? listErr.message : String(listErr)}\n`,
        );
      } catch {
        /* non-fatal */
      }
      return [];
    }
  }
}
