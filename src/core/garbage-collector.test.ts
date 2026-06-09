import { describe, expect, test } from "bun:test";
import { GarbageCollector } from "./garbage-collector.js";
import { InMemoryGcStore } from "./in-memory-gc-store.js";
import { KindFinalizer, PropagationFinalizer } from "./lifecycle-metadata.js";
import type { GcRef } from "./owner-graph.js";

const TG: GcRef = { kind: "taskGroup", id: "tg" };
const A: GcRef = { kind: "agentTask", id: "a" };
const B: GcRef = { kind: "agentTask", id: "b" };

function controlledByTg(id: string) {
  return [{ kind: "taskGroup" as const, id: "tg", uid: "u-tg", controller: true }];
}

/** Drive the loop to convergence: drain the queue by reconciling until empty. */
async function drain(gc: GarbageCollector, store: InMemoryGcStore, refs: GcRef[]): Promise<void> {
  // Deterministic manual pump: repeatedly reconcile every still-present ref
  // plus all pending-deletion nodes until a full pass produces no changes.
  for (let pass = 0; pass < 50; pass += 1) {
    const pending = await store.listPendingDeletion();
    const toVisit = new Map<string, GcRef>();
    for (const r of refs) toVisit.set(`${r.kind}:${r.id}`, r);
    for (const n of pending) toVisit.set(`${n.kind}:${n.id}`, { kind: n.kind, id: n.id });
    for (const ref of toVisit.values()) await gc.reconcileNode(ref);
  }
}

describe("cascade: delete TaskGroup", () => {
  test("Foreground — children marked then reaped, then owner reaped", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [PropagationFinalizer.Foreground],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    store.put({ kind: "agentTask", id: "a", uid: "u-a", ownerRefs: controlledByTg("a"), finalizers: [] });
    store.put({ kind: "agentTask", id: "b", uid: "u-b", ownerRefs: controlledByTg("b"), finalizers: [] });

    const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await drain(gc, store, [TG, A, B]);

    expect(store.has(A)).toBe(false);
    expect(store.has(B)).toBe(false);
    expect(store.has(TG)).toBe(false);
  });

  test("Background — owner reaped, children GC'd", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    store.put({ kind: "agentTask", id: "a", uid: "u-a", ownerRefs: controlledByTg("a"), finalizers: [] });

    const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await drain(gc, store, [TG, A]);

    expect(store.has(TG)).toBe(false);
    expect(store.has(A)).toBe(false);
  });

  test("Orphan — children preserved, controller ownerRef stripped, owner reaped", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [PropagationFinalizer.Orphan],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    store.put({ kind: "agentTask", id: "a", uid: "u-a", ownerRefs: controlledByTg("a"), finalizers: [] });

    const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await drain(gc, store, [TG, A]);

    expect(store.has(TG)).toBe(false);
    expect(store.has(A)).toBe(true);
    const a = await store.getNode(A);
    expect(a?.ownerRefs).toEqual([]); // controller ref stripped, child orphaned
    expect(a?.deletionTimestamp).toBeUndefined(); // NOT marked for deletion
  });
});

describe("finalizer blocks reap", () => {
  test("AgentTask with pending-review is not reaped until the finalizer is removed", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "agentTask",
      id: "a",
      uid: "u-a",
      ownerRefs: [],
      finalizers: [KindFinalizer.PendingReview],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });

    const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await drain(gc, store, [A]);
    expect(store.has(A)).toBe(true); // blocked

    // Reviewer clears the finalizer.
    await store.removeFinalizer(A, KindFinalizer.PendingReview);
    await drain(gc, store, [A]);
    expect(store.has(A)).toBe(false); // now reaped
  });
});

describe("crash recovery", () => {
  test("partial cascade converges on a fresh reconcile pass", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [PropagationFinalizer.Foreground],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    store.put({ kind: "agentTask", id: "a", uid: "u-a", ownerRefs: controlledByTg("a"), finalizers: [] });

    // Simulate a crash after only marking the child: do ONE reconcile of TG.
    const gc1 = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await gc1.reconcileNode(TG);
    expect((await store.getNode(A))?.deletionTimestamp).toBeDefined();
    expect(store.has(TG)).toBe(true); // not yet reaped

    // Fresh collector resumes and finishes.
    const gc2 = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:06.000Z") });
    await drain(gc2, store, [TG, A]);
    expect(store.has(A)).toBe(false);
    expect(store.has(TG)).toBe(false);
  });
});

describe("resync enqueues pending + children", () => {
  test("resync returns the count of pending-deletion owners", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    const gc = new GarbageCollector({ store });
    expect(await gc.resync()).toBe(1);
  });
});
