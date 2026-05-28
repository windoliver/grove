/**
 * Regression: PulseAggregator must count rate/transition metrics
 * losslessly against the REAL Informer, whose `addEventHandler` path
 * runs AFTER per-id queue coalescing and can be wiped by overflow
 * clear(). PulseAggregator subscribes via `addRawEventHandler` (raw,
 * pre-coalesce, overflow-immune). These tests use a real Informer with
 * a synthetic stream; FakeInformer in the sibling suite delivers every
 * event and would mask the coalescing path.
 *
 * CRITICAL test discipline (round-2 review): events MUST be emitted
 * synchronously with NO `await` between them and the assertion taken
 * BEFORE yielding to the microtask queue. `Informer.enqueue` returns
 * void for deltas and schedules `drain()` via `queueMicrotask`; any
 * `await` between emits would let the coalescing/overflow drain run, so
 * an awaited burst would NOT exercise the pre-coalesce path and a
 * regression to the coalesced handler could pass undetected.
 *
 * Root cause found by adversarial review 2026-05-18.
 */

import { describe, expect, test } from "bun:test";
import type { AgentTaskEntity } from "../../core/agent-task.js";
import { Informer } from "../../core/informer.js";
import type { WatchClientEvent } from "../../core/watch-client.js";
import type { WatchKind } from "../../core/watch-events.js";
import type { WatchStream } from "../../core/watch-stream.js";
import { PulseAggregator } from "./pulse-aggregator.js";

/**
 * Synthetic stream whose `emit` invokes the informer's onEvent
 * synchronously. `run()` sets onEvent before its first await, so onEvent
 * is wired by the time `void informer.run()` returns.
 */
function makeFakeStream(): {
  stream: WatchStream;
  emit: (e: WatchClientEvent) => void;
} {
  let onEvent: ((e: WatchClientEvent) => void | Promise<void>) | null = null;
  const stream: WatchStream = {
    run: async (opts) => {
      onEvent = opts.onEvent;
      await new Promise<void>((resolve) => {
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      onEvent = null;
    },
  };
  return {
    stream,
    emit: (e) => {
      if (!onEvent) throw new Error("stream not running");
      // Deltas return void synchronously; do NOT await (would drain).
      void onEvent(e);
    },
  };
}

function taskEvent(
  op: "ADDED" | "MODIFIED" | "DELETED",
  id: string,
  rv: number,
  phase: AgentTaskEntity["status"]["phase"],
): WatchClientEvent {
  return {
    op,
    rv: BigInt(rv),
    kind: "AgentTask",
    entity: {
      kind: "AgentTask",
      namespace: "default",
      id,
      spec: { phase, id, worktree: "wt" },
      status: { phase },
      conditions: [],
      observedGeneration: 0,
      resourceVersion: String(rv),
      metadata: { generation: 1 },
    } as unknown as WatchClientEvent["entity"],
  };
}

function contribEvent(id: string, rv: number): WatchClientEvent {
  return {
    op: "ADDED",
    rv: BigInt(rv),
    kind: "Contribution",
    entity: {
      kind: "Contribution",
      namespace: "default",
      id,
      spec: {},
      status: {},
      conditions: [],
      observedGeneration: 0,
      resourceVersion: String(rv),
      metadata: { generation: 1 },
    } as unknown as WatchClientEvent["entity"],
  };
}

/** Stub informer for the kinds a given test does not drive. */
function stubInformer<K extends WatchKind>(): Informer<K> {
  const unsub = (): void => undefined;
  const noop = (): (() => void) => unsub;
  return {
    addEventHandler: noop,
    addRawEventHandler: noop,
    addSyncHandler: noop,
    hasSynced: () => false,
    getById: () => undefined,
    list: () => [],
  } as unknown as Informer<K>;
}

function makeAgg(
  taskInformer: Informer<"AgentTask">,
  timelineInformer: Informer<"TimelineEvent">,
  contribInformer: Informer<"Contribution">,
): { agg: PulseAggregator; tick: () => void } {
  let tickFn: () => void = () => undefined;
  const agg = new PulseAggregator(taskInformer, timelineInformer, contribInformer, {
    scheduleTick: (cb) => {
      tickFn = cb;
      return () => {
        tickFn = () => undefined;
      };
    },
  });
  return { agg, tick: () => tickFn() };
}

describe("PulseAggregator vs real Informer coalescing", () => {
  test("same-id Running→AwaitingReview burst pre-drain is NOT collapsed (reviewIterations lossless)", () => {
    const { stream, emit } = makeFakeStream();
    const taskInformer = new Informer(stream, "AgentTask");
    const ac = new AbortController();
    void taskInformer.run(ac.signal);
    const { agg, tick } = makeAgg(
      taskInformer,
      stubInformer<"TimelineEvent">(),
      stubInformer<"Contribution">(),
    );

    // Synchronous burst, NO await — all four land in the Map<id,event>
    // queue (collapsing to final state) before any drain microtask. The
    // coalesced handler path would observe at most one AwaitingReview.
    emit(taskEvent("ADDED", "t1", 1, "Running"));
    emit(taskEvent("MODIFIED", "t1", 2, "AwaitingReview"));
    emit(taskEvent("MODIFIED", "t1", 3, "Running"));
    emit(taskEvent("MODIFIED", "t1", 4, "AwaitingReview"));

    // Assert BEFORE yielding — proves the raw path captured both entries
    // independently of (and prior to) any coalescing drain.
    tick();
    const series = agg.getSnapshot().series;
    expect(series.reviewIterations[series.reviewIterations.length - 1]).toBe(2);

    agg.dispose();
    ac.abort();
  });

  test("overflow clear() does not lose Contribution counts (raw path immune)", () => {
    const { stream, emit } = makeFakeStream();
    // queueLimit=4 so the next distinct id past 4 trips overflow clear();
    // 50 distinct ADDED in one stack frame overflow repeatedly.
    const contribInformer = new Informer(stream, "Contribution", { queueLimit: 4 });
    const ac = new AbortController();
    void contribInformer.run(ac.signal);
    const { agg, tick } = makeAgg(
      stubInformer<"AgentTask">(),
      stubInformer<"TimelineEvent">(),
      contribInformer,
    );

    for (let i = 0; i < 50; i++) emit(contribEvent(`c${i}`, i + 1));

    tick();
    const series = agg.getSnapshot().series;
    expect(series.contribRate[series.contribRate.length - 1]).toBe(50);

    agg.dispose();
    ac.abort();
  });

  test("control: the coalesced handler path undercounts the same burst", async () => {
    // Proves the raw path is load-bearing, not redundant: a plain
    // addEventHandler on the identical burst sees only the post-drain
    // collapsed state.
    const { stream, emit } = makeFakeStream();
    const taskInformer = new Informer(stream, "AgentTask");
    const ac = new AbortController();
    void taskInformer.run(ac.signal);

    let coalescedAwaitingReview = 0;
    let prev: string | undefined;
    taskInformer.addEventHandler((op, entity) => {
      if (op === "DELETED") return;
      const phase = (entity as unknown as AgentTaskEntity).status.phase;
      if (phase === "AwaitingReview" && prev !== "AwaitingReview") coalescedAwaitingReview += 1;
      prev = phase;
    });

    emit(taskEvent("ADDED", "t1", 1, "Running"));
    emit(taskEvent("MODIFIED", "t1", 2, "AwaitingReview"));
    emit(taskEvent("MODIFIED", "t1", 3, "Running"));
    emit(taskEvent("MODIFIED", "t1", 4, "AwaitingReview"));

    // Let the drain microtask run; the queue has collapsed t1 to its
    // final state, so the coalesced path sees at most one transition.
    await Promise.resolve();
    await Promise.resolve();
    expect(coalescedAwaitingReview).toBeLessThan(2);

    ac.abort();
  });

  test("raw projection is runtime-frozen: a mutating handler cannot corrupt later handlers", () => {
    const { stream, emit } = makeFakeStream();
    const taskInformer = new Informer(stream, "AgentTask");
    const ac = new AbortController();
    void taskInformer.run(ac.signal);

    let firstWasFrozen = false;
    // Handler 1 (registered first) tries to corrupt the shared event.
    taskInformer.addRawEventHandler((e) => {
      firstWasFrozen = Object.isFrozen(e);
      try {
        (e as { op: string }).op = "DELETED";
        (e as { id: string }).id = "hacked";
        (e as { statusPhase?: string }).statusPhase = "Failed";
      } catch {
        // strict-mode write to a frozen object throws — also fine.
      }
    });
    // Handler 2 must still observe the original, unmutated fields.
    let seenOp: string | undefined;
    let seenId: string | undefined;
    let seenPhase: string | undefined;
    taskInformer.addRawEventHandler((e) => {
      seenOp = e.op;
      seenId = e.id;
      seenPhase = e.statusPhase;
    });

    emit(taskEvent("ADDED", "real-1", 1, "Running"));

    expect(firstWasFrozen).toBe(true);
    expect(seenOp).toBe("ADDED");
    expect(seenId).toBe("real-1");
    expect(seenPhase).toBe("Running");

    ac.abort();
  });
});
