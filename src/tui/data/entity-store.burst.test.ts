/**
 * 10k events/sec burst acceptance test (B1 #296 AC #1).
 *
 * Asserts:
 *   - lossless data: writeCounter equals total events delivered
 *   - coalesced notify: subscriber fires once per microtask drain
 *   - wall-time under a CI-friendly budget so accidental O(N²) regressions
 *     in any of list()/snapshot caching/fanout get caught
 */

import { describe, expect, test } from "bun:test";
import type { EventHandlerFn, Informer, SyncHandlerFn } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { EntityStore } from "./entity-store.js";

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

function makeFake(): {
  informer: Informer<"Contribution">;
  emit: (e: WatchEntity) => void;
} {
  const store = new Map<string, WatchEntity>();
  const handlers: EventHandlerFn<"Contribution">[] = [];
  const syncs: SyncHandlerFn[] = [];
  return {
    informer: {
      addEventHandler: (fn: EventHandlerFn<"Contribution">) => {
        handlers.push(fn);
        return () => undefined;
      },
      addSyncHandler: (fn: SyncHandlerFn) => {
        syncs.push(fn);
        return () => undefined;
      },
      hasSynced: () => true,
      getById: (id: string) => store.get(id) as never,
      list: () => Array.from(store.values()) as never,
    } as unknown as Informer<"Contribution">,
    emit: (e: WatchEntity) => {
      store.set(e.id, e);
      for (const h of handlers) h("ADDED", e as never);
    },
  };
}

describe("EntityStore — 10k/sec burst (B1 AC #1)", () => {
  test("10000 ADDED in one tight loop: lossless, single coalesced flush, <500ms", async () => {
    const fake = makeFake();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    const N = 10_000;
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1) {
      fake.emit(entity(`e${i}`));
    }
    await Promise.resolve();
    await Promise.resolve();
    const elapsed = Date.now() - t0;

    expect(store.getStats().writes).toBe(N);
    expect(calls).toBe(1);
    expect(store.getVersion()).toBe(N);
    expect(elapsed).toBeLessThan(500);
  });

  test("10000 ADDED of duplicate id: writes += 10000, list-length stays at 1", async () => {
    const fake = makeFake();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");

    for (let i = 0; i < 10_000; i += 1) {
      fake.emit(entity("same", String(i + 1)));
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getStats().writes).toBe(10_000);
    expect(store.list().length).toBe(1);
  });
});
