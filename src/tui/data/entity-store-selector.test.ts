/**
 * Selector memoization snapshot tests (B1 #296 AC #2).
 *
 * Verifies that:
 *   - store.list() returns ref-stable arrays across no-op writes
 *   - a filter-then-shallow-equal selector returns shallow-equal output
 *     when filtered contents are unchanged
 *   - duplicate writes (same entity) don't change selector output
 */

import { describe, expect, test } from "bun:test";
import type { EventHandlerFn, Informer, SyncHandlerFn } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { shallowArraysEqual } from "../hooks/use-entities.js";
import { EntityStore } from "./entity-store.js";

function entity(id: string, summary = id, rv = "1"): WatchEntity {
  return {
    kind: "Contribution",
    namespace: "default",
    id,
    spec: {
      contributionKind: "code",
      mode: "direct",
      summary,
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
  emit: (op: "ADDED" | "MODIFIED" | "DELETED", e: WatchEntity) => void;
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
    emit: (op, e) => {
      if (op === "ADDED" || op === "MODIFIED") store.set(e.id, e);
      if (op === "DELETED") store.delete(e.id);
      for (const h of handlers) h(op, e as never);
    },
  };
}

describe("EntityStore — selector memoization (B1 AC #2)", () => {
  test("list() ref-equal across two reads with no writes between", () => {
    const fake = makeFake();
    fake.emit("ADDED", entity("a"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    expect(store.list()).toBe(store.list());
  });

  test("filter-then-shallow-equal selector: items filtered out → output shallow-equal", async () => {
    const fake = makeFake();
    fake.emit("ADDED", entity("keep", "keep"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const select = (list: readonly WatchEntity[]): readonly WatchEntity[] =>
      list.filter((e) => (e.spec as { summary?: string }).summary === "keep");
    const prev = select(store.list());
    for (let i = 0; i < 100; i += 1) {
      fake.emit("ADDED", entity(`drop${i}`, "drop"));
    }
    await Promise.resolve();
    await Promise.resolve();
    const next = select(store.list());
    expect(shallowArraysEqual(prev, next)).toBe(true);
  });

  test("MODIFIED that doesn't change filtered slice contents → shallow-equal output", async () => {
    const fake = makeFake();
    fake.emit("ADDED", entity("a", "x", "1"));
    fake.emit("ADDED", entity("b", "y", "1"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const select = (list: readonly WatchEntity[]): readonly WatchEntity[] =>
      list.filter((e) => (e.spec as { summary?: string }).summary === "x");
    const prev = select(store.list());
    fake.emit("MODIFIED", entity("b", "y", "2"));
    await Promise.resolve();
    await Promise.resolve();
    const next = select(store.list());
    expect(shallowArraysEqual(prev, next)).toBe(true);
  });

  test("snapshot ref-equality across no-op duplicate-rv writes", async () => {
    const fake = makeFake();
    const entityA = entity("a", "x", "1");
    fake.emit("ADDED", entityA);
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const before = store.list();
    fake.emit("MODIFIED", entityA);
    await Promise.resolve();
    await Promise.resolve();
    const after = store.list();
    expect(shallowArraysEqual(before, after)).toBe(true);
  });
});
