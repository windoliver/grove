/**
 * PulseAggregator — pure data class powering the Pulse view (#308).
 *
 * Owns four 60-bucket ring buffers (spawn / event / review / contrib
 * rate) and a 1Hz tick. Subscribes to AgentTask, TimelineEvent, and
 * Contribution informers via `addRawEventHandler` — the raw,
 * pre-coalesce, overflow-immune channel. (`addEventHandler` fires after
 * the Informer's Map<id,event> queue has collapsed same-id bursts to
 * final state and after overflow clear(), which would undercount
 * reviewIterations and the ADDED rates.) Every raw event synchronously
 * bumps the current bucket counter (truly lossless data path). A 1Hz
 * periodic tick (via the approved `startInterval` seam — `src/tui` may
 * not contain a raw timer literal per the A8 acceptance grep) rotates
 * the rings and notifies subscribers (coalesced render cadence). Spawn
 * rate counts
 * AgentTask ADDED — the remote-watchable unit of agent work (AgentSession
 * is not server-watched in remote mode). Contrib rate counts Contribution
 * ADDED — the one signal every preset emits (review-loop spawns agents
 * directly, not via the task-controller, so AgentTask/TimelineEvent are
 * empty there; contributions always flow).
 *
 * Gauge counts (running / waiting-approval / failed) are projected on
 * demand from the AgentTask informer cache — no rate math.
 */

import type { AgentTaskEntity } from "../../core/agent-task.js";
import type { Informer } from "../../core/informer.js";
import { startInterval } from "../../local/use-interval.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GaugeSnapshot {
  readonly running: number;
  readonly waitingApproval: number;
  readonly failed: number;
}

export interface SeriesSnapshot {
  readonly spawnRate: readonly number[];
  readonly eventRate: readonly number[];
  readonly reviewIterations: readonly number[];
  /** Contribution ADDED rate. The one signal every preset emits (review-loop
   *  spawns agents directly, not via the task-controller, so AgentTask /
   *  TimelineEvent stay empty there — but contributions always flow and are
   *  in REMOTE_KINDS). Keeps Pulse meaningful outside task-controller flows. */
  readonly contribRate: readonly number[];
}

export interface PulseSnapshot {
  readonly gauges: GaugeSnapshot;
  readonly series: SeriesSnapshot;
  readonly tickedAt: number;
}

export interface PulseAggregatorOptions {
  readonly tickMs?: number;
  readonly bucketCount?: number;
  readonly now?: () => number;
  /**
   * Periodic-tick seam. Returns a stop function (same shape as
   * `startInterval` from `src/local/use-interval`). Tests inject a fake
   * that captures the callback. Named to avoid the banned raw timer
   * literal in `src/tui` (A8 acceptance grep).
   */
  readonly scheduleTick?: (cb: () => void, ms: number) => () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TICK_MS = 1000;
const DEFAULT_BUCKET_COUNT = 60;

const AWAITING_REVIEW: AgentTaskEntity["status"]["phase"] = "AwaitingReview";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PulseAggregator {
  private readonly taskInformer: Informer<"AgentTask">;
  private readonly bucketCount: number;
  private readonly now: () => number;
  private stopTick: (() => void) | null = null;

  private spawnRing: number[];
  private eventRing: number[];
  private reviewRing: number[];
  private contribRing: number[];

  private spawnBucket = 0;
  private eventBucket = 0;
  private reviewBucket = 0;
  private contribBucket = 0;

  private readonly subscribers = new Set<() => void>();
  private readonly unsubs: Array<() => void> = [];
  // String, not the phase union: the raw tap delivers status.phase as a
  // plain primitive string projection (RawInformerEvent.statusPhase).
  private readonly lastPhase = new Map<string, string>();
  private disposed = false;
  private _tickedAt: number;

  // Snapshot cache: keyed by tickedAt; series ring slices are reused
  // when no tick has occurred between getSnapshot() calls.
  private snapshotCache: PulseSnapshot | null = null;
  private snapshotTickedAt = -1;

  constructor(
    taskInformer: Informer<"AgentTask">,
    timelineInformer: Informer<"TimelineEvent">,
    contribInformer: Informer<"Contribution">,
    options?: PulseAggregatorOptions,
  ) {
    this.taskInformer = taskInformer;
    this.bucketCount = options?.bucketCount ?? DEFAULT_BUCKET_COUNT;
    this.now = options?.now ?? Date.now;
    const scheduleTick = options?.scheduleTick ?? startInterval;
    const tickMs = options?.tickMs ?? DEFAULT_TICK_MS;

    this.spawnRing = new Array(this.bucketCount).fill(0);
    this.eventRing = new Array(this.bucketCount).fill(0);
    this.reviewRing = new Array(this.bucketCount).fill(0);
    this.contribRing = new Array(this.bucketCount).fill(0);
    this._tickedAt = this.now();

    // Reconcile lastPhase from the AgentTask cache now AND on every
    // relist. Construction-only seeding is insufficient: the raw tap
    // sees deltas only — control RELIST_* events skip raw handlers and
    // relist-derived adds/mods/dels are committed wholesale to the
    // cache via the coalesced path. After a reconnect / overflow
    // recovery, taskInformer.list() changes while lastPhase would
    // otherwise stay frozen → a task already in AwaitingReview gets
    // miscounted on its next same-phase MODIFIED, deleted tasks leave
    // stale entries. A relist is "here is current truth", not real
    // activity, so reseed must NOT touch the rate buckets.
    this.reseedLastPhase(taskInformer);
    this.unsubs.push(
      // fireIfSynced=false: we just reseeded explicitly; only react to
      // FUTURE RELIST_END (reconnect / overflow recovery).
      taskInformer.addSyncHandler(() => {
        if (this.disposed) return;
        this.reseedLastPhase(taskInformer);
      }, false),
    );

    this.unsubs.push(
      timelineInformer.addRawEventHandler((e) => {
        if (this.disposed) return;
        if (e.op === "ADDED") this.eventBucket += 1;
      }),
    );
    this.unsubs.push(
      contribInformer.addRawEventHandler((e) => {
        if (this.disposed) return;
        if (e.op === "ADDED") this.contribBucket += 1;
      }),
    );
    this.unsubs.push(
      taskInformer.addRawEventHandler((e) => {
        if (this.disposed) return;
        if (e.op === "DELETED") {
          this.lastPhase.delete(e.id);
          return;
        }
        if (e.op === "ADDED") this.spawnBucket += 1;
        const phase = e.statusPhase;
        const prev = this.lastPhase.get(e.id);
        if (phase === AWAITING_REVIEW && prev !== AWAITING_REVIEW) {
          this.reviewBucket += 1;
        }
        if (phase !== undefined) this.lastPhase.set(e.id, phase);
      }),
    );

    this.stopTick = scheduleTick(() => this.tick(), tickMs);
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  getSnapshot(): PulseSnapshot {
    if (this.snapshotCache && this.snapshotTickedAt === this._tickedAt) {
      // Gauges may have moved between ticks (informer events mutate the
      // underlying cache without touching the ring), so always recompute
      // them; only the series slices benefit from the cache.
      const gauges = this.projectGauges();
      if (gaugesEqual(gauges, this.snapshotCache.gauges)) {
        return this.snapshotCache;
      }
      const next: PulseSnapshot = {
        gauges,
        series: this.snapshotCache.series,
        tickedAt: this._tickedAt,
      };
      this.snapshotCache = next;
      return next;
    }
    const series: SeriesSnapshot = {
      spawnRate: this.spawnRing.slice(),
      eventRate: this.eventRing.slice(),
      reviewIterations: this.reviewRing.slice(),
      contribRate: this.contribRing.slice(),
    };
    const snapshot: PulseSnapshot = {
      gauges: this.projectGauges(),
      series,
      tickedAt: this._tickedAt,
    };
    this.snapshotCache = snapshot;
    this.snapshotTickedAt = this._tickedAt;
    return snapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.stopTick !== null) {
      this.stopTick();
      this.stopTick = null;
    }
    for (const off of this.unsubs) {
      try {
        off();
      } catch {
        // ignore — handler list may already be torn down
      }
    }
    this.unsubs.length = 0;
    this.subscribers.clear();
    this.lastPhase.clear();
  }

  private tick(): void {
    if (this.disposed) return;
    this.spawnRing = pushRing(this.spawnRing, this.spawnBucket, this.bucketCount);
    this.eventRing = pushRing(this.eventRing, this.eventBucket, this.bucketCount);
    this.reviewRing = pushRing(this.reviewRing, this.reviewBucket, this.bucketCount);
    this.contribRing = pushRing(this.contribRing, this.contribBucket, this.bucketCount);
    this.spawnBucket = 0;
    this.eventBucket = 0;
    this.reviewBucket = 0;
    this.contribBucket = 0;
    this._tickedAt = this.now();
    this.snapshotCache = null;
    this.snapshotTickedAt = -1;
    for (const fn of [...this.subscribers]) {
      try {
        fn();
      } catch (err) {
        console.error("PulseAggregator: subscriber threw, continuing fanout:", err);
      }
    }
  }

  /**
   * Rebuild `lastPhase` from the current AgentTask cache. Used at
   * construction and on every RELIST_END. Pure reconciliation — it
   * replaces the map wholesale (dropping stale ids for tasks removed
   * during the relist) and deliberately does NOT touch any rate bucket:
   * a relist reports current truth, not new activity.
   */
  private reseedLastPhase(taskInformer: Informer<"AgentTask">): void {
    this.lastPhase.clear();
    for (const t of taskInformer.list()) {
      this.lastPhase.set(t.id, t.status.phase);
    }
  }

  private projectGauges(): GaugeSnapshot {
    let running = 0;
    let waitingApproval = 0;
    let failed = 0;
    const tasks = this.taskInformer.list();
    for (const t of tasks) {
      const phase = t.status.phase;
      if (phase === "Running") running += 1;
      else if (phase === AWAITING_REVIEW) waitingApproval += 1;
      else if (phase === "Failed") failed += 1;
    }
    return { running, waitingApproval, failed };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pushRing(ring: readonly number[], value: number, capacity: number): number[] {
  const next = ring.slice(1, capacity);
  next.push(value);
  return next;
}

function gaugesEqual(a: GaugeSnapshot, b: GaugeSnapshot): boolean {
  return (
    a.running === b.running && a.waitingApproval === b.waitingApproval && a.failed === b.failed
  );
}
