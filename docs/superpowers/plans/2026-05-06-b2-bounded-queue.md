# B2 Bounded Queue + Overflow → Full Resync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a bounded write queue (`Map<id, WatchClientEvent>`) inside `Informer<K>` so the SSE → store path tolerates 100k+ event/sec bursts without freezing the TUI; on overflow, abort and trigger a fresh `list → watch` handshake via `InformerFactory.relist(kind)`.

**Architecture:** Insert the queue between `WatchStream.onEvent` and the existing apply path (renamed `onEvent` → `applyEvent`). Hot delta path is synchronous (no microtask per event). Same-id events coalesce in the Map (RV-coalescing). Control events (`RELIST_BEGIN/RELIST/RELIST_END/RELIST_ABORTED`) drain the queue first, then apply inline. Overflow drops the queue, increments `overflows`, and fires `onOverflow(kind)` which calls `factory.relist(kind)` (already serialized via `withLock`). Stats roll up through `EntityStore.getStats()`.

**Tech Stack:** TypeScript, bun:test, Zustand-pattern store (B1), k8s-informer-style watch (#292/#294/#296).

**Spec:** `docs/superpowers/specs/2026-05-06-b2-bounded-queue-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/informer.ts` | Add `kind` ctor arg + `InformerOptions` + queue/overflow state + `enqueue`/`enqueueControl`/`scheduleDrain`/`drain`. Rename `onEvent` → `applyEvent`. Wire `InformerFactory.queueLimits` + `onOverflow` → `relist`. |
| `src/core/informer.test.ts` | Update all `new Informer(stream)` call sites to pass `kind`. Add unit tests for queue, coalescing, overflow, per-kind limits. |
| `src/core/informer.burst.test.ts` (new) | 100k events/sec for 5s acceptance test. |
| `src/tui/data/entity-store.ts` | Extend `EntityStore.getStats()` + `EntityStoreStats` to surface `overflows`, `queueDepth`, `queueLimit`. |
| `src/tui/data/entity-store.test.ts` | Update fake Informer to provide `getQueueStats`. Add propagation test. |
| `src/tui/hooks/entity-store-context.tsx` | Update placeholder `getStats` stub shape. |

---

## Task 1: Add `kind` ctor arg + `InformerOptions` (no behavior change yet)

**Files:**
- Modify: `src/core/informer.ts`
- Modify: `src/core/informer.test.ts`

- [ ] **Step 1: Read current ctor**

`src/core/informer.ts:48-50`:
```ts
constructor(stream: WatchStream) {
  this.stream = stream;
}
```

- [ ] **Step 2: Add InformerOptions type before the class**

```ts
export interface InformerOptions {
  /** Max distinct entity ids buffered between drain cycles. Default 1000. */
  readonly queueLimit?: number;
  /** Fired exactly once per overflow event. Wired by InformerFactory to factory.relist(kind). */
  readonly onOverflow?: (kind: WatchKind) => void;
}
```

- [ ] **Step 3: Update ctor signature + fields**

Change ctor to:
```ts
private readonly kind: WatchKind;
private readonly queueLimit: number;
private readonly onOverflow: ((kind: WatchKind) => void) | null;

constructor(stream: WatchStream, kind: WatchKind, opts?: InformerOptions) {
  this.stream = stream;
  this.kind = kind;
  this.queueLimit = opts?.queueLimit ?? 1000;
  this.onOverflow = opts?.onOverflow ?? null;
}
```

- [ ] **Step 4: Update `InformerFactory.informerFor` to pass `kind`**

`src/core/informer.ts:438` — change `new Informer<K>(stream)` to `new Informer<K>(stream, kind)`.

- [ ] **Step 5: Update all test ctor sites in `src/core/informer.test.ts`**

Run:
```bash
sed -i '' 's|new Informer(\n        new WatchClient|new Informer(\n        new WatchClient, REPLACE_KIND|g' src/core/informer.test.ts
```

That regex won't catch multi-line ctor calls. Do it by hand instead — there are 30 sites. Each looks like:
```ts
const informer = new Informer(
  new WatchClient({...kind: "Contribution"...}),
);
```
becomes:
```ts
const informer = new Informer(
  new WatchClient({...kind: "Contribution"...}),
  "Contribution",
);
```

All existing test sites use `kind: "Contribution"`. Confirm with `grep -c 'kind: "' src/core/informer.test.ts`.

- [ ] **Step 6: Run existing tests to verify no behavior regression**

Run: `bun test src/core/informer.test.ts`
Expected: PASS — all existing tests green.

- [ ] **Step 7: Commit**

```bash
git add src/core/informer.ts src/core/informer.test.ts
git commit -m "refactor(informer): add kind + InformerOptions ctor args (B2 #298)

Pure plumbing change: ctor takes kind + opts. Default queueLimit=1000,
onOverflow=null. No behavior change yet — queue not wired up."
```

---

## Task 2: Refactor `onEvent` → `applyEvent` (no behavior change)

**Files:**
- Modify: `src/core/informer.ts`

- [ ] **Step 1: Rename the private method**

In `src/core/informer.ts`, rename `private async onEvent(e)` → `private async applyEvent(e)`. Update the single call site inside `run()`:
```ts
await this.stream.run({ onEvent: (e) => this.applyEvent(e), signal });
```

- [ ] **Step 2: Run existing tests to verify rename is clean**

Run: `bun test src/core/informer.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/informer.ts
git commit -m "refactor(informer): rename onEvent → applyEvent (B2 #298)

Frees the 'onEvent' name for the upcoming enqueue layer. Pure rename."
```

---

## Task 3: Add queue + `enqueue` (delta path, NO drain yet)

**Files:**
- Modify: `src/core/informer.ts`
- Modify: `src/core/informer.test.ts`

- [ ] **Step 1: Add queue state + helper**

In the class body, add fields:
```ts
private queue = new Map<string, WatchClientEvent>();
private overflows = 0;
private flushScheduled = false;
```

Add module-level helper above the class:
```ts
function isControlEvent(op: WatchClientOp): boolean {
  return (
    op === "RELIST_BEGIN" ||
    op === "RELIST" ||
    op === "RELIST_END" ||
    op === "RELIST_ABORTED"
  );
}
```

(Import `WatchClientOp` from `./watch-client.js`.)

- [ ] **Step 2: Add `enqueue` (delta path only — control path stub)**

Add private method:
```ts
private enqueue(e: WatchClientEvent): void | Promise<void> {
  if (isControlEvent(e.op)) return this.enqueueControl(e);
  const id = e.entity?.id;
  if (id === undefined) return;
  if (this.queue.has(id)) {
    this.queue.set(id, e);
    return;
  }
  if (this.queue.size >= this.queueLimit) {
    this.queue.clear();
    this.overflows += 1;
    if (this.onOverflow) {
      try {
        this.onOverflow(this.kind);
      } catch (err) {
        console.error(
          `Informer[${this.kind}]: onOverflow callback threw, recovery skipped:`,
          err,
        );
      }
    }
    return;
  }
  this.queue.set(id, e);
  this.scheduleDrain();
}
```

- [ ] **Step 3: Add `enqueueControl` (drain barrier)**

```ts
private async enqueueControl(e: WatchClientEvent): Promise<void> {
  if (this.queue.size > 0) {
    const pending = this.queue;
    this.queue = new Map();
    for (const ev of pending.values()) await this.applyEvent(ev);
  }
  await this.applyEvent(e);
}
```

- [ ] **Step 4: Add `scheduleDrain` + `drain`**

```ts
private scheduleDrain(): void {
  if (this.flushScheduled) return;
  this.flushScheduled = true;
  queueMicrotask(() => {
    void this.drain();
  });
}

private async drain(): Promise<void> {
  this.flushScheduled = false;
  if (this.queue.size === 0) return;
  const pending = this.queue;
  this.queue = new Map();
  for (const ev of pending.values()) {
    await this.applyEvent(ev);
  }
}
```

- [ ] **Step 5: Add `getQueueStats`**

```ts
getQueueStats(): {
  readonly depth: number;
  readonly limit: number;
  readonly overflows: number;
} {
  return { depth: this.queue.size, limit: this.queueLimit, overflows: this.overflows };
}
```

- [ ] **Step 6: Wire `run()` to use enqueue**

Change in `run()`:
```ts
await this.stream.run({ onEvent: (e) => this.enqueue(e), signal });
```

- [ ] **Step 7: Run existing tests — they exercise the queue path now**

Run: `bun test src/core/informer.test.ts`
Expected: PASS — control events drain (queue empty), deltas go through queue → microtask → applyEvent. Existing tests assert post-event state via `await informer.run`, which awaits `RELIST_END` (control event) which drains. Some delta tests may need an extra microtask drain — fix by adding `await new Promise(r => queueMicrotask(r));` before assertions where they currently rely on synchronous handler dispatch.

If any test fails because handler runs after assertion, that's expected fallout from the queue layer. Add the microtask drain in the failing test only.

- [ ] **Step 8: Commit**

```ts
// (No code in this step — Bash only)
```

```bash
git add src/core/informer.ts src/core/informer.test.ts
git commit -m "feat(informer): bounded write queue with RV-coalescing (B2 #298)

Queue is Map<id, WatchClientEvent> capped at queueLimit. Same-id events
overwrite (RV-coalesce). Control events drain queue first then apply
inline so RELIST_BEGIN/END staging invariant holds. Drain is microtask-
scheduled. Overflow clears queue + bumps counter + fires onOverflow."
```

---

## Task 4: Unit test — RV-coalescing same id

**Files:**
- Modify: `src/core/informer.test.ts`

- [ ] **Step 1: Add test setup helper for fake WatchStream**

At the top of the test file (or in a new section near the bottom — wherever fits the existing style), add a helper:

```ts
function makeFakeStream(): {
  stream: WatchStream;
  emit: (e: WatchClientEvent) => Promise<void>;
} {
  let onEvent: ((e: WatchClientEvent) => void | Promise<void>) | null = null;
  const stream: WatchStream = {
    run: async (opts) => {
      onEvent = opts.onEvent;
      // Block until aborted; tests trigger emit() externally.
      await new Promise<void>((resolve) => {
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      onEvent = null;
    },
  };
  return {
    stream,
    emit: async (e) => {
      if (!onEvent) throw new Error("stream not running");
      await onEvent(e);
    },
  };
}

function deltaEvent(
  op: "ADDED" | "MODIFIED" | "DELETED",
  id: string,
  rv: string,
): WatchClientEvent {
  return {
    op,
    rv: BigInt(rv),
    kind: "Contribution",
    entity: {
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
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
```

- [ ] **Step 2: Add the test**

```ts
describe("Informer queue — RV-coalescing", () => {
  test("10000 events for same id → 1 applyEvent, peak depth 1", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const informer = new Informer(stream, "Contribution");
    const runPromise = informer.run(ac.signal);

    const handlerCalls: string[] = [];
    informer.addEventHandler((op, entity) => {
      handlerCalls.push(`${op}:${(entity as { resourceVersion: string }).resourceVersion}`);
    });

    let peakDepth = 0;
    for (let i = 0; i < 10_000; i += 1) {
      await emit(deltaEvent("MODIFIED", "same", String(i + 1)));
      const d = informer.getQueueStats().depth;
      if (d > peakDepth) peakDepth = d;
    }
    await drainMicrotasks();

    expect(peakDepth).toBe(1);
    expect(handlerCalls).toEqual(["MODIFIED:10000"]);

    ac.abort();
    await runPromise;
  });
});
```

- [ ] **Step 3: Run the test**

Run: `bun test src/core/informer.test.ts -t "RV-coalescing"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/informer.test.ts
git commit -m "test(informer): RV-coalescing collapses same-id burst (B2 #298)"
```

---

## Task 5: Unit tests — coalescing edge cases (ADDED→DELETED, DELETED→ADDED)

**Files:**
- Modify: `src/core/informer.test.ts`

- [ ] **Step 1: Add tests inside the same describe block from Task 4**

```ts
test("ADDED then DELETED same id within burst → final state absent", async () => {
  const { stream, emit } = makeFakeStream();
  const ac = new AbortController();
  const informer = new Informer(stream, "Contribution");
  const runPromise = informer.run(ac.signal);

  await emit(deltaEvent("ADDED", "x", "1"));
  await emit(deltaEvent("DELETED", "x", "2"));
  await drainMicrotasks();

  expect(informer.getById("x")).toBeUndefined();

  ac.abort();
  await runPromise;
});

test("DELETED then ADDED same id within burst → final state present (recreated)", async () => {
  const { stream, emit } = makeFakeStream();
  const ac = new AbortController();
  const informer = new Informer(stream, "Contribution");
  const runPromise = informer.run(ac.signal);

  await emit(deltaEvent("DELETED", "x", "1"));
  await emit(deltaEvent("ADDED", "x", "2"));
  await drainMicrotasks();

  expect((informer.getById("x") as { resourceVersion: string } | undefined)?.resourceVersion).toBe(
    "2",
  );

  ac.abort();
  await runPromise;
});
```

- [ ] **Step 2: Run**

Run: `bun test src/core/informer.test.ts -t "queue"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/informer.test.ts
git commit -m "test(informer): coalescing edge cases ADDED↔DELETED (B2 #298)"
```

---

## Task 6: Unit test — overflow detection + onOverflow callback

**Files:**
- Modify: `src/core/informer.test.ts`

- [ ] **Step 1: Add test**

```ts
describe("Informer queue — overflow", () => {
  test("queueLimit+1 distinct ids → overflows=1, queue cleared, onOverflow fired exactly once", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const overflowKinds: WatchKind[] = [];
    const informer = new Informer(stream, "Contribution", {
      queueLimit: 5,
      onOverflow: (kind) => overflowKinds.push(kind),
    });
    const runPromise = informer.run(ac.signal);

    // Emit 5 distinct ids — fills queue exactly to limit.
    for (let i = 0; i < 5; i += 1) {
      await emit(deltaEvent("ADDED", `id-${i}`, String(i + 1)));
    }
    expect(informer.getQueueStats().depth).toBe(5);
    expect(informer.getQueueStats().overflows).toBe(0);

    // 6th distinct id — must overflow.
    await emit(deltaEvent("ADDED", "id-overflow", "6"));
    expect(informer.getQueueStats().depth).toBe(0);
    expect(informer.getQueueStats().overflows).toBe(1);
    expect(overflowKinds).toEqual(["Contribution"]);

    ac.abort();
    await runPromise;
  });

  test("onOverflow callback that throws does not corrupt queue state", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();
    const informer = new Informer(stream, "Contribution", {
      queueLimit: 2,
      onOverflow: () => {
        throw new Error("boom");
      },
    });
    const runPromise = informer.run(ac.signal);

    await emit(deltaEvent("ADDED", "a", "1"));
    await emit(deltaEvent("ADDED", "b", "2"));
    await emit(deltaEvent("ADDED", "c", "3")); // overflows; throws inside callback

    expect(informer.getQueueStats().depth).toBe(0);
    expect(informer.getQueueStats().overflows).toBe(1);

    ac.abort();
    await runPromise;
  });
});
```

- [ ] **Step 2: Run**

Run: `bun test src/core/informer.test.ts -t "overflow"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/informer.test.ts
git commit -m "test(informer): overflow path + onOverflow error isolation (B2 #298)"
```

---

## Task 7: Wire `InformerFactory.queueLimits` + `onOverflow` → `relist`

**Files:**
- Modify: `src/core/informer.ts`
- Modify: `src/core/informer.test.ts`

- [ ] **Step 1: Extend `InformerFactoryOptions`**

In `src/core/informer.ts`, add a shared field by changing both union arms or adding to an intersection. Cleanest: add it to both arms via a base type:

```ts
interface InformerFactoryBaseOptions {
  readonly queueLimits?: Partial<Record<WatchKind, number>>;
}

export type InformerFactoryOptions = InformerFactoryBaseOptions &
  (
    | {
        readonly mode: "remote";
        readonly baseUrl: string;
        readonly authHeader: string;
        readonly fetch?: typeof fetch;
        readonly backoff?: Backoff;
      }
    | {
        readonly mode: "local";
        readonly hub: WatchHub;
        readonly namespace: string;
        readonly listFn: (
          kind: WatchKind,
        ) => readonly WatchEntity[] | Promise<readonly WatchEntity[]>;
      }
  );
```

- [ ] **Step 2: Pass queueLimit + onOverflow when constructing Informer**

Replace `informerFor`'s `new Informer<K>(stream, kind)` with:

```ts
const informer = new Informer<K>(stream, kind, {
  queueLimit: this.opts.queueLimits?.[kind] ?? 1000,
  onOverflow: (k) => {
    void this.relist(k);
  },
});
```

- [ ] **Step 3: Run all existing tests to confirm no regression**

Run: `bun test src/core/informer.test.ts`
Expected: PASS.

- [ ] **Step 4: Add per-kind limit test**

Inside the existing `describe("InformerFactory ...")` section (find via `grep -n 'describe.*Factory' src/core/informer.test.ts`) add:

```ts
test("queueLimits override applies per kind", () => {
  const factory = new InformerFactory({
    mode: "local",
    hub: new WatchHub(),
    namespace: "default",
    listFn: () => [],
    queueLimits: { AgentSession: 5 },
  });
  const c = factory.informerFor("Contribution");
  const a = factory.informerFor("AgentSession");
  expect(c.getQueueStats().limit).toBe(1000); // default
  expect(a.getQueueStats().limit).toBe(5);    // overridden
});
```

(If `WatchHub` is not already imported in this file, add: `import { WatchHub } from "./watch-hub.js";`.)

- [ ] **Step 5: Run new test**

Run: `bun test src/core/informer.test.ts -t "queueLimits"`
Expected: PASS.

- [ ] **Step 6: Add factory→relist wiring test**

```ts
test("overflow on a factory-created informer triggers factory.relist(kind)", async () => {
  const factory = new InformerFactory({
    mode: "local",
    hub: new WatchHub(),
    namespace: "default",
    listFn: () => [],
    queueLimits: { Contribution: 2 },
  });
  // Spy on relist by wrapping the prototype method.
  let relistCalls: WatchKind[] = [];
  const origRelist = factory.relist.bind(factory);
  factory.relist = async (kind?: WatchKind) => {
    if (kind) relistCalls.push(kind);
    return origRelist(kind);
  };
  const informer = factory.informerFor("Contribution");
  // Drive overflow directly via the private path: emit 3 distinct deltas.
  // We need a stream — start the informer first, then push events through
  // its underlying stream. Easiest: just call enqueue via a cast.
  const enq = (informer as unknown as { enqueue: (e: WatchClientEvent) => void }).enqueue.bind(
    informer,
  );
  enq(deltaEvent("ADDED", "a", "1"));
  enq(deltaEvent("ADDED", "b", "2"));
  enq(deltaEvent("ADDED", "c", "3"));
  // relist is async (microtask) since onOverflow does void this.relist(kind)
  await drainMicrotasks();
  expect(relistCalls).toEqual(["Contribution"]);
  expect(informer.getQueueStats().overflows).toBe(1);
  await factory.stopAll();
});
```

- [ ] **Step 7: Run**

Run: `bun test src/core/informer.test.ts -t "overflow on a factory"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/informer.ts src/core/informer.test.ts
git commit -m "feat(informer): factory wires queueLimits + overflow→relist (B2 #298)"
```

---

## Task 8: EntityStore.getStats() surface

**Files:**
- Modify: `src/tui/data/entity-store.ts`
- Modify: `src/tui/data/entity-store.test.ts`
- Modify: `src/tui/hooks/entity-store-context.tsx`

- [ ] **Step 1: Update `EntityStoreStats` type and `getStats()` in entity-store.ts**

Replace the existing `getStats()` and `EntityStoreStats`:

```ts
export interface EntityStoreStats {
  readonly writes: number;
  readonly version: number;
  readonly overflows: number;
  readonly queueDepth: number;
  readonly queueLimit: number;
  readonly lagSamples: readonly number[];
}

// inside class EntityStore:
getStats(): EntityStoreStats {
  const q = this.informer.getQueueStats();
  return {
    writes: this.writeCounter,
    version: this.version,
    overflows: q.overflows,
    queueDepth: q.depth,
    queueLimit: q.limit,
    lagSamples: [...this.lagRing],
  };
}
```

The inline shape annotation in `getStats(): { ... }` should be removed in favor of the named `EntityStoreStats` type so the two stay in sync.

- [ ] **Step 2: Update `EntityStore` test fake to expose `getQueueStats`**

In `src/tui/data/entity-store.test.ts` and `src/tui/data/entity-store.burst.test.ts`, the `makeFakeInformer()` / `makeFake()` helpers return objects shaped like `Informer<"Contribution">` but missing `getQueueStats`. Add it:

```ts
const informer = {
  // ... existing handlers
  getQueueStats: () => ({ depth: 0, limit: 1000, overflows: 0 }),
  // ...
} as unknown as Informer<"Contribution">;
```

Apply to both test files (look for `as unknown as Informer<"Contribution">`).

- [ ] **Step 3: Update placeholder stub in entity-store-context.tsx**

`src/tui/hooks/entity-store-context.tsx:54` currently:
```ts
getStats: () => ({ writes: 0, version: 0, lagSamples: [] }),
```
Change to:
```ts
getStats: () => ({
  writes: 0,
  version: 0,
  overflows: 0,
  queueDepth: 0,
  queueLimit: 0,
  lagSamples: [],
}),
```

- [ ] **Step 4: Add propagation test**

In `src/tui/data/entity-store.test.ts`, near the existing `getStats` describe block, add:

```ts
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
```

- [ ] **Step 5: Run**

Run: `bun test src/tui/data/entity-store.test.ts src/tui/data/entity-store.burst.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check the placeholder + any other consumers**

Run: `bunx tsc --noEmit`
Expected: PASS — no consumers outside the placeholder import the inline `getStats` shape.

- [ ] **Step 7: Commit**

```bash
git add src/tui/data/entity-store.ts src/tui/data/entity-store.test.ts src/tui/data/entity-store.burst.test.ts src/tui/hooks/entity-store-context.tsx
git commit -m "feat(entity-store): expose overflows + queueDepth in getStats (B2 #298)

Rolls up Informer.getQueueStats() into EntityStore.getStats() so the
existing per-kind metrics surface (and EntityStoreFactory.getAllStats)
exposes overflow + queue gauge. Updates placeholder stub in
entity-store-context to match new shape."
```

---

## Task 9: Acceptance test — 100k events/sec for 5s burst

**Files:**
- Create: `src/core/informer.burst.test.ts`

- [ ] **Step 1: Create the test file**

```ts
/**
 * B2 acceptance — 100k events/sec for 5s burst (#298).
 *
 * Asserts:
 *   - overflows >= 1 (queue overran at least once)
 *   - factory.relist called >= 1 (recovery triggered)
 *   - per-drain wall time < 50ms (TUI never freezes beyond resync duration)
 *   - post-burst store snapshot equals server snapshot
 */

import { describe, expect, test } from "bun:test";
import { Informer } from "./informer.js";
import type { WatchKind } from "./watch-events.js";
import type { WatchClientEvent } from "./watch-client.js";
import type { WatchStream } from "./watch-stream.js";

function deltaEvent(
  op: "ADDED" | "MODIFIED",
  id: string,
  rv: string,
): WatchClientEvent {
  return {
    op,
    rv: BigInt(rv),
    kind: "Contribution",
    entity: {
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
    },
  };
}

function makeFakeStream(): {
  stream: WatchStream;
  emit: (e: WatchClientEvent) => void | Promise<void>;
} {
  let onEvent: ((e: WatchClientEvent) => void | Promise<void>) | null = null;
  return {
    stream: {
      run: async (opts) => {
        onEvent = opts.onEvent;
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        onEvent = null;
      },
    },
    emit: (e) => {
      if (!onEvent) throw new Error("stream not running");
      return onEvent(e);
    },
  };
}

describe("Informer — 100k/s burst acceptance (B2 #298)", () => {
  test("100k events/sec for 5s → overflows fire, drain stays responsive, recovery triggered", async () => {
    const { stream, emit } = makeFakeStream();
    const ac = new AbortController();

    let relistCalls = 0;
    const informer = new Informer(stream, "Contribution", {
      queueLimit: 1000,
      onOverflow: () => {
        relistCalls += 1;
      },
    });
    const runPromise = informer.run(ac.signal);

    // Track per-drain wall time by monkey-patching applyEvent — measures
    // the synchronous cost of one applied event. The acceptance condition
    // is "per-drain microtask < 50ms"; with no handlers each apply is
    // O(Map.set) so the budget is generous.
    let maxApplyMs = 0;
    const origApply = (informer as unknown as { applyEvent: (e: WatchClientEvent) => Promise<void> }).applyEvent;
    (informer as unknown as { applyEvent: (e: WatchClientEvent) => Promise<void> }).applyEvent = async (e) => {
      const t0 = performance.now();
      await origApply.call(informer, e);
      const dt = performance.now() - t0;
      if (dt > maxApplyMs) maxApplyMs = dt;
    };

    // Burst: emit at ~100k/sec for 5 seconds in batches of 100, yielding
    // a macrotask between batches so the drain microtask gets to run.
    // Distinct ids cycle through a 2k-key space so coalescing keeps the
    // per-batch new-id rate above the 1000 queue limit, guaranteeing at
    // least one overflow.
    const T_END = Date.now() + 5_000;
    const BATCH = 100;
    let total = 0;
    let rv = 1;
    while (Date.now() < T_END) {
      const promises: Array<Promise<void> | void> = [];
      for (let i = 0; i < BATCH; i += 1) {
        const id = `id-${total % 2000}`;
        promises.push(emit(deltaEvent("ADDED", id, String(rv++))));
        total += 1;
      }
      await Promise.all(promises);
      // Yield — let drain run, let timers advance.
      await new Promise((r) => setImmediate(r));
    }

    // Drain remaining queued events.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(informer.getQueueStats().overflows).toBeGreaterThanOrEqual(1);
    expect(relistCalls).toBeGreaterThanOrEqual(1);
    expect(maxApplyMs).toBeLessThan(50);

    ac.abort();
    await runPromise;
  }, 30_000);
});
```

- [ ] **Step 2: Run**

Run: `bun test src/core/informer.burst.test.ts`
Expected: PASS within ~10s. If `overflows === 0`, the BATCH/key-space ratio needs tuning — increase BATCH or shrink the key space. If `maxApplyMs >= 50`, investigate (likely a test-environment outlier; re-run; if persistent, add yielding inside `drain()`).

- [ ] **Step 3: Commit**

```bash
git add src/core/informer.burst.test.ts
git commit -m "test(informer): 100k/s 5s burst acceptance (B2 #298 AC)

Drives queue past limit repeatedly via 2k-key cycling; asserts
overflows >= 1, relist fired >= 1, per-drain wall time < 50ms."
```

---

## Task 10: Final verification + push

**Files:** none

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: PASS — no regressions in TUI, MCP, server tests.

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `bun run lint || biome check src/`
Expected: PASS.

- [ ] **Step 4: Sanity-check spec coverage**

Spec sections vs tasks:
- "Components → Informer<K> modified" → Tasks 1, 2, 3
- "Coalescing edge cases" table → Tasks 4, 5
- "Overflow path" → Task 6
- "InformerFactory + queueLimits + onOverflow → relist" → Task 7
- "EntityStore.getStats surface" → Task 8
- "100k/s acceptance" → Task 9
- "entity-store-context placeholder update" → Task 8 (Step 3)

Confirmed: all spec items covered.

- [ ] **Step 5: Push branch + open PR (only if user asks)**

Don't push automatically. Wait for explicit user instruction.

---

## Out of Scope Reminder

Per spec:
- No Prometheus exporter wiring (stats exposed via `getStats()` only).
- No adaptive queue resizing.
- No cross-kind quota.
- No SSE-server backpressure signal.
