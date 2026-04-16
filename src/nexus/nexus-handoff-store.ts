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
        // CAS via Nexus conditional write:
        //   - Non-empty etag → ifMatch (detect overwrites-between-read-and-write)
        //   - Empty etag (file not yet created) → ifNoneMatch: "*" so only the
        //     FIRST writer succeeds; peers racing initial creation get a 412
        //     and retry, re-reading the now-populated file and merging.
        //     Without ifNoneMatch, both concurrent creators would take the
        //     unconditional-write branch and the later write would overwrite
        //     the earlier one, silently dropping a peer's handoffs.
        const writeOpts = etag ? { ifMatch: etag } : { ifNoneMatch: "*" };
        const writeResult = await this.client.write(path, encode({ handoffs: updated }), writeOpts);
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
    // When scoped to a session, only look in this session's file plus the
    // _global file (pre-#164 migration shim). An unscoped store walks the
    // full directory. Use the directory-listing path even in the scoped
    // branch — plain readFile() is documented as not cross-client-visible
    // (see readAllHandoffs), so a handoff written by another client into
    // the same session file could otherwise vanish from get().
    const scopedHandoffs =
      this.sessionId !== undefined ? await this.readScopedHandoffs() : await this.readAllHandoffs();
    const found = scopedHandoffs.find((h) => h.handoffId === handoffId);
    if (found) return found;
    if (this.sessionId !== undefined) return undefined;
    // Unscoped store (CLI/admin) — already searched all files above.
    return undefined;
  }

  async list(query?: HandoffQuery): Promise<readonly Handoff[]> {
    // Use the directory-listing path for both scoped and unscoped reads —
    // see get() for why plain readFile() isn't cross-client-visible.
    const allHandoffs =
      this.sessionId !== undefined ? await this.readScopedHandoffs() : await this.readAllHandoffs();
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
      // Idempotent: Nexus creates handoffs as Delivered by default, so
      // re-marking is a common no-op.
      if (h.status === HandoffStatus.Delivered) return h;
      validateTransition(handoffId, h.status, HandoffStatus.Delivered);
      return { ...h, status: HandoffStatus.Delivered };
    });
  }

  async markProcessed(handoffId: string): Promise<void> {
    await this.updateHandoff(handoffId, (h) => {
      if (h.status === HandoffStatus.Processed) return h;
      validateTransition(handoffId, h.status, HandoffStatus.Processed);
      return { ...h, status: HandoffStatus.Processed };
    });
  }

  async markReplied(handoffId: string, resolvedByCid: string): Promise<void> {
    // Reject late replies at the store level so correctness does not
    // depend on the DeadlineWatcher flipping status first. Only
    // delivered/processed can transition to replied per the state machine.
    const now = new Date().toISOString();
    let deadlineBreached = false;
    await this.updateHandoff(handoffId, (h) => {
      if (
        (h.status === HandoffStatus.Delivered || h.status === HandoffStatus.Processed) &&
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

  async markDeadLettered(handoffId: string): Promise<void> {
    await this.updateHandoff(handoffId, (h) => {
      validateTransition(handoffId, h.status, HandoffStatus.DeadLettered);
      return { ...h, status: HandoffStatus.DeadLettered };
    });
  }

  async setIpcMessageId(handoffId: string, ipcMessageId: string): Promise<void> {
    await this.updateHandoff(handoffId, (h) => ({ ...h, ipcMessageId }));
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

    // Expire all non-terminal states: pending_pickup, delivered, processed.
    // Nexus creates handoffs as delivered by default, so restricting to
    // pending_pickup would leave every deadline-backed Nexus handoff
    // unresolvable forever. The state machine allows
    // pending_pickup/delivered/processed → expired.
    const expirableStatuses: ReadonlySet<HandoffStatus> = new Set([
      HandoffStatus.PendingPickup,
      HandoffStatus.Delivered,
      HandoffStatus.Processed,
    ]);

    const expireIn = (handoffs: Handoff[]): Handoff[] =>
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
      });

    // Sweep the session's own file first — any rows expired here MUST be
    // reported even if the follow-up _global sweep fails, otherwise the
    // DeadlineWatcher would swallow the error and drop overdue events for
    // rows that have already been flipped.
    await this.readModifyWrite(this.filePath(), expireIn);

    // Migration shim: also sweep _global for pre-#164 legacy rows when
    // scoped. Errors here are recoverable (next tick retries) and must
    // not mask the session-file sweep's already-expired rows.
    if (this.sessionId !== undefined) {
      try {
        await this.readModifyWrite(globalFile(this.zoneId), expireIn);
      } catch (err) {
        debugLog(
          "NexusHandoffStore.expireStale",
          `_global sweep failed (session sweep already committed) err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return expired;
  }

  async countPending(toRole: string): Promise<number> {
    const pending = await this.list({ toRole, status: HandoffStatus.PendingPickup });
    return pending.length;
  }

  /**
   * Direct session-scoped ownership check. O(1) per-session cost (single
   * read of the session file) vs. listForCurrentSession's bounded-scan
   * pattern. Returns false when there is no active sessionId (global
   * fallback) since global handoffs can't be attributed to a session.
   *
   * Also accepts pre-#164 legacy rows stored in _global.json so the
   * receipt tools (grove_ack_handoff, grove_process_handoff) can resolve
   * in-flight handoffs after upgrade — list()/get() already honor the
   * same migration shim.
   */
  async isInCurrentSession(handoffId: string): Promise<boolean> {
    if (this.sessionId === undefined) return false;
    try {
      const handoffs = await this.readScopedHandoffs();
      return handoffs.some((h) => h.handoffId === handoffId);
    } catch {
      return false;
    }
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
    try {
      let results = (await this.readScopedHandoffs()).filter((h) => h.handoffId && h.createdAt);
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

  /**
   * Read handoffs from the current session's file plus the _global
   * migration file, but via the directory-listing path so cross-client
   * writes are visible. This mirrors readAllHandoffs's pattern (which
   * the original comment documents as the cross-client-visible source
   * of truth) but restricts the file set to the scoped caller.
   *
   * Requires sessionId to be set — unscoped callers should use
   * readAllHandoffs directly.
   */
  private async readScopedHandoffs(): Promise<Handoff[]> {
    const sessionId = this.sessionId;
    if (sessionId === undefined) return [];
    // Some Nexus versions return listing entries without the .json suffix
    // even though files are written with it; readAllHandoffs accounts for
    // this by accepting every non-directory entry. Here we match by
    // basename with the extension stripped so the session file and
    // _global file are picked up in both listing styles.
    const basenameNoExt = (path: string): string => {
      const name = path.split("/").pop() ?? "";
      return name.replace(/\.json$/, "");
    };
    try {
      const listing = await this.client.list(handoffsDir(this.zoneId));
      // Split pickable files into session-owned vs _global so a
      // half-completed claim-move (session file has the mutated row,
      // _global still has a stale copy) doesn't surface both. The
      // session file wins.
      const sessionFiles = listing.files.filter(
        (f) => !f.isDirectory && basenameNoExt(f.path) === sessionId,
      );
      const globalFiles = listing.files.filter(
        (f) => !f.isDirectory && basenameNoExt(f.path) === "_global",
      );
      const readHandoffs = async (
        f: import("./client.js").ListEntry,
      ): Promise<readonly Handoff[]> => {
        try {
          const { handoffs } = await this.readFile(f.path);
          return handoffs;
        } catch {
          return [];
        }
      };
      const [sessionPerFile, globalPerFile] = await Promise.all([
        Promise.all(sessionFiles.map(readHandoffs)),
        Promise.all(globalFiles.map(readHandoffs)),
      ]);
      const sessionHandoffs = sessionPerFile.flat();
      const sessionIds = new Set(sessionHandoffs.map((h) => h.handoffId));
      // Legacy rows only appear if the session file hasn't claimed them yet.
      const legacyOnly = globalPerFile.flat().filter((h) => !sessionIds.has(h.handoffId));
      return [...sessionHandoffs, ...legacyOnly];
    } catch {
      return [];
    }
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
    let found = false;
    await this.readModifyWrite(this.filePath(), (handoffs) =>
      handoffs.map((h) => {
        if (h.handoffId === handoffId) {
          found = true;
          return fn(h);
        }
        return h;
      }),
    );

    if (!found && this.sessionId !== undefined) {
      // Migration shim with claim-on-move: pre-#164 rows in _global.json
      // are visible and mutable to every scoped session, so the first
      // session to mutate them must claim ownership — otherwise peer
      // sessions keep seeing them in list/listForCurrentSession forever
      // and could re-ack or re-process a row already resolved.
      //
      // Mirrors SQLite's claim-on-write pattern (SET session_id =
      // COALESCE(session_id, ?)). Sequence:
      //   1. Mutate in _global via readModifyWrite (CAS-protected —
      //      state-machine guard inside fn prevents double resolution).
      //   2. Best-effort copy to session file (idempotent — dedupe by id).
      //   3. Best-effort delete from _global.
      //
      // We mutate FIRST instead of deleting first so a failure between
      // steps never produces data loss — the mutated row always survives
      // in at least _global. `mutatedRow` is reset on every readModifyWrite
      // attempt so a retry after losing a CAS race doesn't carry a stale
      // snapshot from attempt 1 into the session file.
      let mutatedRow: Handoff | undefined;
      await this.readModifyWrite(globalFile(this.zoneId), (handoffs) => {
        mutatedRow = undefined; // reset per retry — avoids stale snapshot on race
        const idx = handoffs.findIndex((h) => h.handoffId === handoffId);
        if (idx === -1) return handoffs;
        const current = handoffs[idx];
        if (current === undefined) return handoffs;
        const applied = fn(current);
        mutatedRow = applied;
        const copy = [...handoffs];
        copy[idx] = applied;
        return copy;
      });
      if (mutatedRow !== undefined) {
        found = true;
        const snapshot = mutatedRow;
        // Best-effort move: copy to session file, then delete from
        // _global. A failure here leaves the row in _global with the
        // mutation already applied — peer sessions will still see it
        // until the next retry, but state-machine guards prevent double
        // resolution. expireStale / a subsequent claim attempt will
        // eventually complete the move.
        try {
          await this.readModifyWrite(this.filePath(), (handoffs) => {
            const deduped = handoffs.filter((h) => h.handoffId !== handoffId);
            return [...deduped, snapshot];
          });
          await this.readModifyWrite(globalFile(this.zoneId), (handoffs) =>
            handoffs.filter((h) => h.handoffId !== handoffId),
          );
        } catch (moveErr) {
          debugLog(
            "NexusHandoffStore.updateHandoff",
            `claim-move follow-up failed for ${handoffId} (mutation in _global already committed) err=${moveErr instanceof Error ? moveErr.message : String(moveErr)}`,
          );
        }
      }
    }

    if (!found) {
      // Matches the InMemory/SQLite contract — mark* on a missing handoff is
      // a NotFoundError, not a silent no-op.
      const { NotFoundError } = await import("../core/errors.js");
      throw new NotFoundError({ resource: "Handoff", identifier: handoffId });
    }
  }

  private async readAllHandoffs(): Promise<Handoff[]> {
    // Short TTL cache — invalidated on own-process writes and when callers
    // know external mutation happened (SSE events, cross-client reply).
    // The invalidateCache() method is explicitly exported for that.
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
