/**
 * Nexus VFS-backed HandoffStore.
 *
 * Stores all handoffs for a session in a single file:
 *   handoffs/{sessionId}.json  →  { handoffs: Handoff[] }
 *
 * This avoids many small files while keeping cross-agent visibility.
 * Concurrent updates use read-modify-write with retry. Writes are
 * unconditional (last-writer-wins) since Nexus VFS CAS is unreliable.
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
  canTransition,
} from "../core/handoff.js";
import { debugLog } from "../tui/debug-log.js";
import type { NexusClient } from "./client.js";

const MAX_RETRIES = 8;

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

/** TTL for the readAllHandoffs cache in ms. SSE invalidation resets this. */
const CACHE_TTL_MS = 5_000;

export class NexusHandoffStore implements HandoffStore {
  private readonly client: NexusClient;
  private readonly sessionId: string | undefined;
  private readonly zoneId: string;
  private dirEnsured = false;

  /** Cached result of readAllHandoffs(). Invalidated on writes and SSE events. */
  private allHandoffsCache: { data: Handoff[]; fetchedAt: number } | undefined;

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
   * Read-modify-write with retry on conflict or rate limit.
   *
   * NOT true CAS — Nexus sys_write silently drops conditional writes
   * (if_match / if_none_match return success but don't persist), so writes
   * are unconditional. Concurrent writers are last-writer-wins. The retry
   * loop handles rate limits and transient errors, not CAS conflicts.
   *
   * fn receives current handoffs, returns modified handoffs.
   * Returns the final handoff list after successful write.
   */
  private async readModifyWrite(
    path: string,
    fn: (handoffs: Handoff[]) => Handoff[],
  ): Promise<Handoff[]> {
    await this.ensureDir();
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { handoffs, etag } = await this.readFile(path);
      const updated = fn(handoffs);
      try {
        // Unconditional write — Nexus sys_write silently drops writes when
        // if_match or if_none_match are set (returns success but doesn't persist).
        // Unconditional write — concurrent writes are last-writer-wins. Handoffs are append-only
        // per session so conflicts are rare and the retry loop handles it.
        const writeResult = await this.client.write(path, encode({ handoffs: updated }));
        debugLog(
          "NexusHandoffStore.readModifyWrite",
          `WRITE OK path=${path} etag=${etag || "(empty)"} bytesWritten=${writeResult.bytesWritten} newEtag=${writeResult.etag} count=${updated.length} attempt=${attempt}`,
        );
        this.invalidateCache();
        return updated;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(
          "NexusHandoffStore.readModifyWrite",
          `WRITE FAIL path=${path} attempt=${attempt} err=${msg}`,
        );
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
    throw new Error(`Handoff read-modify-write failed after ${MAX_RETRIES} retries on ${path}`);
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
   * write (one readModifyWrite, one HTTP round-trip). Avoids the N+1 pattern
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
      // → Delivered) fails due to Nexus VFS write-visibility limitations.
      status: HandoffStatus.Delivered,
      requiresReply: input.requiresReply ?? false,
      ...(input.replyDueAt !== undefined ? { replyDueAt: input.replyDueAt } : {}),
      createdAt: new Date().toISOString(),
    }));

    const path = this.filePath();
    await this.readModifyWrite(path, (existing) => {
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
    await this.transitionHandoff(handoffId, HandoffStatus.Delivered);
  }

  async markProcessed(handoffId: string): Promise<void> {
    await this.transitionHandoff(handoffId, HandoffStatus.Processed);
  }

  async markReplied(handoffId: string, resolvedByCid: string): Promise<void> {
    await this.transitionHandoff(handoffId, HandoffStatus.Replied, { resolvedByCid });
  }

  async markDeadLettered(handoffId: string): Promise<void> {
    await this.transitionHandoff(handoffId, HandoffStatus.DeadLettered);
  }

  async setIpcMessageId(handoffId: string, ipcMessageId: string): Promise<void> {
    await this.updateHandoff(handoffId, (h) => ({ ...h, ipcMessageId }));
  }

  async expireStale(now?: string): Promise<readonly Handoff[]> {
    const cutoff = now ?? new Date().toISOString();
    const expired: Handoff[] = [];

    // Expire handoffs in any non-terminal state that have a replyDueAt past
    // the cutoff. The state machine allows pending_pickup→expired,
    // delivered→expired, and processed→expired.
    const expirableStatuses: ReadonlySet<HandoffStatus> = new Set([
      HandoffStatus.PendingPickup,
      HandoffStatus.Delivered,
      HandoffStatus.Processed,
    ]);

    // Only scan the current session file for expiry (on-demand sweep)
    await this.readModifyWrite(this.filePath(), (handoffs) =>
      handoffs.map((h) => {
        if (
          expirableStatuses.has(h.status) &&
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

  /** Invalidate the all-handoffs cache. Call on SSE events or external writes. */
  invalidateCache(): void {
    this.allHandoffsCache = undefined;
  }

  close(): void {
    this.allHandoffsCache = undefined;
    // NexusClient is shared — caller owns its lifecycle
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async updateHandoff(handoffId: string, fn: (h: Handoff) => Handoff): Promise<void> {
    await this.readModifyWrite(this.filePath(), (handoffs) =>
      handoffs.map((h) => (h.handoffId === handoffId ? fn(h) : h)),
    );
  }

  /**
   * Transition a handoff's status with state machine validation.
   * Rejects the write (no-op) if the current status doesn't allow the transition,
   * which guards against concurrent writers clobbering each other with stale state.
   */
  /**
   * Transition a handoff's status with state machine validation.
   *
   * Reads the current file, checks canTransition, and only writes back
   * if the transition is valid. Skips the write entirely on no-op to
   * avoid clobbering concurrent changes with a stale snapshot.
   */
  private async transitionHandoff(
    handoffId: string,
    targetStatus: HandoffStatus,
    extraFields?: Partial<Handoff>,
  ): Promise<void> {
    await this.ensureDir();
    const path = this.filePath();
    const { handoffs } = await this.readFile(path);

    const idx = handoffs.findIndex((h) => h.handoffId === handoffId);
    if (idx === -1) return; // handoff not in this file

    const current = handoffs[idx]!;
    if (!canTransition(current.status, targetStatus)) {
      debugLog(
        "NexusHandoffStore.transitionHandoff",
        `REJECTED ${handoffId} ${current.status}→${targetStatus} (invalid transition, skipping write)`,
      );
      return; // skip write entirely — don't clobber concurrent changes
    }

    // Valid transition — do the write
    handoffs[idx] = { ...current, ...extraFields, status: targetStatus };
    await this.client.write(path, new TextEncoder().encode(JSON.stringify({ handoffs })));
    this.invalidateCache();
    debugLog(
      "NexusHandoffStore.transitionHandoff",
      `OK ${handoffId} ${current.status}→${targetStatus}`,
    );
  }

  private async scanAll(predicate: (h: Handoff) => boolean): Promise<Handoff | undefined> {
    const all = await this.readAllHandoffs();
    return all.find(predicate);
  }

  private async readAllHandoffs(): Promise<Handoff[]> {
    // Return cached data if fresh (within TTL)
    if (
      this.allHandoffsCache !== undefined &&
      Date.now() - this.allHandoffsCache.fetchedAt < CACHE_TTL_MS
    ) {
      return this.allHandoffsCache.data;
    }

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
      const allHandoffs = results.flat();
      this.allHandoffsCache = { data: allHandoffs, fetchedAt: Date.now() };
      return allHandoffs;
    } catch (listErr) {
      debugLog(
        "NexusHandoffStore.readAllHandoffs",
        `LIST FAIL dir=${handoffsDir(this.zoneId)} err=${listErr instanceof Error ? listErr.message : String(listErr)}`,
      );
      return [];
    }
  }
}
