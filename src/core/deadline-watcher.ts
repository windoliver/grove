/**
 * Proactive deadline enforcement for handoffs with reply deadlines.
 *
 * Instead of relying on passive expiry (expireStale() called on read),
 * the DeadlineWatcher registers per-handoff timers that fire when a
 * deadline passes. On fire, it checks whether the handoff is still
 * unresolved and emits a "handoff.overdue" event if so.
 *
 * Lifecycle:
 *   1. Call watch(handoff) for each new handoff with a replyDueAt.
 *   2. Call cancel(handoffId) when a handoff is resolved (replied/expired).
 *   3. Call rebuildFromStore() on process startup to re-register timers
 *      for any unresolved handoffs with future deadlines.
 *   4. Call close() to cancel all timers on shutdown.
 */

import type { EventBus } from "./event-bus.js";
import type { Handoff, HandoffStore } from "./handoff.js";
import { HandoffStatus } from "./handoff.js";

const DEBUG = process.env.GROVE_DEBUG === "1";
function log(msg: string): void {
  if (!DEBUG) return;
  process.stderr.write(`[grove:deadline-watcher] ${msg}\n`);
}

export interface DeadlineWatcherOpts {
  /** HandoffStore to query on timer fire (verify still unresolved). */
  readonly handoffStore: HandoffStore;
  /** EventBus to emit "handoff.overdue" events. */
  readonly eventBus: EventBus;
  /** Maximum age (ms) of handoffs to consider on cold-start rebuild. Default: 7 days. */
  readonly maxRebuildAgeMs?: number;
}

const DEFAULT_MAX_REBUILD_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class DeadlineWatcher {
  private readonly handoffStore: HandoffStore;
  private readonly eventBus: EventBus;
  private readonly maxRebuildAgeMs: number;

  /** Active timers keyed by handoffId. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: DeadlineWatcherOpts) {
    this.handoffStore = opts.handoffStore;
    this.eventBus = opts.eventBus;
    this.maxRebuildAgeMs = opts.maxRebuildAgeMs ?? DEFAULT_MAX_REBUILD_AGE_MS;
  }

  /**
   * Register a deadline timer for a handoff.
   *
   * If the deadline is already past, fires immediately (async check).
   * If the handoff has no replyDueAt, this is a no-op.
   * If a timer already exists for this handoffId, it is replaced.
   */
  watch(handoff: Handoff): void {
    if (handoff.replyDueAt === undefined) return;

    // Cancel any existing timer for this handoff
    this.cancel(handoff.handoffId);

    const deadlineMs = new Date(handoff.replyDueAt).getTime();
    const delayMs = Math.max(0, deadlineMs - Date.now());

    log(`WATCH handoff=${handoff.handoffId.slice(0, 8)} toRole=${handoff.toRole} delayMs=${delayMs} replyDueAt=${handoff.replyDueAt}`);

    const timer = setTimeout(() => {
      log(`TIMER FIRED handoff=${handoff.handoffId.slice(0, 8)} — checking if still unresolved`);
      this.timers.delete(handoff.handoffId);
      void this.onDeadlineFired(handoff.handoffId, handoff.fromRole, handoff.toRole);
    }, delayMs);

    // Prevent timer from keeping the process alive
    if (timer.unref) timer.unref();

    this.timers.set(handoff.handoffId, timer);
  }

  /**
   * Cancel the deadline timer for a handoff (e.g., when resolved).
   */
  cancel(handoffId: string): void {
    const timer = this.timers.get(handoffId);
    if (timer !== undefined) {
      log(`CANCEL handoff=${handoffId.slice(0, 8)} — resolved before deadline`);
      clearTimeout(timer);
      this.timers.delete(handoffId);
    }
  }

  /**
   * Rebuild timers from the store on process startup.
   *
   * Scans for unresolved handoffs (pending_pickup or delivered) with
   * future deadlines created within the max rebuild age window.
   */
  async rebuildFromStore(): Promise<number> {
    // Rebuild requires session-scoped enumeration. Stores that don't
    // implement listForCurrentSession share data across sessions (e.g.
    // SQLite without a session_id column on handoffs, or Nexus in certain
    // configurations), so falling back to list() would arm timers for
    // handoffs in other sessions and emit cross-session overdue events.
    //
    // When unavailable, skip rebuild entirely — timers will still be
    // registered for newly-created handoffs via watch(). The only impact
    // is that mid-process restarts won't re-arm existing deadlines, which
    // is safer than the alternative.
    if (this.handoffStore.listForCurrentSession === undefined) {
      log(`REBUILD skipped — store does not support session-scoped enumeration`);
      return 0;
    }

    const cutoffDate = new Date(Date.now() - this.maxRebuildAgeMs).toISOString();
    const unresolved = await this.handoffStore.listForCurrentSession({
      status: [HandoffStatus.PendingPickup, HandoffStatus.Delivered],
    });

    let registered = 0;
    for (const h of unresolved) {
      if (
        h.replyDueAt !== undefined &&
        h.createdAt >= cutoffDate
      ) {
        this.watch(h);
        registered++;
      }
    }

    log(`REBUILD registered=${registered} from ${unresolved.length} unresolved handoffs`);
    return registered;
  }

  /** Number of active deadline timers. */
  get activeCount(): number {
    return this.timers.size;
  }

  /** Cancel all timers and release resources. */
  close(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async onDeadlineFired(
    handoffId: string,
    fromRole: string,
    toRole: string,
  ): Promise<void> {
    try {
      // Re-read the handoff to check if it's still unresolved
      const handoff = await this.handoffStore.get(handoffId);
      if (handoff === undefined) return;

      // Only transition and emit overdue if still unresolved
      if (
        handoff.status !== HandoffStatus.PendingPickup &&
        handoff.status !== HandoffStatus.Delivered
      ) {
        log(`TIMER FIRED handoff=${handoffId.slice(0, 8)} status=${handoff.status} — already resolved, skipping`);
        return;
      }

      // Flush expiry for ALL overdue handoffs at this point. Only handoffs
      // returned by expireStale() are ones THIS process atomically transitioned
      // from unresolved → expired; other processes with their own watchers
      // would have their own expireStale() return different subsets. Emitting
      // only on transition ownership deduplicates overdue events across
      // processes — if another watcher already expired our handoff, expireStale
      // here returns empty, and we emit nothing. This is intentional: the
      // other watcher already emitted (single-owner semantics via store CAS).
      let expired: readonly Handoff[] = [];
      try {
        expired = await this.handoffStore.expireStale();
      } catch {
        // best-effort
      }

      const timestamp = new Date().toISOString();

      // Emit overdue events for every handoff that just transitioned. Each
      // event targets the handoff's own toRole, not the firing timer's toRole.
      for (const h of expired) {
        log(`OVERDUE handoff=${h.handoffId.slice(0, 8)} toRole=${h.toRole} — emitting handoff.overdue event`);
        this.eventBus.publish({
          type: "handoff.overdue",
          sourceRole: h.fromRole,
          targetRole: h.toRole,
          payload: {
            handoffId: h.handoffId,
            sourceCid: h.sourceCid,
            replyDueAt: h.replyDueAt,
            status: HandoffStatus.Expired,
          },
          timestamp,
        });
        // Cancel any peer timer so it doesn't fire and emit a duplicate
        this.cancel(h.handoffId);
      }

      // If expireStale didn't return our handoff, another watcher (or a
      // reply that raced the timer) already transitioned it. Do NOT emit a
      // fallback event — that would produce duplicate overdue notifications
      // in multi-watcher/multi-process setups.
      if (expired.length === 0) {
        log(`TIMER FIRED handoff=${handoffId.slice(0, 8)} — already transitioned by another actor, skipping emit (from/to=${fromRole}/${toRole})`);
      }
    } catch (err) {
      log(`TIMER ERROR handoff=${handoffId.slice(0, 8)} err=${err instanceof Error ? err.message : String(err)}`);
      // Best-effort — timer callback failures are non-fatal
    }
  }
}
