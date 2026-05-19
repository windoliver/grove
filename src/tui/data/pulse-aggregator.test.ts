import { describe, expect, test } from "bun:test";
import type { AgentTaskEntity } from "../../core/agent-task.js";
import type { ContributionEntity, TimelineEventEntity } from "../../core/entity.js";
import type { Informer, RawInformerEvent } from "../../core/informer.js";
import { PulseAggregator } from "./pulse-aggregator.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type EventHandler<E> = (op: "ADDED" | "MODIFIED" | "DELETED", entity: E) => void;

class FakeInformer<E extends { id: string }> {
  private readonly handlers: Array<EventHandler<E>> = [];
  private readonly entities = new Map<string, E>();
  addEventHandler(fn: EventHandler<E>): () => void {
    this.handlers.push(fn);
    return () => {
      const i = this.handlers.indexOf(fn);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }
  // PulseAggregator subscribes via the raw, pre-coalesce channel, which
  // delivers a small RawInformerEvent projection (never the entity).
  // This fake delivers every emit() losslessly. Real-Informer
  // coalescing/overflow is covered by informer-coalescing.test.ts.
  private readonly rawHandlers: Array<(e: RawInformerEvent) => void> = [];
  addRawEventHandler(fn: (e: RawInformerEvent) => void): () => void {
    this.rawHandlers.push(fn);
    return () => {
      const i = this.rawHandlers.indexOf(fn);
      if (i >= 0) this.rawHandlers.splice(i, 1);
    };
  }
  private readonly syncHandlers: Array<() => void> = [];
  private synced = false;
  /** Number of times a registered sync handler fired immediately at
   *  registration because the informer was already synced AND the
   *  caller requested fireIfSynced. Lets tests assert PulseAggregator
   *  passed fireIfSynced=false. */
  immediateSyncFires = 0;
  /** Models Informer.addSyncHandler(fn, fireIfSynced=true). */
  addSyncHandler(fn: () => void, fireIfSynced = true): () => void {
    this.syncHandlers.push(fn);
    if (fireIfSynced && this.synced) {
      this.immediateSyncFires += 1;
      fn();
    }
    return () => {
      const i = this.syncHandlers.indexOf(fn);
      if (i >= 0) this.syncHandlers.splice(i, 1);
    };
  }
  /** Test helper: number of currently-registered sync handlers (proves
   *  dispose actually unsubscribed, not just disposed-guarded). */
  syncHandlerCount(): number {
    return this.syncHandlers.length;
  }
  /** Test helper: mark the informer as synced (post first RELIST_END). */
  markSynced(): void {
    this.synced = true;
  }
  /** Test helper: simulate a RELIST_END (sync) fan-out. */
  fireSync(): void {
    for (const h of [...this.syncHandlers]) h();
  }
  /** Test helper: add/replace an entity in the cache WITHOUT firing
   *  handlers (models a task introduced by a relist commitReplace, which
   *  the raw tap never observes). */
  seedCache(entity: E): void {
    this.entities.set(entity.id, entity);
  }
  /** Test helper: drop an entity from the cache without firing handlers
   *  (models a task removed by a relist that the raw tap never sees). */
  dropFromCache(id: string): void {
    this.entities.delete(id);
  }
  emit(op: "ADDED" | "MODIFIED" | "DELETED", entity: E): void {
    if (op === "DELETED") this.entities.delete(entity.id);
    else this.entities.set(entity.id, entity);
    const raw: RawInformerEvent = {
      op,
      id: entity.id,
      statusPhase: (entity as { status?: { phase?: string } }).status?.phase,
    };
    for (const h of [...this.rawHandlers]) h(raw);
    for (const h of [...this.handlers]) h(op, entity);
  }
  list(): readonly E[] {
    return Array.from(this.entities.values());
  }
}

function mkTask(
  id: string,
  phase: "Pending" | "PendingBind" | "Running" | "AwaitingReview" | "Succeeded" | "Failed",
): AgentTaskEntity {
  return {
    kind: "AgentTask",
    namespace: "default",
    id,
    spec: { phase, id, worktree: "wt" } as unknown as AgentTaskEntity["spec"],
    status: { phase } as unknown as AgentTaskEntity["status"],
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "0",
    metadata: { generation: 1 },
  } as AgentTaskEntity;
}

function mkEvent(id: string): TimelineEventEntity {
  return {
    kind: "TimelineEvent",
    namespace: "default",
    id,
    spec: {} as TimelineEventEntity["spec"],
    status: {} as TimelineEventEntity["status"],
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "0",
    metadata: { generation: 1 },
  } as TimelineEventEntity;
}

function mkContrib(id: string): ContributionEntity {
  return {
    kind: "Contribution",
    namespace: "default",
    id,
    spec: {} as ContributionEntity["spec"],
    status: {} as ContributionEntity["status"],
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "0",
    metadata: { generation: 1 },
  } as ContributionEntity;
}

interface Harness {
  tasks: FakeInformer<AgentTaskEntity>;
  events: FakeInformer<TimelineEventEntity>;
  contribs: FakeInformer<ContributionEntity>;
  agg: PulseAggregator;
  tick: () => void;
}

function makeHarness(): Harness {
  const tasks = new FakeInformer<AgentTaskEntity>();
  const events = new FakeInformer<TimelineEventEntity>();
  const contribs = new FakeInformer<ContributionEntity>();
  let tickFn: (() => void) | null = null;
  const agg = new PulseAggregator(
    tasks as unknown as Informer<"AgentTask">,
    events as unknown as Informer<"TimelineEvent">,
    contribs as unknown as Informer<"Contribution">,
    {
      tickMs: 1000,
      bucketCount: 60,
      setInterval: (fn) => {
        tickFn = fn;
        return 1;
      },
      clearInterval: () => {
        tickFn = null;
      },
    },
  );
  return {
    tasks,
    events,
    contribs,
    agg,
    tick: () => {
      if (tickFn) tickFn();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PulseAggregator — write path (lossless)", () => {
  test("1000 synchronous AgentTask ADDED events all land in the current spawn bucket", () => {
    const h = makeHarness();
    for (let i = 0; i < 1000; i++) {
      h.tasks.emit("ADDED", mkTask(`t${i}`, "Running"));
    }
    // Pre-tick: ring still all-zero, current bucket counter holds 1000.
    expect(h.agg.getSnapshot().series.spawnRate.every((v) => v === 0)).toBe(true);
    h.tick();
    const last = h.agg.getSnapshot().series.spawnRate;
    expect(last[last.length - 1]).toBe(1000);
  });

  test("TimelineEvent ADDED bumps event bucket; non-ADDED ops are ignored", () => {
    const h = makeHarness();
    h.events.emit("ADDED", mkEvent("e1"));
    h.events.emit("MODIFIED", mkEvent("e1"));
    h.events.emit("DELETED", mkEvent("e1"));
    h.tick();
    const last = h.agg.getSnapshot().series.eventRate;
    expect(last[last.length - 1]).toBe(1);
  });

  test("Contribution ADDED bumps contrib bucket; non-ADDED ops are ignored", () => {
    const h = makeHarness();
    h.contribs.emit("ADDED", mkContrib("c1"));
    h.contribs.emit("ADDED", mkContrib("c2"));
    h.contribs.emit("MODIFIED", mkContrib("c1"));
    h.contribs.emit("DELETED", mkContrib("c2"));
    h.tick();
    const last = h.agg.getSnapshot().series.contribRate;
    expect(last[last.length - 1]).toBe(2);
  });

  test("1000 synchronous Contribution ADDED events are lossless (one bucket)", () => {
    const h = makeHarness();
    for (let i = 0; i < 1000; i++) h.contribs.emit("ADDED", mkContrib(`c${i}`));
    expect(h.agg.getSnapshot().series.contribRate.every((v) => v === 0)).toBe(true);
    h.tick();
    const last = h.agg.getSnapshot().series.contribRate;
    expect(last[last.length - 1]).toBe(1000);
  });

  test("AgentTask transition into AwaitingReview bumps review bucket; re-entry bumps again", () => {
    const h = makeHarness();
    // Initial Running → not a review bump
    h.tasks.emit("ADDED", mkTask("t1", "Running"));
    // Running → AwaitingReview → bump
    h.tasks.emit("MODIFIED", mkTask("t1", "AwaitingReview"));
    // AwaitingReview → AwaitingReview → no bump (same phase)
    h.tasks.emit("MODIFIED", mkTask("t1", "AwaitingReview"));
    // AwaitingReview → Running → no bump
    h.tasks.emit("MODIFIED", mkTask("t1", "Running"));
    // Running → AwaitingReview → bump again
    h.tasks.emit("MODIFIED", mkTask("t1", "AwaitingReview"));
    h.tick();
    const last = h.agg.getSnapshot().series.reviewIterations;
    expect(last[last.length - 1]).toBe(2);
  });

  test("AgentTask DELETED clears the lastPhase entry so a future ADDED in AwaitingReview bumps once", () => {
    const h = makeHarness();
    h.tasks.emit("ADDED", mkTask("t1", "AwaitingReview")); // initial entry → 1 bump
    h.tasks.emit("DELETED", mkTask("t1", "AwaitingReview"));
    h.tasks.emit("ADDED", mkTask("t1", "AwaitingReview")); // re-add → 1 bump (no prev phase)
    h.tick();
    const last = h.agg.getSnapshot().series.reviewIterations;
    expect(last[last.length - 1]).toBe(2);
  });
});

describe("PulseAggregator — tick rotation", () => {
  test("each tick pushes the current bucket and zeroes it", () => {
    const h = makeHarness();
    h.tasks.emit("ADDED", mkTask("t1", "Running"));
    h.tick();
    // After tick, current bucket is zero; another tick should push 0.
    h.tick();
    const series = h.agg.getSnapshot().series.spawnRate;
    expect(series.length).toBe(60);
    expect(series[series.length - 1]).toBe(0);
    expect(series[series.length - 2]).toBe(1);
  });

  test("after bucketCount ticks the oldest sample falls off", () => {
    const h = makeHarness();
    // Tick once with a marker value of 1.
    h.tasks.emit("ADDED", mkTask("marker", "Running"));
    h.tick();
    // Then 60 zero-ticks. The marker should be gone.
    for (let i = 0; i < 60; i++) h.tick();
    const series = h.agg.getSnapshot().series.spawnRate;
    expect(series.every((v) => v === 0)).toBe(true);
  });
});

describe("PulseAggregator — gauge projection", () => {
  test("gauges count AgentTask phases from the live task informer cache", () => {
    const h = makeHarness();
    h.tasks.emit("ADDED", mkTask("t1", "Running"));
    h.tasks.emit("ADDED", mkTask("t2", "Running"));
    h.tasks.emit("ADDED", mkTask("t3", "AwaitingReview"));
    h.tasks.emit("ADDED", mkTask("t4", "Failed"));
    h.tasks.emit("ADDED", mkTask("t5", "Succeeded"));
    h.tasks.emit("ADDED", mkTask("t6", "Pending"));
    const g = h.agg.getSnapshot().gauges;
    expect(g.running).toBe(2);
    expect(g.waitingApproval).toBe(1);
    expect(g.failed).toBe(1);
  });
});

describe("PulseAggregator — subscribe + dispose", () => {
  test("subscribers fire on tick", () => {
    const h = makeHarness();
    let count = 0;
    const off = h.agg.subscribe(() => {
      count += 1;
    });
    h.tick();
    h.tick();
    expect(count).toBe(2);
    off();
    h.tick();
    expect(count).toBe(2);
  });

  test("dispose stops the interval and ignores further events", () => {
    const h = makeHarness();
    let count = 0;
    h.agg.subscribe(() => {
      count += 1;
    });
    h.agg.dispose();
    h.tick(); // tickFn was set null on dispose → no-op
    h.tasks.emit("ADDED", mkTask("late", "Running"));
    expect(count).toBe(0);
    const last = h.agg.getSnapshot().series.spawnRate;
    expect(last[last.length - 1]).toBe(0);
  });
});

describe("PulseAggregator — lastPhase seeding (round-3 regression)", () => {
  function build(tasks: FakeInformer<AgentTaskEntity>): {
    agg: PulseAggregator;
    tick: () => void;
  } {
    let tickFn: () => void = () => undefined;
    const agg = new PulseAggregator(
      tasks as unknown as Informer<"AgentTask">,
      new FakeInformer<TimelineEventEntity>() as unknown as Informer<"TimelineEvent">,
      new FakeInformer<ContributionEntity>() as unknown as Informer<"Contribution">,
      {
        setInterval: (fn) => {
          tickFn = fn;
          return 1;
        },
        clearInterval: () => {
          tickFn = () => undefined;
        },
      },
    );
    return { agg, tick: () => tickFn() };
  }

  test("a task already in AwaitingReview at construction is NOT miscounted on a same-phase MODIFIED", () => {
    const tasks = new FakeInformer<AgentTaskEntity>();
    // Pre-existing AwaitingReview task in the namespace BEFORE the
    // aggregator is constructed (no handlers yet — only populates list()).
    tasks.emit("ADDED", mkTask("pre", "AwaitingReview"));

    const { agg, tick } = build(tasks);

    // A later same-phase MODIFIED must NOT count as a fresh review
    // iteration — lastPhase was seeded from list() at construction.
    tasks.emit("MODIFIED", mkTask("pre", "AwaitingReview"));
    tick();
    expect(agg.getSnapshot().series.reviewIterations.at(-1)).toBe(0);

    // A genuine transition still counts.
    tasks.emit("MODIFIED", mkTask("pre", "Running"));
    tasks.emit("MODIFIED", mkTask("pre", "AwaitingReview"));
    tick();
    expect(agg.getSnapshot().series.reviewIterations.at(-1)).toBe(1);

    agg.dispose();
  });

  test("RELIST reconciliation: a relist-introduced AwaitingReview task is not miscounted", () => {
    const tasks = new FakeInformer<AgentTaskEntity>();
    const { agg, tick } = build(tasks); // constructed with empty cache

    // Reconnect/overflow recovery: a relist commitReplace puts an
    // AwaitingReview task into the cache. The raw tap never sees it
    // (control RELIST_* + commitReplace bypass raw handlers).
    tasks.seedCache(mkTask("r1", "AwaitingReview"));
    tasks.fireSync(); // RELIST_END → PulseAggregator reseeds lastPhase

    // Next same-phase MODIFIED must NOT be a false review iteration.
    tasks.emit("MODIFIED", mkTask("r1", "AwaitingReview"));
    tick();
    expect(agg.getSnapshot().series.reviewIterations.at(-1)).toBe(0);

    agg.dispose();
  });

  test("RELIST reconciliation: a task deleted during relist leaves no stale lastPhase entry", () => {
    const tasks = new FakeInformer<AgentTaskEntity>();
    tasks.emit("ADDED", mkTask("g1", "Running"));
    const { agg, tick } = build(tasks);

    // Relist drops g1 (the raw tap never sees a DELETED for it).
    tasks.dropFromCache("g1");
    tasks.fireSync(); // reseed → lastPhase no longer has g1

    // g1 reappears later (new task, same id) already in AwaitingReview:
    // with a stale entry this would be suppressed; correctly it counts
    // once as a genuine first entry.
    tasks.emit("ADDED", mkTask("g1", "AwaitingReview"));
    tick();
    expect(agg.getSnapshot().series.reviewIterations.at(-1)).toBe(1);

    agg.dispose();
  });

  test("relist reseed is registered with fireIfSynced=false (no immediate fire when already synced)", () => {
    const tasks = new FakeInformer<AgentTaskEntity>();
    tasks.emit("ADDED", mkTask("s1", "Running"));
    tasks.markSynced(); // informer already past first RELIST_END

    const { agg } = build(tasks);

    // PulseAggregator reseeds explicitly in the ctor and must register
    // the relist handler with fireIfSynced=false — so registering it
    // here must NOT trigger an immediate redundant reseed fan-out.
    expect(tasks.immediateSyncFires).toBe(0);
    expect(tasks.syncHandlerCount()).toBe(1);

    agg.dispose();
  });

  test("dispose() actually unsubscribes the relist sync handler", () => {
    const tasks = new FakeInformer<AgentTaskEntity>();
    const { agg } = build(tasks);
    expect(tasks.syncHandlerCount()).toBe(1);

    agg.dispose();
    // Proves real unsubscription, not just the disposed-guard: a later
    // RELIST_END must not reach a removed handler.
    expect(tasks.syncHandlerCount()).toBe(0);
  });
});
