/**
 * EntityStore<K> unit tests (B1 #296).
 *
 * Tests use a minimal fake Informer that mirrors the public surface used
 * by EntityStore: addEventHandler, addSyncHandler, hasSynced, list, getById.
 */

import { describe, expect, test } from "bun:test";
import type { EventHandlerFn, Informer, InformerOp, SyncHandlerFn } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";

import { EntityStore } from "./entity-store.js";

function makeFakeInformer(): {
  informer: Informer<"Contribution">;
  emit: (op: InformerOp, entity: AnyEntity) => Promise<void>;
  emitWithMeta: (op: InformerOp, entity: AnyEntity, meta: { emittedAt?: string }) => Promise<void>;
  emitSync: () => void;
  setSynced: (v: boolean) => void;
  store: Map<string, AnyEntity>;
} {
  const store = new Map<string, AnyEntity>();
  const handlers: EventHandlerFn<"Contribution">[] = [];
  const syncs: SyncHandlerFn[] = [];
  let synced = false;
  const informer = {
    addEventHandler: (fn: EventHandlerFn<"Contribution">) => {
      handlers.push(fn);
      return () => {
        const i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    addSyncHandler: (fn: SyncHandlerFn) => {
      syncs.push(fn);
      return () => {
        const i = syncs.indexOf(fn);
        if (i >= 0) syncs.splice(i, 1);
      };
    },
    hasSynced: () => synced,
    getById: (id: string) => store.get(id) as never,
    list: () => Array.from(store.values()) as never,
  } as unknown as Informer<"Contribution">;
  return {
    informer,
    emit: async (op, entity) => {
      if (op === "ADDED" || op === "MODIFIED") store.set(entity.id, entity);
      if (op === "DELETED") store.delete(entity.id);
      for (const h of [...handlers]) await h(op, entity as never);
    },
    emitWithMeta: async (op, entity, meta) => {
      if (op === "ADDED" || op === "MODIFIED") store.set(entity.id, entity);
      if (op === "DELETED") store.delete(entity.id);
      for (const h of [...handlers]) await h(op, entity as never, meta);
    },
    emitSync: () => {
      for (const s of [...syncs]) s();
    },
    setSynced: (v) => {
      synced = v;
    },
    store,
  };
}

function entity(id: string, rv = "1"): WatchEntity {
  return {
    kind: "Contribution",
    namespace: "default",
    id,
    spec: {
      contributionKind: "code",
      mode: "direct",
      summary: id,
      artifacts: {},
      relations: [],
      tags: [],
    } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: rv,
    metadata: { generation: 1 },
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EntityStore — minimal shape", () => {
  test("getVersion starts at 0; getById/list reflect informer cache", () => {
    const fake = makeFakeInformer();
    fake.store.set("c1", entity("c1"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    expect(store.getVersion()).toBe(0);
    expect(store.getById("c1")?.id).toBe("c1");
    expect(store.list().length).toBe(1);
  });

  test("hasSynced delegates to informer", () => {
    const fake = makeFakeInformer();
    fake.setSynced(false);
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    expect(store.hasSynced()).toBe(false);
    fake.setSynced(true);
    expect(store.hasSynced()).toBe(true);
  });

  test("subscribe returns an unsubscribe function", () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const unsub = store.subscribe(() => {
      // intentionally empty
    });
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("an event after subscribe bumps version", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    await fake.emit("ADDED", entity("c1"));
    await drainMicrotasks();
    expect(calls).toBe(1);
    expect(store.getVersion()).toBe(1);
  });
});

describe("EntityStore — microtask coalescing", () => {
  test("N writes in one microtask → version bumps N, subscribers fire ONCE", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    // Synchronously emit 3 events without yielding.
    const promises = [
      fake.emit("ADDED", entity("a")),
      fake.emit("ADDED", entity("b")),
      fake.emit("ADDED", entity("c")),
    ];
    await Promise.all(promises);
    await drainMicrotasks();

    expect(store.getVersion()).toBe(3);
    expect(calls).toBe(1);
  });

  test("N writes across N awaited microtasks → subscribers fire N times", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    await fake.emit("ADDED", entity("a"));
    await drainMicrotasks();
    await fake.emit("ADDED", entity("b"));
    await drainMicrotasks();
    await fake.emit("ADDED", entity("c"));
    await drainMicrotasks();

    expect(calls).toBe(3);
  });
});

type AnyEntity = WatchEntity & Record<string, unknown>;

describe("EntityStore — snapshot stability", () => {
  test("list() returns the same ref while version is unchanged", () => {
    const fake = makeFakeInformer();
    fake.store.set("a", entity("a"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");

    const a = store.list();
    const b = store.list();
    expect(a).toBe(b);
  });

  test("list() returns a NEW ref after a version bump", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const before = store.list();
    await fake.emit("ADDED", entity("a"));
    await drainMicrotasks();
    const after = store.list();
    expect(after).not.toBe(before);
    expect(after.length).toBe(1);
  });

  test("list() ref is frozen — push() throws", () => {
    const fake = makeFakeInformer();
    fake.store.set("a", entity("a"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const arr = store.list();
    expect(() => (arr as unknown as AnyEntity[]).push(entity("b"))).toThrow();
  });
});

describe("EntityStore — getStats / writeCounter", () => {
  test("writeCounter increments per applied informer event; sync does not bump it", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");

    expect(store.getStats().writes).toBe(0);

    await fake.emit("ADDED", entity("a"));
    await fake.emit("MODIFIED", entity("a", "2"));
    await fake.emit("DELETED", entity("a", "2"));
    await drainMicrotasks();

    expect(store.getStats().writes).toBe(3);

    fake.emitSync(); // sync without per-row events
    await drainMicrotasks();
    expect(store.getStats().writes).toBe(3);
  });

  test("getStats().version matches getVersion()", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    await fake.emit("ADDED", entity("a"));
    await drainMicrotasks();
    expect(store.getStats().version).toBe(store.getVersion());
  });
});

describe("EntityStore — lag ring", () => {
  test("pushes a positive sample when emittedAt is well-formed", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const past = new Date(Date.now() - 50).toISOString();
    await fake.emitWithMeta("ADDED", entity("a"), { emittedAt: past });
    await drainMicrotasks();
    const samples = store.getStats().lagSamples;
    expect(samples.length).toBe(1);
    expect(samples[0]).toBeGreaterThanOrEqual(50);
    expect(samples[0]).toBeLessThan(5000);
  });

  test("skips sample when emittedAt is missing", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    await fake.emit("ADDED", entity("a"));
    await drainMicrotasks();
    expect(store.getStats().lagSamples.length).toBe(0);
  });

  test("skips sample when emittedAt is unparseable", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    await fake.emitWithMeta("ADDED", entity("a"), { emittedAt: "not-a-date" });
    await drainMicrotasks();
    expect(store.getStats().lagSamples.length).toBe(0);
  });

  test("ring buffer caps at 1024 (drop-oldest)", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    for (let i = 0; i < 1100; i += 1) {
      await fake.emitWithMeta("ADDED", entity(`e${i}`), { emittedAt: new Date().toISOString() });
    }
    await drainMicrotasks();
    expect(store.getStats().lagSamples.length).toBe(1024);
  });
});
