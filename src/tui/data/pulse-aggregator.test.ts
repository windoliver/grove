import { describe, expect, test } from "bun:test";
import type { AgentTaskEntity } from "../../core/agent-task.js";
import type { TimelineEventEntity } from "../../core/entity.js";
import type { Informer } from "../../core/informer.js";
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
  emit(op: "ADDED" | "MODIFIED" | "DELETED", entity: E): void {
    if (op === "DELETED") this.entities.delete(entity.id);
    else this.entities.set(entity.id, entity);
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

interface Harness {
  tasks: FakeInformer<AgentTaskEntity>;
  events: FakeInformer<TimelineEventEntity>;
  agg: PulseAggregator;
  tick: () => void;
}

function makeHarness(): Harness {
  const tasks = new FakeInformer<AgentTaskEntity>();
  const events = new FakeInformer<TimelineEventEntity>();
  let tickFn: (() => void) | null = null;
  const agg = new PulseAggregator(
    tasks as unknown as Informer<"AgentTask">,
    events as unknown as Informer<"TimelineEvent">,
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
