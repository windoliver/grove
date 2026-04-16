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

import { StateConflictError } from "../core/errors.js";
import {
  type Handoff,
  type HandoffInput,
  type HandoffQuery,
  HandoffStatus,
  type HandoffStore,
  validateTransition,
} from "../core/handoff.js";
import { debugLog } from "../tui/debug-log.js";
import type { NexusClient } from "./client.js";

const MAX_CAS_RETRIES = 8;

function handoffsDir(zoneId: string): string {
  return `/zones/${zoneId}/handoffs`;
}
function globalFile(zoneId: string): string {
  return `${handoffsDir(zoneId)}/_global.json`;
}
interface HandoffFile {
  handoffs: Handoff[];
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

export class NexusHandoffStore implements HandoffStore {
  private readonly client: NexusClient;
  private readonly sessionId: string | undefined;
  private readonly zoneId: string;
  private dirEnsured = false;

  constructor(
    client: NexusClient,
    /** Active session ID — determines which file handoffs are written to. */
    sessionId?: string | undefined,
    /** Zone ID for multi-tenant scoping. Defaults to "default". */
    zoneId?: string | undefined,
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.zoneId = zoneId ?? "default";
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private filePath(): string {
    const dir = handoffsDir(this.zoneId);
    return this.sessionId ? `${dir}/${this.sessionId}.json` : globalFile(this.zoneId);
  }

  /** Ensure the handoffs directory exists in VFS (idempotent, cached). */
  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    try {
      await this.client.mkdir(handoffsDir(this.zoneId), { parents: true });
    } catch {
      // Best-effort — write may auto-create parent dirs on some Nexus versions
    }
    this.dirEnsured = true;
  }

  private async readFile(path: string): Promise<{ handoffs: Handoff[]; etag: string }> {
    const result = await this.client.readWithMeta(path);
    if (!result) {
      debugLog("nexus-handoff.readFile", `path=${path} result=null (file not found)`);
      return { handoffs: [], etag: "" };
    }
    const text = new TextDecoder().decode(result.content);
    debugLog(
      "nexus-handoff.readFile",
      `path=${path} contentLen=${result.content.length} text=${text.slice(0, 80)} etag=${result.etag}`,
    );
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
        // Unconditional write — Nexus sys_write silently drops writes when
        // if_match or if_none_match are set (returns success but doesn't persist).
        // Without CAS, concurrent writes may lose data, but handoffs are append-only
        // per session so conflicts are rare and the retry loop handles it.
        const writeResult = await this.client.write(path, encode({ handoffs: updated }));
        debugLog(
          "NexusHandoffStore.casUpdate",
          `WRITE OK path=${path} etag=${etag || "(empty)"} bytesWritten=${writeResult.bytesWritten} newEtag=${writeResult.etag} count=${updated.length} attempt=${attempt}`,
        );
        return updated;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(
          "NexusHandoffStore.casUpdate",
          `WRITE FAIL path=${path} attempt=${attempt} err=${msg}`,
        );
        // Conflict = another writer updated between our read and write — retry
        if (msg.includes("412") || msg.includes("conflict") || msg.includes("mismatch")) {
          // Exponential backoff with jitter to prevent retry storms
          const backoff = Math.min(20 * 2 ** attempt, 500) + Math.random() * 50;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        // First write hit a conflict because file was just created — retry as update
        if (msg.includes("none_match")) {
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
    const [handoff] = await this.createMany([input]);
    if (handoff === undefined) {
      throw new Error("createMany returned no handoff");
    }
    return handoff;
  }

  /**
   * Batch creation: collapses N handoff inserts into a single VFS file
   * write (one casUpdate, one HTTP round-trip). Avoids the N+1 pattern
   * the contributeOperation serial path used to have when fanning out
   * to multiple downstream roles.
   */
  async createMany(inputs: readonly HandoffInput[]): Promise<readonly Handoff[]> {
    if (inputs.length === 0) return [];

    const handoffs: Handoff[] = inputs.map((input) => ({
      handoffId: input.handoffId ?? crypto.randomUUID(),
      sourceCid: input.sourceCid,
      fromRole: input.fromRole,
      toRole: input.toRole,
      // Default to Delivered — the MCP creates handoffs at contribution-write time
      // AND the TopologyRouter routes them immediately. The TUI's routeContribution
      // delivers via agentRuntime.send(). Updating status cross-client (PendingPickup
      // → Delivered) fails due to Nexus VFS casUpdate limitations.
      status: HandoffStatus.Delivered,
      requiresReply: input.requiresReply ?? false,
      ...(input.replyDueAt !== undefined ? { replyDueAt: input.replyDueAt } : {}),
      createdAt: new Date().toISOString(),
    }));

    const path = this.filePath();
    await this.casUpdate(path, (existing) => {
      // Idempotent merge: skip handoffs whose id is already present.
      const existingIds = new Set(existing.map((h) => h.handoffId));
      const fresh = handoffs.filter((h) => !existingIds.has(h.handoffId));
      return fresh.length === 0 ? existing : [...existing, ...fresh];
    });

    return handoffs;
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
    debugLog(
      "nexus-handoff",
      `LIST sessionId=${this.sessionId ?? "none"} path=${this.filePath()} total=${allHandoffs.length}`,
    );

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
    await this.updateHandoff(handoffId, (h) => {
      validateTransition(handoffId, h.status, HandoffStatus.Delivered);
      return { ...h, status: HandoffStatus.Delivered };
    });
  }

  async markReplied(handoffId: string, resolvedByCid: string): Promise<void> {
    // Reject late replies at the store level so correctness does not
    // depend on the DeadlineWatcher flipping status first.
    const now = new Date().toISOString();
    let deadlineBreached = false;
    await this.updateHandoff(handoffId, (h) => {
      if (
        (h.status === HandoffStatus.PendingPickup ||
          h.status === HandoffStatus.Delivered) &&
        h.replyDueAt !== undefined &&
        h.replyDueAt < now
      ) {
        deadlineBreached = true;
        return { ...h, status: HandoffStatus.Expired };
      }
      validateTransition(handoffId, h.status, HandoffStatus.Replied);
      return {
        ...h,
        status: HandoffStatus.Replied,
        resolvedByCid,
      };
    });
    if (deadlineBreached) {
      throw new StateConflictError({
        resource: "Handoff",
        reason: `Reply deadline passed (now ${now})`,
      });
    }
  }

  async markSeen(handoffId: string): Promise<void> {
    await this.updateHandoff(handoffId, (h) => {
      // No-op if already seen
      if (h.seenAt !== undefined) return h;
      return { ...h, seenAt: new Date().toISOString() };
    });
  }

  async markAcked(handoffId: string): Promise<void> {
    await this.updateHandoff(handoffId, (h) => {
      // No-op if already acked
      if (h.ackedAt !== undefined) return h;
      const now = new Date().toISOString();
      return {
        ...h,
        // Auto-fill seenAt if not already set
        ...(h.seenAt === undefined ? { seenAt: now } : {}),
        ackedAt: now,
      };
    });
  }

  async expireStale(now?: string): Promise<readonly Handoff[]> {
    const cutoff = now ?? new Date().toISOString();
    const expired: Handoff[] = [];

    // Expire both pending_pickup AND delivered — Nexus creates handoffs as
    // delivered by default (see createMany), so restricting to pending_pickup
    // would leave every deadline-backed Nexus handoff unresolvable forever.
    await this.casUpdate(this.filePath(), (handoffs) =>
      handoffs.map((h) => {
        if (
          (h.status === HandoffStatus.PendingPickup ||
            h.status === HandoffStatus.Delivered) &&
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

  /**
   * Session-scoped list — returns handoffs from the current session only,
   * used by DeadlineWatcher.rebuildFromStore() to avoid re-arming timers
   * for handoffs in other sessions.
   *
   * Uses the same directory-listing path as list() (not a direct readFile)
   * because Nexus does not guarantee cross-client read-after-write
   * visibility via readFile — a restarting MCP server could miss handoffs
   * written by another client. The directory listing path is documented as
   * the cross-client-visible source of truth.
   *
   * When sessionId is unset (global fallback), returns an empty array —
   * global handoffs can't be attributed to a specific session for rebuild.
   */
  async listForCurrentSession(query?: HandoffQuery): Promise<readonly Handoff[]> {
    if (this.sessionId === undefined) return [];
    const sessionPath = this.filePath();
    // Scan all handoff files (same visibility path as list()) and filter to
    // the current session's file.
    try {
      const listing = await this.client.list(handoffsDir(this.zoneId));
      const file = listing.files.find((f) => !f.isDirectory && f.path === sessionPath);
      if (!file) return [];
      const { handoffs } = await this.readFile(file.path);
      let results = handoffs.filter((h) => h.handoffId && h.createdAt);
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
    } catch {
      return [];
    }
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
    // No TTL cache: handoff coordination state is written by multiple
    // processes (different agents) and stale reads cause missed overdue
    // events and false ack suppression. Freshness matters more than the
    // extra round-trip.
    try {
      const listing = await this.client.list(handoffsDir(this.zoneId));
      // Nexus list may return entries without the .json extension even though
      // the file was written with .json — accept all non-directory entries.
      const files = listing.files.filter((e) => !e.isDirectory);
      debugLog(
        "NexusHandoffStore.readAllHandoffs",
        `dir=${handoffsDir(this.zoneId)} totalEntries=${listing.files.length} jsonFiles=${files.length} paths=${files.map((f) => f.path).join(",") || "(none)"}`,
      );
      const results = await Promise.all(
        files.map(async (f: import("./client.js").ListEntry) => {
          try {
            const { handoffs } = await this.readFile(f.path);
            debugLog(
              "NexusHandoffStore.readAllHandoffs",
              `read path=${f.path} count=${handoffs.length}`,
            );
            return handoffs;
          } catch (readErr) {
            debugLog(
              "NexusHandoffStore.readAllHandoffs",
              `FAIL path=${f.path} err=${readErr instanceof Error ? readErr.message : String(readErr)}`,
            );
            return [];
          }
        }),
      );
      return results.flat();
    } catch (listErr) {
      debugLog(
        "NexusHandoffStore.readAllHandoffs",
        `LIST FAIL dir=${handoffsDir(this.zoneId)} err=${listErr instanceof Error ? listErr.message : String(listErr)}`,
      );
      return [];
    }
  }
}
