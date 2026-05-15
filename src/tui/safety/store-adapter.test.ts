/**
 * Unit tests for the EntityStore → ConfirmAndMutateEntityBus adapter (C6 #304, T11).
 */

import { describe, expect, test } from "bun:test";
import type { EntityForKind } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import type { EntityStore, EntityStoreFactory } from "../data/entity-store.js";
import { makeEntityBusFromStore } from "./store-adapter.js";

// ---------------------------------------------------------------------------
// Minimal fake store / factory — mirrors the surface the adapter actually
// uses (getById, subscribe, supportsKind, storeFor). Avoids spinning up a
// full Informer for a focused adapter test.
// ---------------------------------------------------------------------------

class FakeStore<K extends WatchKind> {
  private readonly byId = new Map<string, EntityForKind<K>>();
  private readonly listeners = new Set<() => void>();

  set(id: string, entity: EntityForKind<K>): void {
    this.byId.set(id, entity);
    for (const fn of [...this.listeners]) fn();
  }

  delete(id: string): void {
    this.byId.delete(id);
    for (const fn of [...this.listeners]) fn();
  }

  getById(id: string): EntityForKind<K> | undefined {
    return this.byId.get(id);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

class FakeFactory {
  private readonly supported: ReadonlySet<WatchKind>;
  private readonly stores = new Map<WatchKind, FakeStore<WatchKind>>();

  constructor(supported: readonly WatchKind[] = ["AgentSession", "Claim", "Contribution"]) {
    this.supported = new Set(supported);
    for (const k of supported) this.stores.set(k, new FakeStore());
  }

  supportsKind(kind: WatchKind): boolean {
    return this.supported.has(kind);
  }

  storeFor<K extends WatchKind>(kind: K): EntityStore<K> {
    const store = this.stores.get(kind);
    if (!store) throw new Error(`No fake store for ${kind}`);
    return store as unknown as EntityStore<K>;
  }

  rawStore<K extends WatchKind>(kind: K): FakeStore<K> {
    return this.stores.get(kind) as unknown as FakeStore<K>;
  }
}

function makeSession(id: string, rv: string): EntityForKind<"AgentSession"> {
  return {
    kind: "AgentSession",
    namespace: "ns",
    id,
    resourceVersion: rv,
    spec: { role: "reviewer" } as never,
    status: { phase: "idle" } as never,
    conditions: [],
    observedGeneration: 0,
    metadata: { generation: 1 },
  } as unknown as EntityForKind<"AgentSession">;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeEntityBusFromStore", () => {
  test("get(kind, id) returns the current entity from the kind's store", () => {
    const factory = new FakeFactory();
    factory.rawStore("AgentSession").set("sess-1", makeSession("sess-1", "5"));
    const bus = makeEntityBusFromStore(factory as unknown as EntityStoreFactory);

    expect(bus.get("AgentSession", "sess-1")?.resourceVersion).toBe("5");
    expect(bus.get("AgentSession", "sess-missing")).toBeUndefined();
  });

  test("get returns undefined when the kind is unsupported (no throw)", () => {
    const factory = new FakeFactory(["Contribution"]);
    const bus = makeEntityBusFromStore(factory as unknown as EntityStoreFactory);
    expect(bus.get("AgentSession", "x")).toBeUndefined();
  });

  test("subscribe fires only when the watched id's RV moves", () => {
    const factory = new FakeFactory();
    factory.rawStore("AgentSession").set("sess-1", makeSession("sess-1", "5"));
    factory.rawStore("AgentSession").set("sess-2", makeSession("sess-2", "5"));
    const bus = makeEntityBusFromStore(factory as unknown as EntityStoreFactory);

    const seen: Array<{ id: string; rv: string }> = [];
    const unsub = bus.subscribe("AgentSession", "sess-1", (e) => {
      if (e) seen.push({ id: e.id, rv: e.resourceVersion });
    });

    // Same id, new RV → fire.
    factory.rawStore("AgentSession").set("sess-1", makeSession("sess-1", "6"));
    expect(seen).toEqual([{ id: "sess-1", rv: "6" }]);

    // Other id changing → does NOT fire for sess-1.
    factory.rawStore("AgentSession").set("sess-2", makeSession("sess-2", "9"));
    expect(seen).toEqual([{ id: "sess-1", rv: "6" }]);

    // Same id, same RV → still does not fire (no movement).
    factory.rawStore("AgentSession").set("sess-1", makeSession("sess-1", "6"));
    expect(seen).toEqual([{ id: "sess-1", rv: "6" }]);

    // Same id, bumped RV → fire.
    factory.rawStore("AgentSession").set("sess-1", makeSession("sess-1", "7"));
    expect(seen).toEqual([
      { id: "sess-1", rv: "6" },
      { id: "sess-1", rv: "7" },
    ]);

    unsub();
  });

  test("subscribe returns a no-op unsubscribe for unsupported kinds", () => {
    const factory = new FakeFactory(["Contribution"]);
    const bus = makeEntityBusFromStore(factory as unknown as EntityStoreFactory);
    const unsub = bus.subscribe("AgentSession", "sess-1", () => {
      throw new Error("should not fire");
    });
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("unsubscribe stops further callbacks", () => {
    const factory = new FakeFactory();
    factory.rawStore("AgentSession").set("sess-1", makeSession("sess-1", "5"));
    const bus = makeEntityBusFromStore(factory as unknown as EntityStoreFactory);

    let calls = 0;
    const unsub = bus.subscribe("AgentSession", "sess-1", () => {
      calls += 1;
    });
    factory.rawStore("AgentSession").set("sess-1", makeSession("sess-1", "6"));
    expect(calls).toBe(1);

    unsub();
    factory.rawStore("AgentSession").set("sess-1", makeSession("sess-1", "7"));
    expect(calls).toBe(1);
  });
});
