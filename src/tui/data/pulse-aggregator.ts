/**
 * PulseAggregator — pure data class powering the Pulse view (#308).
 *
 * Owns three 60-bucket ring buffers (spawn rate, event rate, review
 * iterations) and a 1Hz tick. Subscribes to AgentSession, AgentTask, and
 * TimelineEvent informers; every event synchronously bumps the current
 * bucket counter (lossless data path). A setInterval rotates the rings
 * and notifies subscribers (coalesced render cadence).
 *
 * Gauge counts (running / waiting-approval / failed) are projected on
 * demand from the AgentTask informer cache — no rate math.
 */

import type { AgentTaskEntity } from "../../core/entity.js";
import type { Informer } from "../../core/informer.js";

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
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
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
  private readonly clearIntervalFn: (handle: unknown) => void;

  private spawnRing: number[];
  private eventRing: number[];
  private reviewRing: number[];

  private spawnBucket = 0;
  private eventBucket = 0;
  private reviewBucket = 0;

  private readonly subscribers = new Set<() => void>();
  private readonly unsubs: Array<() => void> = [];
  private readonly lastPhase = new Map<string, AgentTaskEntity["status"]["phase"]>();
  private intervalHandle: unknown = null;
  private disposed = false;
  private _tickedAt: number;

  // Snapshot cache: keyed by tickedAt; series ring slices are reused
  // when no tick has occurred between getSnapshot() calls.
  private snapshotCache: PulseSnapshot | null = null;
  private snapshotTickedAt = -1;

  constructor(
    taskInformer: Informer<"AgentTask">,
    sessionInformer: Informer<"AgentSession">,
    timelineInformer: Informer<"TimelineEvent">,
    options?: PulseAggregatorOptions,
  ) {
    this.taskInformer = taskInformer;
    this.bucketCount = options?.bucketCount ?? DEFAULT_BUCKET_COUNT;
    this.now = options?.now ?? Date.now;
    const setIntervalFn = options?.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn =
      options?.clearInterval ?? (globalThis.clearInterval as (h: unknown) => void);
    const tickMs = options?.tickMs ?? DEFAULT_TICK_MS;

    this.spawnRing = new Array(this.bucketCount).fill(0);
    this.eventRing = new Array(this.bucketCount).fill(0);
    this.reviewRing = new Array(this.bucketCount).fill(0);
    this._tickedAt = this.now();

    this.unsubs.push(
      sessionInformer.addEventHandler((op, _entity) => {
        if (this.disposed) return;
        if (op === "ADDED") this.spawnBucket += 1;
      }),
    );
    this.unsubs.push(
      timelineInformer.addEventHandler((op, _entity) => {
        if (this.disposed) return;
        if (op === "ADDED") this.eventBucket += 1;
      }),
    );
    this.unsubs.push(
      taskInformer.addEventHandler((op, entity) => {
        if (this.disposed) return;
        if (op === "DELETED") {
          this.lastPhase.delete(entity.id);
          return;
        }
        const phase = entity.status.phase;
        const prev = this.lastPhase.get(entity.id);
        if (phase === AWAITING_REVIEW && prev !== AWAITING_REVIEW) {
          this.reviewBucket += 1;
        }
        this.lastPhase.set(entity.id, phase);
      }),
    );

    this.intervalHandle = setIntervalFn(() => this.tick(), tickMs);
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
    if (this.intervalHandle !== null) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
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
    this.spawnBucket = 0;
    this.eventBucket = 0;
    this.reviewBucket = 0;
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
