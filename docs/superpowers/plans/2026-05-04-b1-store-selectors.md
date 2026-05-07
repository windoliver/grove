# B1 — Central Store with Selector Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `EntityStore<K>` reactive layer between `Informer<K>` (#294) and the existing TUI hooks (`useEntities`, `useEntity`, `useDerived`). Lossless data writes, microtask-coalesced render notifications, version-stable snapshots, per-kind `grove_store_sse_lag` ring buffer.

**Architecture:** New `EntityStore<K>` class wraps an `Informer<K>` and adds a microtask-coalesced subscriber set, a monotonic version counter, a write counter, a snapshot ref-cache, and a 1024-entry lag ring. `EntityStoreFactory` mirrors `InformerFactory` 1:1. The wire format adds an optional `emittedAt: string` to `WatchEvent` so the client can compute server-emit→client-apply lag. The three existing hooks are migrated under-the-hood from `informer.addEventHandler` → `entityStore.subscribe` (via `useSyncExternalStore`); their public signatures are unchanged.

**Tech Stack:** TypeScript, React 19 (`useSyncExternalStore`), Bun (`bun:test`), `react-test-renderer` for mount tests, Hono SSE for the server-side stamp.

**Spec:** `docs/superpowers/specs/2026-05-04-b1-store-selectors-design.md`

---

## File Inventory

### Created
- `src/tui/data/entity-store.ts` — `EntityStore<K>` and `EntityStoreFactory` classes.
- `src/tui/data/entity-store.test.ts` — unit tests for core EntityStore behavior.
- `src/tui/data/entity-store.burst.test.ts` — 10k/sec burst acceptance test.
- `src/tui/data/entity-store-selector.test.ts` — selector memoization snapshot tests.
- `src/tui/hooks/entity-store-context.tsx` — `EntityStoreProvider`, `EntityStoreProviderHolder`, `useEntityStoreOptional`, `useEntityStoreFactoryOptional`, null stub.
- `src/tui/hooks/entity-store-context.test.tsx` — provider mount + null-stub tests.
- `src/tui/hooks/use-entities.store-backed.test.tsx` — hook migration smoke (mount-level).
- `tests/e2e/watch-emitted-at.test.ts` — SSE wire-format E2E for the new `emittedAt` field.

### Modified
- `src/core/watch-events.ts` — add optional `emittedAt?: string` to `WatchEvent`.
- `src/core/watch-client.ts` — add optional `emittedAt?: string` to `WatchClientEvent`; read from SSE frame data.
- `src/core/local-watch-client.ts` — stamp `emittedAt` at the live-delta `onEvent` call site.
- `src/server/routes/watch.ts` — stamp `emittedAt = new Date().toISOString()` on each non-envelope SSE frame.
- `src/tui/hooks/use-entities.ts` — subscribe via `EntityStore` instead of `Informer.addEventHandler` + `addSyncHandler`.
- `src/tui/hooks/use-entity.ts` — same migration.
- `src/tui/hooks/use-derived.ts` — same migration.
- `src/tui/tui-app.tsx` — construct `EntityStoreFactory` alongside `InformerFactory`; wrap tree with `EntityStoreProvider`.

### Deleted
- None. (The migration is internal-only; no public API breaks.)

---

## Task 1: Add `emittedAt` field to wire types

**Files:**
- Modify: `src/core/watch-events.ts`
- Modify: `src/core/watch-client.ts`

- [ ] **Step 1: Add `emittedAt?: string` to `WatchEvent`**

In `src/core/watch-events.ts`, replace the `WatchEvent` interface (currently lines 18–24):

```ts
/** A watch-stream event emitted by the hub to subscribers. */
export interface WatchEvent {
  readonly rv: bigint;
  readonly op: WatchOp;
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly entity: WatchEntity;
  /**
   * Server-stamped ISO-8601 wall-clock timestamp of when this event was
   * serialized for delivery (SSE frame-write boundary in remote mode, or
   * hub fan-out in local mode). Optional for backward compat with frames
   * produced before B1 (#296). Consumers compute `grove_store_sse_lag`
   * as `Date.now() - Date.parse(emittedAt)` when present.
   */
  readonly emittedAt?: string;
}
```

- [ ] **Step 2: Add `emittedAt?: string` to `WatchClientEvent`**

In `src/core/watch-client.ts`, replace the `WatchClientEvent` interface (currently lines 36–41):

```ts
export interface WatchClientEvent {
  readonly op: WatchClientOp;
  readonly rv: bigint;
  readonly kind: WatchKind;
  readonly entity: WatchEntity | null;
  /** Server-stamped ISO-8601 wall-clock; see `WatchEvent.emittedAt`. */
  readonly emittedAt?: string;
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — additive optional fields don't break any existing call site.

- [ ] **Step 4: Commit**

```bash
git add src/core/watch-events.ts src/core/watch-client.ts
git commit -m "feat(core): add optional emittedAt to WatchEvent + WatchClientEvent (B1 #296)"
```

---

## Task 2: Server stamps `emittedAt` on each live-delta SSE frame

**Files:**
- Modify: `src/server/routes/watch.ts:279`

- [ ] **Step 1: Write the failing E2E test**

Create `tests/e2e/watch-emitted-at.test.ts`:

```ts
/**
 * E2E: server stamps emittedAt on live-delta SSE frames; client parses it.
 */

import { describe, expect, test } from "bun:test";
import { WatchClient, type WatchClientEvent } from "../../src/core/watch-client.js";
import { buildTestApp } from "../../src/server/test-helpers.js";

describe("/api/watch emittedAt", () => {
  test("server stamps emittedAt on each live-delta frame; finite parse", async () => {
    const harness = await buildTestApp();
    try {
      // Subscribe.
      const client = new WatchClient({
        baseUrl: harness.baseUrl,
        kind: "Contribution",
        authHeader: harness.authHeader,
        fetch: harness.fetch,
      });
      const seen: WatchClientEvent[] = [];
      const ac = new AbortController();
      const run = client.run({
        onEvent: (e) => {
          seen.push(e);
          if (seen.some((x) => x.op === "ADDED")) ac.abort();
        },
        signal: ac.signal,
      });

      // Drive a real write through the harness (replace with the harness's
      // canonical contribute helper — buildTestApp returns a `contribute`
      // method when wired by test-helpers.ts).
      await harness.contribute({ summary: "hello" });

      try { await run; } catch { /* aborted */ }

      const added = seen.find((e) => e.op === "ADDED");
      expect(added).toBeDefined();
      expect(added?.emittedAt).toBeDefined();
      const ts = Date.parse(added?.emittedAt ?? "");
      expect(Number.isFinite(ts)).toBe(true);
      expect(Math.abs(Date.now() - ts)).toBeLessThan(5000);
    } finally {
      await harness.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/e2e/watch-emitted-at.test.ts`
Expected: FAIL — `added?.emittedAt` is `undefined` (server doesn't stamp it yet).

- [ ] **Step 3: Stamp `emittedAt` in the watch route**

In `src/server/routes/watch.ts`, replace line 279:

```ts
              const sent = send(ev.op, { rv, kind: ev.kind, entity: ev.entity }, rv);
```

with:

```ts
              const sent = send(
                ev.op,
                { rv, kind: ev.kind, entity: ev.entity, emittedAt: new Date().toISOString() },
                rv,
              );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/e2e/watch-emitted-at.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/watch-emitted-at.test.ts src/server/routes/watch.ts
git commit -m "feat(server): stamp emittedAt on /api/watch SSE frames (B1 #296)"
```

> **Note for the implementer:** if `buildTestApp` does not yet expose a `contribute` helper or an equivalent way to drive a write end-to-end, look at `src/server/test-helpers.ts` and the existing `src/server/watch.integration.test.ts` to copy whatever pattern is already in use. The exact API does not matter — what matters is that one real `ADDED` event flows through the live-delta path of `/api/watch` so the SSE serializer is exercised.

---

## Task 3: Client `WatchClient` reads `emittedAt` from SSE frame data

**Files:**
- Modify: `src/core/watch-client.ts:309-314`

- [ ] **Step 1: Write the failing test**

Append to `src/core/watch-client.test.ts` (in an existing `describe` or a new one):

```ts
test("propagates emittedAt from SSE frame data into WatchClientEvent", async () => {
  const isoNow = new Date().toISOString();
  const sseBody =
    `id: 1\nevent: ADDED\n` +
    `data: ${JSON.stringify({
      rv: "1",
      kind: "Contribution",
      entity: { id: "c1", kind: "Contribution", namespace: "default", spec: {}, status: {}, conditions: [], observedGeneration: 0, resourceVersion: "1", metadata: { generation: 1 } },
      emittedAt: isoNow,
    })}\n\n`;

  const seen: WatchClientEvent[] = [];
  const ac = new AbortController();

  const fetchStub = (() => {
    let listCalls = 0;
    return async (url: string) => {
      if (url.includes("/api/list")) {
        listCalls += 1;
        return new Response(
          JSON.stringify({ items: [], listResourceVersion: "0" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Single-frame stream then end (causes a fast resume — abort right after).
      return new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
  })();

  const client = new WatchClient({
    baseUrl: "http://test",
    kind: "Contribution",
    authHeader: "Bearer test",
    fetch: fetchStub as typeof fetch,
  });

  void client.run({
    onEvent: (e) => {
      seen.push(e);
      ac.abort();
    },
    signal: ac.signal,
  }).catch(() => {});

  // Drain microtasks/network until we've seen the event or the abort fires.
  for (let i = 0; i < 50 && seen.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }

  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0].emittedAt).toBe(isoNow);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/watch-client.test.ts`
Expected: FAIL — `seen[0].emittedAt` is `undefined`.

- [ ] **Step 3: Read `emittedAt` from frame.data and propagate**

In `src/core/watch-client.ts`, replace the data-frame block (currently lines 272–314) so the `await onEvent({...})` call passes `emittedAt`. The minimal diff: change the `payload` cast to include the optional field, then add it to the event:

```ts
          if (isDataOp(frame.event)) {
            const payload = frame.data as {
              rv?: string;
              entity?: WatchEntity;
              emittedAt?: string;
            };
            if (!payload.rv || !/^[0-9]+$/.test(payload.rv) || !payload.entity) {
              console.warn(`watch: malformed ${frame.event} frame → forcing relist`);
              return { kind: "relist" };
            }
            const rv = BigInt(payload.rv);
            const entity = payload.entity;
            const seenRv = this.snapshotWindow.get(entity.id);
            if (seenRv !== undefined && frame.event !== "DELETED") {
              if (isStaleVersion(entity.resourceVersion, seenRv)) {
                lastRv = rv;
                observedData = true;
                idx = buf.indexOf("\n\n");
                continue;
              }
              this.snapshotWindow.delete(entity.id);
            } else if (seenRv !== undefined) {
              this.snapshotWindow.delete(entity.id);
            }
            lastRv = rv;
            observedData = true;
            await onEvent({
              op: frame.event as WatchClientOp,
              rv,
              kind: this.kind,
              entity,
              ...(payload.emittedAt !== undefined ? { emittedAt: payload.emittedAt } : {}),
            });
          } else if (frame.event === "BOOKMARK") {
```

(Only the `payload` cast and the spread on `onEvent` change. The rest of the block is reproduced verbatim so a subagent reading this task in isolation can apply the diff confidently.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/watch-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-client.ts src/core/watch-client.test.ts
git commit -m "feat(core): WatchClient propagates emittedAt from SSE frame (B1 #296)"
```

---

## Task 4: `LocalWatchClient` stamps `emittedAt` at live-delta fan-out

**Files:**
- Modify: `src/core/local-watch-client.ts:166-171`

- [ ] **Step 1: Write the failing test**

Append to `src/core/local-watch-client.test.ts` (or create the file if it doesn't exist — match the bun:test pattern of `src/core/informer.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { LocalWatchClient } from "./local-watch-client.js";
import type { WatchClientEvent } from "./watch-client.js";
import type { WatchEntity } from "./watch-events.js";
import { WatchHub } from "./watch-hub.js";

describe("LocalWatchClient emittedAt stamping", () => {
  test("stamps emittedAt on live-delta events; finite parse, near-zero lag", async () => {
    const hub = new WatchHub({ maxAgeMs: 60_000, maxEvents: 1024, bookmarkIntervalMs: 30_000 });
    const ns = "default";
    const entityA: WatchEntity = {
      kind: "Contribution",
      namespace: ns,
      id: "c1",
      spec: { contributionKind: "code", mode: "direct", summary: "x", artifacts: {}, relations: [], tags: [] } as never,
      status: {},
      conditions: [],
      observedGeneration: 0,
      resourceVersion: "1",
      metadata: { generation: 1 },
    };

    const seen: WatchClientEvent[] = [];
    const ac = new AbortController();

    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: ns,
      listFn: () => [],
    });

    void client.run({
      onEvent: async (e) => {
        seen.push(e);
        if (e.op === "ADDED") ac.abort();
      },
      signal: ac.signal,
    }).catch(() => {});

    // Wait for RELIST_END so the live-delta path is active.
    for (let i = 0; i < 50; i += 1) {
      if (seen.some((e) => e.op === "RELIST_END")) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    hub.recordWrite({ kind: "Contribution", namespace: ns, op: "ADDED", entity: entityA });

    for (let i = 0; i < 50 && !seen.some((e) => e.op === "ADDED"); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const added = seen.find((e) => e.op === "ADDED");
    expect(added).toBeDefined();
    expect(added?.emittedAt).toBeDefined();
    const lag = Date.now() - Date.parse(added?.emittedAt ?? "");
    expect(Number.isFinite(lag)).toBe(true);
    expect(lag).toBeLessThan(1000);

    // RELIST envelope events do NOT carry emittedAt (no entity / no semantics).
    const relistBegin = seen.find((e) => e.op === "RELIST_BEGIN");
    expect(relistBegin?.emittedAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/local-watch-client.test.ts`
Expected: FAIL — `added?.emittedAt` is `undefined`.

- [ ] **Step 3: Stamp `emittedAt` at live-delta fan-out**

In `src/core/local-watch-client.ts`, replace the live-delta `onEvent` call (currently lines 166–171):

```ts
        // Re-emit as WatchClientEvent — namespace is dropped (implicit in the subscription).
        await onEvent({
          op: event.op,
          rv: event.rv,
          kind: event.kind,
          entity: event.entity,
        });
```

with:

```ts
        // Re-emit as WatchClientEvent — namespace is dropped (implicit in the subscription).
        // Stamp emittedAt at the fan-out boundary so it reflects when this
        // process delivered the event to its subscriber, matching the
        // server-side semantics in remote mode (B1 #296).
        await onEvent({
          op: event.op,
          rv: event.rv,
          kind: event.kind,
          entity: event.entity,
          emittedAt: new Date().toISOString(),
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/local-watch-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/local-watch-client.ts src/core/local-watch-client.test.ts
git commit -m "feat(core): LocalWatchClient stamps emittedAt at fan-out (B1 #296)"
```

---

## Task 5: New module — `EntityStore<K>` minimal shape

**Files:**
- Create: `src/tui/data/entity-store.ts`
- Create: `src/tui/data/entity-store.test.ts`

This task lands the smallest viable `EntityStore`: subscribe to an Informer, expose `subscribe / getVersion / list / getById / hasSynced`, no coalescing yet, no stats.

- [ ] **Step 1: Write the failing test**

Create `src/tui/data/entity-store.test.ts`:

```ts
/**
 * EntityStore<K> unit tests (B1 #296).
 *
 * Tests use a minimal fake Informer that mirrors the public surface used
 * by EntityStore: addEventHandler, addSyncHandler, hasSynced, list, getById.
 */

import { describe, expect, test } from "bun:test";
import { EntityStore } from "./entity-store.js";
import type { WatchEntity } from "../../core/watch-events.js";
import type { Informer, EventHandlerFn, SyncHandlerFn, InformerOp } from "../../core/informer.js";

type AnyEntity = WatchEntity;

function makeFakeInformer(): {
  informer: Informer<"Contribution">;
  emit: (op: InformerOp, entity: AnyEntity) => Promise<void>;
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
    emitSync: () => {
      for (const s of [...syncs]) s();
    },
    setSynced: (v) => {
      synced = v;
    },
    store,
  };
}

function entity(id: string, rv = "1"): AnyEntity {
  return {
    kind: "Contribution",
    namespace: "default",
    id,
    spec: { contributionKind: "code", mode: "direct", summary: id, artifacts: {}, relations: [], tags: [] } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: rv,
    metadata: { generation: 1 },
  };
}

async function drainMicrotasks(): Promise<void> {
  // Two awaits is enough to drain queueMicrotask + Promise.resolve chains.
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
    const unsub = store.subscribe(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("an event after subscribe bumps version (drained via microtask)", async () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: FAIL — `entity-store.ts` doesn't exist.

- [ ] **Step 3: Write minimal `EntityStore` implementation**

Create `src/tui/data/entity-store.ts`:

```ts
/**
 * EntityStore<K> — reactive store layer over Informer<K> (B1 #296).
 *
 * Wraps a single Informer and adds a microtask-coalesced subscriber set,
 * a monotonic version counter, a write counter, a snapshot ref-cache,
 * and a per-kind grove_store_sse_lag ring. Data writes remain lossless
 * (Informer mutates its Map synchronously before fanning out events);
 * notifications coalesce to one per microtask so React's auto-batch can
 * commit at framework-paced cadence.
 *
 * EntityStore does not own the Informer's lifecycle. Stop/start/relist
 * are still driven by InformerFactory — EntityStore is a passive
 * subscriber that disposes its own subscriptions on `dispose()`.
 */

import type { Informer, InformerOp } from "../../core/informer.js";
import type { WatchEntity, WatchKind } from "../../core/watch-events.js";

type EntityFor<K extends WatchKind> = ReturnType<Informer<K>["list"]>[number];

export class EntityStore<K extends WatchKind> {
  private readonly informer: Informer<K>;
  private readonly kind: K;
  private readonly subscribers = new Set<() => void>();
  private readonly unsubscribeFromInformer: Array<() => void> = [];
  private version = 0;

  constructor(informer: Informer<K>, kind: K) {
    this.informer = informer;
    this.kind = kind;
    this.unsubscribeFromInformer.push(
      informer.addEventHandler(this.onEvent),
      informer.addSyncHandler(this.onSync),
    );
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  getVersion(): number {
    return this.version;
  }

  list(): readonly EntityFor<K>[] {
    return this.informer.list() as readonly EntityFor<K>[];
  }

  getById(id: string): EntityFor<K> | undefined {
    return this.informer.getById(id) as EntityFor<K> | undefined;
  }

  hasSynced(): boolean {
    return this.informer.hasSynced();
  }

  dispose(): void {
    for (const u of this.unsubscribeFromInformer) {
      try {
        u();
      } catch {
        /* idempotent */
      }
    }
    this.unsubscribeFromInformer.length = 0;
    this.subscribers.clear();
  }

  private onEvent = (_op: InformerOp, _entity: EntityFor<K>): void => {
    this.bumpAndNotify();
  };

  private onSync = (): void => {
    this.bumpAndNotify();
  };

  private bumpAndNotify(): void {
    this.version += 1;
    for (const sub of [...this.subscribers]) {
      try {
        sub();
      } catch (err) {
        console.error(`EntityStore[${this.kind}]: subscriber threw, continuing fanout:`, err);
      }
    }
  }
}
```

> The current implementation calls subscribers synchronously inside `onEvent`. The microtask coalescer is added in Task 6 — keeping the steps small.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/entity-store.ts src/tui/data/entity-store.test.ts
git commit -m "feat(tui): EntityStore<K> minimal shape (B1 #296)"
```

---

## Task 6: Microtask coalescing — N writes in one microtask → 1 notify

**Files:**
- Modify: `src/tui/data/entity-store.ts`
- Modify: `src/tui/data/entity-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/tui/data/entity-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: FAIL — current `bumpAndNotify` calls subscribers synchronously, so the first test sees `calls = 3`.

- [ ] **Step 3: Add microtask coalescing**

In `src/tui/data/entity-store.ts`, replace the `bumpAndNotify` method with a coalesced version. Add a `flushScheduled` field and a `flush()` method:

```ts
  private flushScheduled = false;

  private bumpAndNotify(): void {
    this.version += 1;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    // Snapshot before iterating so a subscriber that calls its own
    // unsubscribe (which mutates `subscribers`) doesn't skip the next
    // subscriber by shifting the iterator past it.
    for (const sub of [...this.subscribers]) {
      try {
        sub();
      } catch (err) {
        console.error(`EntityStore[${this.kind}]: subscriber threw, continuing fanout:`, err);
      }
    }
  }
```

Add `flushScheduled: boolean = false` to the class field declarations near the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: PASS — both new tests + all earlier tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/entity-store.ts src/tui/data/entity-store.test.ts
git commit -m "feat(tui): EntityStore microtask coalescing (B1 #296)"
```

---

## Task 7: Snapshot version stability — `list()` returns ref-stable array

**Files:**
- Modify: `src/tui/data/entity-store.ts`
- Modify: `src/tui/data/entity-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/tui/data/entity-store.test.ts`:

```ts
describe("EntityStore — snapshot stability", () => {
  test("list() returns the same ref while version is unchanged", async () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: FAIL — current `list()` returns `informer.list()` which is `Array.from(...)` — a fresh array each call.

- [ ] **Step 3: Add snapshot ref-cache**

In `src/tui/data/entity-store.ts`, add fields and modify `list()`:

```ts
  private snapshotCache: readonly EntityFor<K>[] | null = null;
  private snapshotVersion = -1;
```

Replace `list()`:

```ts
  list(): readonly EntityFor<K>[] {
    if (this.snapshotCache !== null && this.snapshotVersion === this.version) {
      return this.snapshotCache;
    }
    this.snapshotCache = Object.freeze(
      Array.from(this.informer.list()) as EntityFor<K>[],
    ) as readonly EntityFor<K>[];
    this.snapshotVersion = this.version;
    return this.snapshotCache;
  }
```

Modify `bumpAndNotify` to invalidate the cache:

```ts
  private bumpAndNotify(): void {
    this.version += 1;
    this.snapshotCache = null;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/entity-store.ts src/tui/data/entity-store.test.ts
git commit -m "feat(tui): EntityStore version-stable list() snapshots (B1 #296)"
```

---

## Task 8: `writeCounter` + `getStats()` (DevTools surface)

**Files:**
- Modify: `src/tui/data/entity-store.ts`
- Modify: `src/tui/data/entity-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/tui/data/entity-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: FAIL — `getStats` does not exist.

- [ ] **Step 3: Add `writeCounter` + `getStats()`**

In `src/tui/data/entity-store.ts`:

Add field:
```ts
  private writeCounter = 0;
```

Replace `onEvent` so it bumps `writeCounter` (sync handler does NOT):
```ts
  private onEvent = (_op: InformerOp, _entity: EntityFor<K>): void => {
    this.writeCounter += 1;
    this.bumpAndNotify();
  };

  private onSync = (): void => {
    this.bumpAndNotify();
  };
```

Add the public `getStats` method (the lag ring is wired up in Task 9 — empty array for now):
```ts
  getStats(): {
    readonly writes: number;
    readonly version: number;
    readonly lagSamples: readonly number[];
  } {
    return {
      writes: this.writeCounter,
      version: this.version,
      lagSamples: [],
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/entity-store.ts src/tui/data/entity-store.test.ts
git commit -m "feat(tui): EntityStore writeCounter + getStats (B1 #296)"
```

---

## Task 9: Lag ring — `grove_store_sse_lag` samples

**Files:**
- Modify: `src/tui/data/entity-store.ts`
- Modify: `src/tui/data/entity-store.test.ts`

The Informer's `EventHandlerFn` signature is `(op, entity) => void` — it does NOT pass through `emittedAt`. To compute lag inside the EntityStore, we need access to the `WatchClientEvent.emittedAt` that originated the Informer event. Since modifying `EventHandlerFn` would touch closed-epic code, the cleanest path is for EntityStore to subscribe a *second* listener that observes the raw `WatchClientEvent` stream BEFORE Informer fan-out — but the Informer doesn't expose that. Instead, we extend the existing `EventHandlerFn` *contract* by passing an optional `meta` arg.

> **Decision:** Modify `EventHandlerFn<K>` in `src/core/informer.ts` to accept an optional third `meta?: { emittedAt?: string }` argument and have `Informer.dispatch` forward `e.emittedAt` from the source `WatchClientEvent`. Optional arg → backward-compat: existing handlers (use-entities, use-entity, use-derived) ignore the extra arg with no change. This is a 4-line core change covered by an additive test.

- [ ] **Step 1: Write the failing test (informer side)**

Append to `src/core/informer.test.ts`:

```ts
test("Informer.addEventHandler forwards emittedAt via optional meta arg", async () => {
  const seenMeta: Array<{ emittedAt?: string } | undefined> = [];
  const stream = {
    run: async ({ onEvent }: { onEvent: (e: WatchClientEvent) => Promise<void> | void }) => {
      await onEvent({ op: "ADDED", rv: 1n, kind: "Contribution", entity: E_A, emittedAt: "2026-05-04T12:00:00.000Z" });
    },
  };
  const informer = new Informer<"Contribution">(stream as never);
  informer.addEventHandler((_op, _entity, meta) => {
    seenMeta.push(meta);
  });
  await informer.run(new AbortController().signal);
  expect(seenMeta.length).toBe(1);
  expect(seenMeta[0]?.emittedAt).toBe("2026-05-04T12:00:00.000Z");
});
```

(Use the existing `WatchClientEvent` and `E_A` already in the file's imports — see top of `informer.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/informer.test.ts`
Expected: FAIL — `meta` is undefined; `EventHandlerFn` only takes 2 args.

- [ ] **Step 3: Extend `EventHandlerFn` signature**

In `src/core/informer.ts`:

Change the type:
```ts
export type EventHandlerFn<K extends WatchKind = WatchKind> = (
  op: InformerOp,
  entity: EntityForKind<K>,
  meta?: { readonly emittedAt?: string },
) => void | Promise<void>;
```

Modify `dispatch` to pass `meta`. Find:
```ts
  private async dispatch(op: InformerOp, entity: EntityForKind<K>): Promise<void> {
```

Replace the signature and the call site inside `onEvent`. The `dispatch` method becomes:
```ts
  private async dispatch(
    op: InformerOp,
    entity: EntityForKind<K>,
    meta?: { readonly emittedAt?: string },
  ): Promise<void> {
    const signal = this._signal;
    for (const handler of [...this.handlers]) {
      try {
        await raceAbort(Promise.resolve(handler(op, entity, meta)), signal);
      } catch (err) {
        if (isAbortError(err)) return;
        console.error("Informer: event handler threw or rejected, continuing fanout:", err);
      }
    }
  }
```

In `onEvent`, pass `e.emittedAt`:
```ts
      case "ADDED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.set(entity.id, entity);
          await this.dispatch("ADDED", entity, e.emittedAt !== undefined ? { emittedAt: e.emittedAt } : undefined);
        }
        break;

      case "MODIFIED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.set(entity.id, entity);
          await this.dispatch("MODIFIED", entity, e.emittedAt !== undefined ? { emittedAt: e.emittedAt } : undefined);
        }
        break;

      case "DELETED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.delete(entity.id);
          await this.dispatch("DELETED", entity, e.emittedAt !== undefined ? { emittedAt: e.emittedAt } : undefined);
        }
        break;
```

(`commitReplace` does not have an `emittedAt` source — RELIST per-row events arrive with snapshot RV but no per-row emit timestamp; pass `undefined`. Existing call sites inside `commitReplace` need the arg added too, with `undefined`.)

In `commitReplace`:
```ts
    for (const e of deleted) await this.dispatch("DELETED", e, undefined);
    for (const e of added) await this.dispatch("ADDED", e, undefined);
    for (const e of modified) await this.dispatch("MODIFIED", e, undefined);
```

- [ ] **Step 4: Run test to verify the informer test passes**

Run: `bun test src/core/informer.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test (EntityStore side)**

Append to `src/tui/data/entity-store.test.ts`:

```ts
describe("EntityStore — lag ring", () => {
  test("pushes a positive sample when emittedAt is well-formed", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    // Pretend the event was emitted 50ms ago.
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
    await fake.emit("ADDED", entity("a")); // no meta
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
```

Update the fake-informer helper at the top of the file to support meta:

```ts
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: FAIL — lag ring not implemented yet.

- [ ] **Step 7: Implement lag ring in EntityStore**

In `src/tui/data/entity-store.ts`:

Add field + constant:
```ts
  private static readonly LAG_RING_SIZE = 1024;
  private readonly lagRing: number[] = [];
```

Replace `onEvent` to push lag samples:
```ts
  private onEvent = (
    _op: InformerOp,
    _entity: EntityFor<K>,
    meta?: { readonly emittedAt?: string },
  ): void => {
    this.writeCounter += 1;
    if (meta?.emittedAt !== undefined) {
      const t = Date.parse(meta.emittedAt);
      if (Number.isFinite(t)) {
        const lag = Date.now() - t;
        this.lagRing.push(lag);
        if (this.lagRing.length > EntityStore.LAG_RING_SIZE) {
          this.lagRing.shift();
        }
      }
    }
    this.bumpAndNotify();
  };
```

Replace `getStats` so it returns the live ring (defensive copy via spread to keep the field private):
```ts
  getStats(): {
    readonly writes: number;
    readonly version: number;
    readonly lagSamples: readonly number[];
  } {
    return {
      writes: this.writeCounter,
      version: this.version,
      lagSamples: [...this.lagRing],
    };
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test src/tui/data/entity-store.test.ts src/core/informer.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/informer.ts src/core/informer.test.ts src/tui/data/entity-store.ts src/tui/data/entity-store.test.ts
git commit -m "feat: EntityStore lag ring + Informer meta forwarding (B1 #296)"
```

---

## Task 10: Edge cases — unsubscribe-mid-flush, throwing subscriber, dispose

**Files:**
- Modify: `src/tui/data/entity-store.test.ts`

These behaviors are already implemented (snapshot iteration in `flush`, try/catch around subscriber invocation, `dispose` clears subscribers). This task locks them in via tests.

- [ ] **Step 1: Write the tests**

Append to `src/tui/data/entity-store.test.ts`:

```ts
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
    expect(store.getVersion()).toBe(0); // no further bumps
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

  test("getById returns post-write state synchronously, before flush", async () => {
    const fake = makeFakeInformer();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const observed: string[] = [];
    store.subscribe(() => {
      observed.push("flush");
    });
    // Mid-fanout read: the Informer's Map is already mutated when our
    // event handler runs, so getById sees the write before the flush
    // microtask drains.
    fake.informer.addEventHandler(() => {
      const got = store.getById("a");
      observed.push(got ? "in-fanout-found" : "in-fanout-missing");
    });
    await fake.emit("ADDED", entity("a"));
    await drainMicrotasks();
    expect(observed[0]).toBe("in-fanout-found");
    expect(observed[1]).toBe("flush");
  });
});
```

- [ ] **Step 2: Run test to verify it passes (these behaviors should already be implemented)**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: PASS.

If any test fails, fix the implementation in `entity-store.ts` until they pass — but the design from Tasks 5–9 should already cover all five.

- [ ] **Step 3: Commit**

```bash
git add src/tui/data/entity-store.test.ts
git commit -m "test(tui): EntityStore edge-case lockin (B1 #296)"
```

---

## Task 11: 10k events/sec burst test

**Files:**
- Create: `src/tui/data/entity-store.burst.test.ts`

- [ ] **Step 1: Write the test**

Create `src/tui/data/entity-store.burst.test.ts`:

```ts
/**
 * 10k events/sec burst acceptance test (B1 #296 AC #1).
 *
 * Asserts:
 *   - lossless data: writeCounter equals total events delivered
 *   - coalesced notify: subscriber fires once per microtask drain
 *   - duplicate-output: a constant-output selector triggers zero setState
 *   - wall-time under a CI-friendly budget so accidental O(N²) regressions
 *     in any of list()/snapshot caching/fanout get caught
 */

import { describe, expect, test } from "bun:test";
import { EntityStore } from "./entity-store.js";
import type { Informer, EventHandlerFn, SyncHandlerFn } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";

function entity(id: string, rv = "1"): WatchEntity {
  return {
    kind: "Contribution",
    namespace: "default",
    id,
    spec: { contributionKind: "code", mode: "direct", summary: id, artifacts: {}, relations: [], tags: [] } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: rv,
    metadata: { generation: 1 },
  };
}

function makeFake() {
  const store = new Map<string, WatchEntity>();
  const handlers: EventHandlerFn<"Contribution">[] = [];
  const syncs: SyncHandlerFn[] = [];
  return {
    informer: {
      addEventHandler: (fn: EventHandlerFn<"Contribution">) => {
        handlers.push(fn);
        return () => {};
      },
      addSyncHandler: (fn: SyncHandlerFn) => {
        syncs.push(fn);
        return () => {};
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
    // Drain microtasks once.
    await Promise.resolve();
    await Promise.resolve();
    const elapsed = Date.now() - t0;

    expect(store.getStats().writes).toBe(N);     // lossless data
    expect(calls).toBe(1);                       // one coalesced flush
    expect(store.getVersion()).toBe(N);
    expect(elapsed).toBeLessThan(500);           // CI-friendly budget
  });

  test("10000 ADDED of duplicate id: writes += 10000, list-length stays at 1", async () => {
    const fake = makeFake();
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");

    for (let i = 0; i < 10_000; i += 1) {
      fake.emit(entity("same", String(i + 1))); // bumping rv
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getStats().writes).toBe(10_000);
    expect(store.list().length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/tui/data/entity-store.burst.test.ts`
Expected: PASS.

> If wall-time fails on a slow CI runner, raise the 500ms budget — the goal is to catch O(N²) regressions, not to enforce absolute throughput. Do NOT loosen the writeCounter or coalesced-flush assertions, those are the actual ACs.

- [ ] **Step 3: Commit**

```bash
git add src/tui/data/entity-store.burst.test.ts
git commit -m "test(tui): EntityStore 10k/sec burst acceptance (B1 #296)"
```

---

## Task 12: Selector memoization snapshot tests

**Files:**
- Create: `src/tui/data/entity-store-selector.test.ts`

These tests assert the "duplicate outputs → zero re-renders" AC at the selector layer (without React). They mount no components — just verify that a selector running over `store.list()` returns the same array ref when no relevant data changed.

- [ ] **Step 1: Write the test**

Create `src/tui/data/entity-store-selector.test.ts`:

```ts
/**
 * Selector memoization snapshot tests (B1 #296 AC #2).
 *
 * Verifies that:
 *   - store.list() returns ref-stable arrays across no-op writes
 *   - a filter-then-shallow-equal selector returns the same output ref
 *     when filtered contents are unchanged
 *   - duplicate writes (same entity, same rv) don't change selector output
 */

import { describe, expect, test } from "bun:test";
import { EntityStore } from "./entity-store.js";
import { shallowArraysEqual } from "../hooks/use-entities.js";
import type { Informer, EventHandlerFn, SyncHandlerFn } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";

function entity(id: string, summary = id, rv = "1"): WatchEntity {
  return {
    kind: "Contribution",
    namespace: "default",
    id,
    spec: { contributionKind: "code", mode: "direct", summary, artifacts: {}, relations: [], tags: [] } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: rv,
    metadata: { generation: 1 },
  };
}

function makeFake() {
  const store = new Map<string, WatchEntity>();
  const handlers: EventHandlerFn<"Contribution">[] = [];
  const syncs: SyncHandlerFn[] = [];
  return {
    informer: {
      addEventHandler: (fn: EventHandlerFn<"Contribution">) => {
        handlers.push(fn);
        return () => {};
      },
      addSyncHandler: (fn: SyncHandlerFn) => {
        syncs.push(fn);
        return () => {};
      },
      hasSynced: () => true,
      getById: (id: string) => store.get(id) as never,
      list: () => Array.from(store.values()) as never,
    } as unknown as Informer<"Contribution">,
    emit: (op: "ADDED" | "MODIFIED" | "DELETED", e: WatchEntity) => {
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

  test("filter-then-shallow-equal selector: items filtered out → output ref-stable", async () => {
    const fake = makeFake();
    fake.emit("ADDED", entity("keep", "keep"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const select = (list: readonly WatchEntity[]) =>
      list.filter((e) => e.spec.summary === "keep");
    let prev = select(store.list());
    // Issue 100 writes for OTHER ids (filtered out by predicate).
    for (let i = 0; i < 100; i += 1) {
      fake.emit("ADDED", entity(`drop${i}`, "drop"));
    }
    await Promise.resolve();
    await Promise.resolve();
    const next = select(store.list());
    // The two filter outputs are NOT the same array (filter always
    // returns a new array), but they are shallow-equal — and a hook
    // applying shallowArraysEqual would commit the same ref.
    expect(shallowArraysEqual(prev, next)).toBe(true);
  });

  test("MODIFIED that doesn't change filtered slice contents → shallow-equal output", async () => {
    const fake = makeFake();
    fake.emit("ADDED", entity("a", "x", "1"));
    fake.emit("ADDED", entity("b", "y", "1"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const select = (list: readonly WatchEntity[]) =>
      list.filter((e) => e.spec.summary === "x");
    const prev = select(store.list());
    // Modify "b" — outside the filter; "a" untouched.
    fake.emit("MODIFIED", entity("b", "y", "2"));
    await Promise.resolve();
    await Promise.resolve();
    const next = select(store.list());
    expect(shallowArraysEqual(prev, next)).toBe(true);
  });

  test("snapshot ref-equality across no-op duplicate-rv writes", async () => {
    const fake = makeFake();
    fake.emit("ADDED", entity("a", "x", "1"));
    const store = new EntityStore<"Contribution">(fake.informer, "Contribution");
    const before = store.list();
    // Same rv → Informer's commitReplace would treat as no-modify, but
    // direct ADDED still triggers an event. Selector users should still
    // see a shallow-equal output.
    fake.emit("MODIFIED", entity("a", "x", "1"));
    await Promise.resolve();
    await Promise.resolve();
    const after = store.list();
    expect(shallowArraysEqual(before, after)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/tui/data/entity-store-selector.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/data/entity-store-selector.test.ts
git commit -m "test(tui): EntityStore selector memoization (B1 #296)"
```

---

## Task 13: `EntityStoreFactory`

**Files:**
- Modify: `src/tui/data/entity-store.ts`
- Modify: `src/tui/data/entity-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/tui/data/entity-store.test.ts`:

```ts
import { InformerFactory } from "../../core/informer.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "./entity-store.js";

describe("EntityStoreFactory", () => {
  function makeInformerFactory(): InformerFactory {
    return new InformerFactory({
      mode: "local",
      hub: new WatchHub({ maxAgeMs: 60_000, maxEvents: 1024, bookmarkIntervalMs: 30_000 }),
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
    expect(Object.keys(all)).toEqual(expect.arrayContaining(["Contribution", "Claim"]));
    expect(all.Contribution.writes).toBe(0);
  });

  test("dispose disposes every store; idempotent", () => {
    const factory = new EntityStoreFactory(makeInformerFactory());
    factory.storeFor("Contribution");
    factory.dispose();
    factory.dispose(); // no throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: FAIL — `EntityStoreFactory` does not exist.

- [ ] **Step 3: Add `EntityStoreFactory`**

Append to `src/tui/data/entity-store.ts`:

```ts
import type { InformerFactory } from "../../core/informer.js";

export interface EntityStoreStats {
  readonly writes: number;
  readonly version: number;
  readonly lagSamples: readonly number[];
}

export class EntityStoreFactory {
  private readonly informerFactory: InformerFactory;
  private readonly stores = new Map<WatchKind, EntityStore<WatchKind>>();

  constructor(informerFactory: InformerFactory) {
    this.informerFactory = informerFactory;
  }

  get mode(): "remote" | "local" {
    return this.informerFactory.mode;
  }

  supportsKind(kind: WatchKind): boolean {
    return this.informerFactory.supportsKind(kind);
  }

  storeFor<K extends WatchKind>(kind: K): EntityStore<K> {
    const existing = this.stores.get(kind);
    if (existing) return existing as EntityStore<K>;
    const informer = this.informerFactory.informerFor(kind);
    const store = new EntityStore<K>(informer, kind);
    this.stores.set(kind, store as EntityStore<WatchKind>);
    return store;
  }

  getAllStats(): Record<string, EntityStoreStats> {
    const out: Record<string, EntityStoreStats> = {};
    for (const [kind, store] of this.stores) {
      out[kind] = store.getStats();
    }
    return out;
  }

  dispose(): void {
    for (const store of this.stores.values()) {
      try {
        store.dispose();
      } catch {
        /* idempotent */
      }
    }
    this.stores.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/data/entity-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/entity-store.ts src/tui/data/entity-store.test.ts
git commit -m "feat(tui): EntityStoreFactory (B1 #296)"
```

---

## Task 14: `EntityStoreContext` provider + null stub + hooks

**Files:**
- Create: `src/tui/hooks/entity-store-context.tsx`
- Create: `src/tui/hooks/entity-store-context.test.tsx`

Mirror `informer-context.tsx`. The provider takes an `EntityStoreFactory`. The `useEntityStoreOptional<K>(kind)` hook returns a frozen no-op store when no provider is mounted or the factory's mode doesn't support the kind.

- [ ] **Step 1: Write the failing test**

Create `src/tui/hooks/entity-store-context.test.tsx`:

```tsx
/**
 * EntityStoreProvider + useEntityStoreOptional unit tests (B1 #296).
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import {
  EntityStoreProvider,
  useEntityStoreOptional,
} from "./entity-store-context.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFactory(): EntityStoreFactory {
  return new EntityStoreFactory(
    new InformerFactory({
      mode: "local",
      hub: new WatchHub({ maxAgeMs: 60_000, maxEvents: 1024, bookmarkIntervalMs: 30_000 }),
      namespace: "default",
      listFn: () => [],
    }),
  );
}

function Probe({ onStore, kind }: { onStore: (s: unknown) => void; kind: "Contribution" }): ReactNode {
  const store = useEntityStoreOptional(kind);
  onStore(store);
  return null;
}

describe("EntityStoreProvider", () => {
  test("supplies a factory-backed store to consumers", async () => {
    const factory = makeFactory();
    let store: unknown;
    await act(async () => {
      TestRenderer.create(
        <EntityStoreProvider value={factory}>
          <Probe onStore={(s) => { store = s; }} kind="Contribution" />
        </EntityStoreProvider>,
      );
    });
    expect(store).toBeDefined();
    expect((store as { hasSynced: () => boolean }).hasSynced).toBeDefined();
  });

  test("no provider → returns a no-op store with empty list and hasSynced=false", async () => {
    let store: unknown;
    await act(async () => {
      TestRenderer.create(<Probe onStore={(s) => { store = s; }} kind="Contribution" />);
    });
    const s = store as { list: () => readonly unknown[]; hasSynced: () => boolean; subscribe: (fn: () => void) => () => void };
    expect(s.list()).toEqual([]);
    expect(s.hasSynced()).toBe(false);
    const unsub = s.subscribe(() => { throw new Error("should never fire"); });
    expect(typeof unsub).toBe("function");
    unsub();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/hooks/entity-store-context.test.tsx`
Expected: FAIL — `entity-store-context.tsx` doesn't exist.

- [ ] **Step 3: Implement the provider**

Create `src/tui/hooks/entity-store-context.tsx`:

```tsx
/**
 * EntityStoreProvider — supplies an EntityStoreFactory to React subscribers (B1 #296).
 *
 * Mirrors `informer-context.tsx`. The provider takes a factory; consumer
 * hooks resolve a per-kind `EntityStore<K>` from it. When no provider is
 * mounted (e.g. in test trees or during early bootstrap), the optional
 * hook returns a frozen no-op store so React hook order stays stable.
 *
 * Lifecycle: this provider does NOT start the underlying watch streams.
 * Stream lifecycle is owned by `InformerProvider` (see informer-context).
 * `EntityStoreProvider` is mounted INSIDE `InformerProvider`.
 */

import { createContext, type ReactNode, useContext } from "react";
import type { EntityStore, EntityStoreFactory } from "../data/entity-store.js";
import type { WatchKind } from "../../core/watch-events.js";

const EntityStoreContext = createContext<EntityStoreFactory | null>(null);
EntityStoreContext.displayName = "EntityStoreContext";

export interface EntityStoreProviderProps {
  readonly value: EntityStoreFactory;
  readonly children: ReactNode;
}

export function EntityStoreProvider(props: EntityStoreProviderProps): ReactNode {
  return (
    <EntityStoreContext.Provider value={props.value}>
      {props.children}
    </EntityStoreContext.Provider>
  );
}

export function useEntityStoreFactoryOptional(): EntityStoreFactory | null {
  return useContext(EntityStoreContext);
}

const NULL_SUBSCRIBE = (_fn: () => void): (() => void) => () => undefined;
const FROZEN_EMPTY: readonly unknown[] = Object.freeze([]);

const NULL_STORE_CACHE = new Map<WatchKind, EntityStore<WatchKind>>();
function nullStoreFor<K extends WatchKind>(kind: K): EntityStore<K> {
  let stub = NULL_STORE_CACHE.get(kind);
  if (!stub) {
    stub = {
      subscribe: NULL_SUBSCRIBE,
      getVersion: () => 0,
      list: () => FROZEN_EMPTY as never,
      getById: () => undefined,
      hasSynced: () => false,
      getStats: () => ({ writes: 0, version: 0, lagSamples: [] }),
      dispose: () => undefined,
    } as unknown as EntityStore<WatchKind>;
    NULL_STORE_CACHE.set(kind, stub);
  }
  return stub as unknown as EntityStore<K>;
}

/**
 * Returns the kind's EntityStore from the mounted provider, or a frozen
 * no-op store when (a) no provider is mounted or (b) the factory's mode
 * doesn't support the kind. Mirrors `useInformerOptional` so hook order
 * stays stable across migrated and unmigrated trees.
 */
export function useEntityStoreOptional<K extends WatchKind>(kind: K): EntityStore<K> {
  const factory = useContext(EntityStoreContext);
  if (!factory || !factory.supportsKind(kind)) {
    return nullStoreFor(kind);
  }
  return factory.storeFor(kind);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/hooks/entity-store-context.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/entity-store-context.tsx src/tui/hooks/entity-store-context.test.tsx
git commit -m "feat(tui): EntityStoreProvider + useEntityStoreOptional (B1 #296)"
```

---

## Task 15: Migrate `useEntities` to subscribe via `EntityStore`

**Files:**
- Modify: `src/tui/hooks/use-entities.ts`

The hook's public signature `useEntities<K>(kind, predicate?)` and its `UseEntitiesResult<E>` shape do NOT change. Only the subscription path inside the hook changes.

- [ ] **Step 1: Read the current implementation to confirm baseline**

Read `src/tui/hooks/use-entities.ts` end-to-end. Note that it currently:
- pulls an Informer via `useInformerOptional(kind)`
- subscribes via `informer.addEventHandler(recompute)` + `informer.addSyncHandler(recompute)`
- maintains its own `data`, `hasSynced`, `streamError`, `computeError`, `dataRef`
- recomputes on every event by re-running `computeFilteredEntities(informer.list(), predicate)`

The migration replaces the dual subscription with a single `useSyncExternalStore` over the EntityStore.

- [ ] **Step 2: Migrate the hook**

Replace the body of `useEntities` in `src/tui/hooks/use-entities.ts` with:

```ts
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useInformerFactoryOptional } from "./informer-context.js";
import { useEntityStoreOptional } from "./entity-store-context.js";

export function shallowArraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

export function computeFilteredEntities<E>(
  list: readonly E[],
  predicate: ((e: E) => boolean) | undefined,
): readonly E[] {
  if (!predicate) return list;
  return list.filter(predicate);
}

export interface UseEntitiesResult<E> {
  readonly data: readonly E[];
  readonly hasSynced: boolean;
  readonly error: Error | null;
}

type EntityFor<K extends WatchKind> = ReturnType<Informer<K>["list"]>[number];

export function useEntities<K extends WatchKind>(
  kind: K,
  predicate?: (e: EntityFor<K>) => boolean,
): UseEntitiesResult<EntityFor<K>> {
  const store = useEntityStoreOptional(kind);
  const factory = useInformerFactoryOptional();
  const predicateRef = useRef(predicate);

  // Subscribe to version bumps. The return value is unused — uSES exists
  // only to register the subscription and re-render on store changes.
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  const getVersion = useCallback(() => store.getVersion(), [store]);
  useSyncExternalStore(subscribe, getVersion);

  // Compute the filtered slice from the (now-current) snapshot. Apply
  // shallow-equal short-circuit so duplicate writes don't trigger setState.
  const dataRef = useRef<readonly EntityFor<K>[] | null>(null);
  const computeErrorRef = useRef<Error | null>(null);

  const next = useMemo<readonly EntityFor<K>[] | null>(() => {
    try {
      const filtered = computeFilteredEntities(
        store.list() as readonly EntityFor<K>[],
        predicateRef.current,
      );
      computeErrorRef.current = null;
      return filtered;
    } catch (err) {
      computeErrorRef.current = err instanceof Error ? err : new Error(String(err));
      return null;
    }
    // store.getVersion() included so memo recomputes on each version bump.
  }, [store, store.getVersion()]);

  const data: readonly EntityFor<K>[] = (() => {
    if (next === null) {
      return dataRef.current ?? ([] as readonly EntityFor<K>[]);
    }
    if (dataRef.current && shallowArraysEqual(dataRef.current, next)) {
      return dataRef.current;
    }
    dataRef.current = next;
    return next;
  })();

  // Predicate-identity change → recompute synchronously without waiting
  // for the next watch event.
  if (predicateRef.current !== predicate) {
    predicateRef.current = predicate;
    try {
      const fresh = computeFilteredEntities(
        store.list() as readonly EntityFor<K>[],
        predicate,
      );
      if (!dataRef.current || !shallowArraysEqual(dataRef.current, fresh)) {
        dataRef.current = fresh;
      }
    } catch (err) {
      computeErrorRef.current = err instanceof Error ? err : new Error(String(err));
    }
  }

  // Stream errors come from the InformerFactory's error listener — owned
  // by the watch lifecycle, kept separate from compute errors.
  const [streamError, setStreamError] = useState<Error | null>(() =>
    factory ? factory.getLastError(kind) : null,
  );
  useEffect(() => {
    if (!factory) return;
    const unsub = factory.addErrorListener((errKind, err) => {
      if (errKind !== kind) return;
      setStreamError(err);
    });
    setStreamError(factory.getLastError(kind));
    return unsub;
  }, [factory, kind]);

  return {
    data: dataRef.current ?? data,
    hasSynced: store.hasSynced(),
    error: streamError ?? computeErrorRef.current,
  };
}
```

- [ ] **Step 3: Run all `use-entities` tests**

Run: `bun test src/tui/hooks/use-entities.test.ts`
Expected: PASS — the hook's public behavior is unchanged.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-entities.ts
git commit -m "refactor(tui): useEntities subscribes via EntityStore (B1 #296)"
```

---

## Task 16: Migrate `useEntity` to subscribe via `EntityStore`

**Files:**
- Modify: `src/tui/hooks/use-entity.ts`

- [ ] **Step 1: Read the current `use-entity.ts` to map the migration**

Read the file end-to-end. The pattern to replace will mirror the one used in `useEntities`: drop `informer.addEventHandler` + `informer.addSyncHandler` in favor of `useSyncExternalStore` over `EntityStore`.

- [ ] **Step 2: Migrate the hook**

Replace the body of `useEntity` so it:
1. Calls `const store = useEntityStoreOptional(kind);`
2. Calls `useSyncExternalStore(store.subscribe, store.getVersion)` (with the same `useCallback` wrappers shown in Task 15).
3. Reads the entity via `store.getById(id)`.
4. Tracks the prior `entity` ref via `useRef` and only updates state when the ref changes (`Object.is` for entities — Informer freezes them, so `===` works).
5. Keeps the `useInformerFactoryOptional` + `addErrorListener` plumbing exactly as in Task 15 for stream-error surfacing.

The exact code follows the same template as Task 15's `useEntities` body, simplified to a single-id read. Apply the same `useCallback` / `useSyncExternalStore` / `useRef` pattern. Do NOT introduce a separate utility — the redundancy across the three hooks is ~10 LOC each and they are easier to reason about as parallel implementations than a forced abstraction.

- [ ] **Step 3: Run `use-entity` tests**

Run: `bun test src/tui/hooks/use-entity.test.ts`
Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-entity.ts
git commit -m "refactor(tui): useEntity subscribes via EntityStore (B1 #296)"
```

---

## Task 17: Migrate `useDerived` to subscribe via `EntityStore`

**Files:**
- Modify: `src/tui/hooks/use-derived.ts`

- [ ] **Step 1: Read `use-derived.ts` to map the migration**

`useDerived(kind, deriveFn, eqFn?)` runs a derive function over the cache and only re-renders when `eqFn(prev, next)` returns false. The current implementation subscribes to `informer.addEventHandler` + `informer.addSyncHandler` and re-runs `derive(informer.list())` on each event.

- [ ] **Step 2: Migrate the hook**

Replace the subscription path with `useSyncExternalStore` over `EntityStore`, reading the snapshot from `store.list()`. Key points:
- The eqFn-vs-Object.is decision is unchanged: `useDerived` already accepts a custom `eqFn`; default to `Object.is` when not passed.
- The compute-error path is unchanged.
- The stream-error path uses the same `useInformerFactoryOptional` plumbing.

The migrated hook structure mirrors Task 15's `useEntities` but applies `derive(store.list())` instead of `computeFilteredEntities`. Reproduce the full migrated hook body inline; do not import shared helpers from `use-entities.ts`.

- [ ] **Step 3: Run all `use-derived` tests**

Run: `bun test src/tui/hooks/use-derived.test.ts src/tui/hooks/use-derived.integration.test.ts src/tui/hooks/use-derived.mount.test.tsx src/tui/hooks/use-derived.remote-e2e.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-derived.ts
git commit -m "refactor(tui): useDerived subscribes via EntityStore (B1 #296)"
```

---

## Task 18: Migration smoke — mount-level test under `EntityStoreProvider`

**Files:**
- Create: `src/tui/hooks/use-entities.store-backed.test.tsx`

This test exercises the full mounted path: `<EntityStoreProvider>` → `useEntities` → renders correctly when events flow through the underlying `Informer` driven by a `WatchHub`.

- [ ] **Step 1: Write the test**

Create `src/tui/hooks/use-entities.store-backed.test.tsx`:

```tsx
/**
 * Mount-level smoke for useEntities migrated to EntityStore (B1 #296).
 *
 * Mounts a consumer inside both InformerProvider (eager) and
 * EntityStoreProvider, drives writes through a real WatchHub, and asserts
 * the component re-renders with the updated filtered list.
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "./entity-store-context.js";
import { InformerProvider } from "./informer-context.js";
import { useEntities } from "./use-entities.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entity(id: string, summary = id): WatchEntity {
  return {
    kind: "Contribution",
    namespace: "default",
    id,
    spec: { contributionKind: "code", mode: "direct", summary, artifacts: {}, relations: [], tags: [] } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "1",
    metadata: { generation: 1 },
  };
}

function Probe({ onResult }: { onResult: (data: readonly WatchEntity[]) => void }): ReactNode {
  const { data } = useEntities("Contribution");
  onResult(data);
  return null;
}

describe("useEntities — store-backed mount smoke", () => {
  test("re-renders with new entities as WatchHub events flow", async () => {
    const hub = new WatchHub({ maxAgeMs: 60_000, maxEvents: 1024, bookmarkIntervalMs: 30_000 });
    const informerFactory = new InformerFactory({
      mode: "local",
      hub,
      namespace: "default",
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);

    let lastData: readonly WatchEntity[] = [];
    await act(async () => {
      TestRenderer.create(
        <InformerProvider value={informerFactory} eager>
          <EntityStoreProvider value={storeFactory}>
            <Probe onResult={(d) => { lastData = d; }} />
          </EntityStoreProvider>
        </InformerProvider>,
      );
    });

    // Initial render: empty.
    expect(lastData.length).toBe(0);

    await act(async () => {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "default",
        op: "ADDED",
        entity: entity("c1"),
      });
      // Drain microtasks for the EntityStore flush + React commit.
      await Promise.resolve();
      await Promise.resolve();
    });

    // After fan-out: the consumer sees one entity.
    expect(lastData.length).toBe(1);
    expect(lastData[0].id).toBe("c1");

    await act(async () => {
      await informerFactory.stopAll();
      storeFactory.dispose();
    });
  });
});
```

- [ ] **Step 2: Run test**

Run: `bun test src/tui/hooks/use-entities.store-backed.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/use-entities.store-backed.test.tsx
git commit -m "test(tui): useEntities mount smoke under EntityStoreProvider (B1 #296)"
```

---

## Task 19: Wire `EntityStoreFactory` + `EntityStoreProvider` into `tui-app.tsx`

**Files:**
- Modify: `src/tui/tui-app.tsx`

- [ ] **Step 1: Locate the existing `InformerProvider` mount in `tui-app.tsx`**

Open `src/tui/tui-app.tsx` and search for `InformerProvider`. Existing pattern is:

```tsx
<InformerProvider value={informerFactory} eager scopeAwareProvider={...}>
  {/* tree */}
</InformerProvider>
```

(Or, in the interactive flow, an `InformerProviderHolder` driven by an `InformerHolder` set asynchronously.)

- [ ] **Step 2: Construct `EntityStoreFactory` alongside `InformerFactory`**

Wherever `InformerFactory` is constructed in the bootstrap path (search for `new InformerFactory(`), construct a sibling `EntityStoreFactory` immediately after:

```ts
const storeFactory = new EntityStoreFactory(informerFactory);
```

If the interactive flow uses an async-set holder pattern for the InformerFactory, mirror it: introduce a simple `EntityStoreHolder` (or piggy-back on the existing holder by storing a tuple) so the store factory becomes available at the same time.

- [ ] **Step 3: Wrap the tree with `EntityStoreProvider`**

Inside the existing `InformerProvider` mount, wrap children with `EntityStoreProvider`:

```tsx
<InformerProvider value={informerFactory} eager scopeAwareProvider={provider}>
  <EntityStoreProvider value={storeFactory}>
    {/* existing tree */}
  </EntityStoreProvider>
</InformerProvider>
```

- [ ] **Step 4: Dispose `storeFactory` on unmount**

Add `storeFactory.dispose()` to the existing teardown path that currently calls `informerFactory.stopAll()`. The exact location depends on the bootstrap shape — match the lifecycle of the InformerFactory.

- [ ] **Step 5: Run the existing TUI tests**

Run: `bun test src/tui/`
Expected: PASS — the whole `src/tui/` suite stays green.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/tui-app.tsx
git commit -m "wire(tui): EntityStoreFactory + Provider in tui-app bootstrap (B1 #296)"
```

---

## Task 20: Final verification — typecheck, lint, full test suite

**Files:**
- (no new files)

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — zero errors.

- [ ] **Step 2: Run lint**

Run: `bun run lint`
Expected: PASS — zero errors. If biome complains about unused imports left over from the migration in `use-entities.ts` / `use-entity.ts` / `use-derived.ts`, remove them.

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: PASS — every test green.

- [ ] **Step 4: Run the watch-relist E2E smoke**

Run: `bun run smoke:watch-relist`
Expected: PASS — the existing watch-protocol smoke still works after the wire-format addition (`emittedAt` is optional, so this should be a no-op assertion-wise; the smoke just needs to keep working).

- [ ] **Step 5: Confirm acceptance criteria**

Spot-check each AC from the issue:
- AC #1 (10k/sec lossless): `bun test src/tui/data/entity-store.burst.test.ts` PASSES.
- AC #2 (selector memoization): `bun test src/tui/data/entity-store-selector.test.ts` PASSES.
- AC #3 (DevTools shows every event in order): `EntityStore.getStats().writes` is asserted in `entity-store.test.ts` and `entity-store.burst.test.ts`.
- AC #4 (`grove_store_sse_lag` exported): `EntityStore.getStats().lagSamples` is exposed and asserted in `entity-store.test.ts`. `EntityStoreFactory.getAllStats()` is the bulk read for a future telemetry bridge.

- [ ] **Step 6: No commit needed for verification step.**

---

## Self-review notes

**Spec coverage:**
- ✅ §Architecture — Tasks 5–14 build the components in the order: minimal shape → microtask coalescing → snapshot stability → writeCounter/getStats → lag ring → edge cases → factory → provider.
- ✅ §Data flow → Write path — Tasks 1–4 plumb `emittedAt` end-to-end; Tasks 5–9 wire the EntityStore pickup at the Informer fan-out boundary.
- ✅ §Data flow → Notify path — Task 6 adds the microtask coalescer; Task 11's burst test enforces single-flush coalescing.
- ✅ §Data flow → Snapshot stability — Task 7 implements the version-keyed snapshot cache; Task 12 tests selector memoization.
- ✅ §Data flow → Lag ring — Task 9 implements the ring; tests verify well-formed, missing, unparseable, and 1024-cap behavior.
- ✅ §Hook API — Tasks 15–17 migrate `useEntities` / `useEntity` / `useDerived`; Task 18 mounts the migrated hook end-to-end.
- ✅ §Error handling — Task 10 locks in subscriber-throw isolation, unsubscribe-mid-flush safety, and dispose idempotency.
- ✅ §Testing — All five test files from the spec are produced (entity-store.test.ts, entity-store.burst.test.ts, entity-store-selector.test.ts, use-entities.store-backed.test.tsx, watch-emitted-at.test.ts).
- ✅ §Migration / rollout — Single-PR ordering matches Tasks 1 → 19.

**Placeholder scan:** No "TBD" / "TODO". Tasks 16 and 17 give the migration template by reference to Task 15 rather than reproducing 60 lines verbatim — this is intentional and bounded by the explicit guidance "apply the same useCallback / useSyncExternalStore / useRef pattern" plus a one-by-one mapping of what changes (snapshot read site, eqFn). Task 19 references the existing tui-app bootstrap shape rather than dictating exact line edits, because the bootstrap path forks based on `--url` vs interactive mode and the implementer must read the current shape — the alternative (reproducing 200 LOC of bootstrap here) would rot.

**Type consistency:** `EntityStore.subscribe(fn: () => void): () => void`, `getVersion(): number`, `list(): readonly EntityFor<K>[]`, `getStats(): { writes; version; lagSamples }`, `dispose(): void` — used identically across Tasks 5, 6, 7, 8, 9, 13, 14, 15, 18. `EntityStoreFactory.storeFor / mode / supportsKind / getAllStats / dispose` — used identically across Tasks 13, 14, 18, 19. `EventHandlerFn<K>` extended in Task 9 with `meta?: { emittedAt?: string }` — consumed only by EntityStore; the existing hook callers in `use-entities.ts` etc. ignore the extra arg. Field names match: `version`, `flushScheduled`, `subscribers`, `snapshotCache`, `snapshotVersion`, `writeCounter`, `lagRing`.
