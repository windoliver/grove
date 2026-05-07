/**
 * EntityStore<K> unit tests (B1 #296).
 *
 * Tests use a minimal fake Informer that mirrors the public surface used
 * by EntityStore: addEventHandler, addSyncHandler, hasSynced, list, getById.
 */

import { describe, expect, test } from "bun:test";
import type { EventHandlerFn, Informer, InformerOp, SyncHandlerFn } from "../../core/informer.js";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";

import { EntityStore, EntityStoreFactory } from "./entity-store.js";

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
    getQueueStats: () => ({ depth: 0, limit: 1000, overflows: 0 }),
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

type AnyEntity = WatchEntity;

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

describe("EntityStore — overflow + queueDepth propagation (B2)", () => {
  test("getStats() reflects informer.getQueueStats()", () => {
    const fake = makeFakeInformer();
    // Override getQueueStats with a controllable stub.
    let depth = 0;
    let overflows = 0;
    (fake.informer as unknown as { getQueueStats: () => unknown }).getQueueStats = () => ({
      depth,
      limit: 42,
      overflows,
    });
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");

    expect(store.getStats().queueDepth).toBe(0);
    expect(store.getStats().queueLimit).toBe(42);
    expect(store.getStats().overflows).toBe(0);

    depth = 7;
    overflows = 3;
    expect(store.getStats().queueDepth).toBe(7);
    expect(store.getStats().overflows).toBe(3);
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

describe("EntityStore — edge cases", () => {
  test("subscriber that calls its own unsubscribe inside flush does not skip the next subscriber", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    let secondCalled = false;
    let unsubFirst!: () => void;
    unsubFirst = store.subscribe(() => {
      unsubFirst();
    });
    store.subscribe(() => {
      secondCalled = true;
    });
    await fake.emit("ADDED", entity("a"));
    await drainMicrotasks();
    expect(secondCalled).toBe(true);
  });

  test("subscriber that throws is isolated; remaining subscribers still fire", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    let secondCalled = false;
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe(() => {
      secondCalled = true;
    });
    await fake.emit("ADDED", entity("a"));
    await drainMicrotasks();
    expect(secondCalled).toBe(true);
  });

  test("dispose() unsubscribes from informer and clears subscribers", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.dispose();
    await fake.emit("ADDED", entity("a"));
    await drainMicrotasks();
    expect(calls).toBe(0);
    expect(store.getVersion()).toBe(0);
  });

  test("DELETE then ADD same id within one microtask: final state correct, writes += 2", async () => {
    const fake = makeFakeInformer();
    fake.store.set("a", entity("a", "1"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    await Promise.all([
      fake.emit("DELETED", entity("a", "1")),
      fake.emit("ADDED", entity("a", "2")),
    ]);
    await drainMicrotasks();
    expect(store.getStats().writes).toBe(2);
    expect(store.getById("a")?.resourceVersion).toBe("2");
  });

  test("getById sees post-write state from inside an Informer event handler", async () => {
    // The Informer commits the data write synchronously before fanning out
    // events (see #294 contract). This means a sibling event handler sees
    // the post-write state via getById without waiting for the flush
    // microtask. We don't assert ordering between EntityStore subscribers
    // and sibling handlers — that depends on microtask scheduling around
    // the `await` between iterations of the fanout loop.
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    let inFanoutResult: WatchEntity | undefined;
    fake.informer.addEventHandler(() => {
      inFanoutResult = store.getById("a");
    });
    await fake.emit("ADDED", entity("a"));
    expect(inFanoutResult?.id).toBe("a");
  });
});

describe("EntityStoreFactory", () => {
  function makeInformerFactory(): InformerFactory {
    return new InformerFactory({
      mode: "local",
      hub: new WatchHub(),
      namespace: "default",
      listFn: () => [],
    });
  }

  test("storeFor returns a stable EntityStore per kind (memoized)", () => {
    const factory = new EntityStoreFactory(makeInformerFactory());
    const a = factory.storeFor("Contribution");
    const b = factory.storeFor("Contribution");
    expect(a).toBe(b);
  });

  test("mode and supportsKind delegate to the underlying InformerFactory", () => {
    const informerFactory = makeInformerFactory();
    const factory = new EntityStoreFactory(informerFactory);
    expect(factory.mode).toBe(informerFactory.mode);
    expect(factory.supportsKind("Contribution")).toBe(true);
  });

  test("getAllStats returns stats for every constructed store", () => {
    const factory = new EntityStoreFactory(makeInformerFactory());
    factory.storeFor("Contribution");
    factory.storeFor("Claim");
    const all = factory.getAllStats();
    expect(Object.keys(all)).toContain("Contribution");
    expect(Object.keys(all)).toContain("Claim");
    expect(all.Contribution?.writes).toBe(0);
  });

  test("getAllStats rolls up overflows + queueDepth from each kind's informer", () => {
    const factory = new EntityStoreFactory(makeInformerFactory());
    const cStore = factory.storeFor("Contribution");
    const claimStore = factory.storeFor("Claim");

    // Override getQueueStats on each store's underlying informer with controllable stubs.
    (cStore as unknown as { informer: { getQueueStats: () => unknown } }).informer.getQueueStats =
      () => ({ depth: 7, limit: 1000, overflows: 2 });
    (
      claimStore as unknown as { informer: { getQueueStats: () => unknown } }
    ).informer.getQueueStats = () => ({ depth: 3, limit: 500, overflows: 5 });

    const all = factory.getAllStats();
    expect(all.Contribution?.overflows).toBe(2);
    expect(all.Contribution?.queueDepth).toBe(7);
    expect(all.Contribution?.queueLimit).toBe(1000);
    expect(all.Claim?.overflows).toBe(5);
    expect(all.Claim?.queueDepth).toBe(3);
    expect(all.Claim?.queueLimit).toBe(500);
  });

  test("dispose disposes every store; idempotent", () => {
    const factory = new EntityStoreFactory(makeInformerFactory());
    factory.storeFor("Contribution");
    factory.dispose();
    factory.dispose(); // no throw
  });
});
