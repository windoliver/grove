/**
 * Regression: PulseAggregator must count rate/transition metrics
 * losslessly against the REAL Informer, whose `addEventHandler` path
 * runs AFTER per-id queue coalescing and can be wiped by overflow
 * clear(). PulseAggregator subscribes via `addRawEventHandler` (raw,
 * pre-coalesce, overflow-immune). These tests use a real Informer with
 * a synthetic stream — the FakeInformer in the sibling suite delivers
 * every event and would mask this.
 *
 * Root cause found by adversarial review 2026-05-18.
 */

import { describe, expect, test } from "bun:test";
import type { AgentTaskEntity } from "../../core/agent-task.js";
import { Informer } from "../../core/informer.js";
import type { WatchClientEvent } from "../../core/watch-client.js";
import type { WatchStream } from "../../core/watch-stream.js";
import { PulseAggregator } from "./pulse-aggregator.js";

function makeFakeStream(): {
  stream: WatchStream;
  emit: (e: WatchClientEvent) => void | Promise<void>;
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
      return onEvent(e);
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

/** Stub informer for the kinds this test doesn't drive. */
function stubInformer<K extends "TimelineEvent" | "Contribution">(): Informer<K> {
  const noop = (): (() => void) => () => undefined;
  return {
    addEventHandler: noop,
    addRawEventHandler: noop,
    addSyncHandler: noop,
    hasSynced: () => false,
    getById: () => undefined,
    list: () => [],
  } as unknown as Informer<K>;
}

describe("PulseAggregator vs real Informer coalescing", () => {
  test("same-id Running→AwaitingReview burst is NOT collapsed (reviewIterations lossless)", async () => {
    const { stream, emit } = makeFakeStream();
    const taskInformer = new Informer(stream, "AgentTask");
    const ac = new AbortController();
    void taskInformer.run(ac.signal);

    let tickFn: () => void = () => undefined;
    const agg = new PulseAggregator(
      taskInformer,
      stubInformer<"TimelineEvent">(),
      stubInformer<"Contribution">(),
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

    // Synchronous same-id burst BEFORE any drain microtask. The Informer's
    // Map<id,event> queue collapses these to the final state; the normal
    // addEventHandler path would observe at most one AwaitingReview entry.
    await emit(taskEvent("ADDED", "t1", 1, "Running"));
    await emit(taskEvent("MODIFIED", "t1", 2, "AwaitingReview"));
    await emit(taskEvent("MODIFIED", "t1", 3, "Running"));
    await emit(taskEvent("MODIFIED", "t1", 4, "AwaitingReview"));

    tickFn();
    const series = agg.getSnapshot().series;
    // Two distinct entries into AwaitingReview → raw path counts both.
    expect(series.reviewIterations[series.reviewIterations.length - 1]).toBe(2);

    agg.dispose();
    ac.abort();
  });

  test("overflow clear() does not lose contrib counts (raw path immune)", async () => {
    const { stream, emit } = makeFakeStream();
    // Tiny queue so we trip overflow fast.
    const taskInformer = new Informer(stream, "AgentTask", { queueLimit: 4 });
    const ac = new AbortController();
    void taskInformer.run(ac.signal);

    let tickFn: () => void = () => undefined;
    const agg = new PulseAggregator(
      taskInformer,
      stubInformer<"TimelineEvent">(),
      stubInformer<"Contribution">(),
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

    // 50 distinct ADDED with no drain between them → the queue overflows
    // and clear()s repeatedly. Raw handlers fire per enqueue regardless.
    for (let i = 0; i < 50; i++) {
      await emit(taskEvent("ADDED", `t${i}`, i + 1, "Running"));
    }
    tickFn();
    const series = agg.getSnapshot().series;
    expect(series.spawnRate[series.spawnRate.length - 1]).toBe(50);

    agg.dispose();
    ac.abort();
  });
});
