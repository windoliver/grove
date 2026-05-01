# A8 — PR1 (Infra) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the infrastructure that lets `src/tui` views consume the informer cache reactively (no polling), without changing any call site. Ship dark — every existing `usePolledData` caller keeps working unchanged.

**Architecture:** Extract a `WatchStream` interface implemented by both the existing remote `WatchClient` (HTTP/SSE) and a new in-process `LocalWatchClient` (subscribes to a process-local `WatchHub`). Refactor `Informer`/`InformerFactory` to take a `WatchStream` and add a discriminated-union option shape selecting remote vs. local. Add a React `InformerProvider` plus three hooks (`useEntities`, `useEntity`, `useDerived`). A contract-test fixture proves both `WatchStream` backends produce the same event sequence. `main.ts` wires the factory and provider but no view uses the new hooks yet — call-site migration is PR2-PR4.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Bun test runner (`bun:test`), React (OpenTUI, no DOM), existing `WatchHub` / `WatchClient` / `Informer` from `src/core/`.

**Spec:** `docs/superpowers/specs/2026-04-30-retire-polling-a8-design.md`. Issue #295. Depends on #294 (closed).

**Out of scope for PR1:**
- Any `usePolledData` call-site swap (PR2-PR4).
- Local-store → `WatchHub.recordWrite` wiring (PR2 lands this when the first kind needs it).
- `setInterval` removal in `src/tui/main.ts` (PR5).
- Producer-side events for vfs / terminal (PR4).

---

## File structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/core/watch-stream.ts` | `WatchStream` interface + re-exports of `WatchClientEvent` for callers. |
| `src/core/local-watch-client.ts` | `LocalWatchClient` class — implements `WatchStream` over a process-local `WatchHub` and a snapshot `listFn`. |
| `src/core/local-watch-client.test.ts` | Unit tests for `LocalWatchClient` against a hand-rolled fake hub. |
| `src/core/watch-stream.contract.test.ts` | Parameterized contract suite — same assertions over `WatchClient` (with fake fetch) and `LocalWatchClient` (with fake hub). |
| `src/tui/hooks/informer-context.tsx` | `<InformerProvider>` + `useInformer<K>(kind)` accessor. |
| `src/tui/hooks/use-entities.ts` | `useEntities(kind, predicate?)` hook + pure `computeFilteredEntities` and `shallowArraysEqual` helpers. |
| `src/tui/hooks/use-entities.test.ts` | Tests for the pure helpers. |
| `src/tui/hooks/use-entity.ts` | `useEntity(kind, id)` hook + pure `selectEntityById` helper. |
| `src/tui/hooks/use-entity.test.ts` | Tests for the pure helper. |
| `src/tui/hooks/use-derived.ts` | `useDerived(compute, kinds, equals?)` hook + pure `derivedReducer` helper. |
| `src/tui/hooks/use-derived.test.ts` | Tests for the pure helper. |
| `src/tui/hooks/refresh-context.tsx` | New `RefreshProvider` wired to `factory.relist()`. Replaces the old `useRefreshSignal` for new callers; old signal stays in tree for PR1. |

**Modified files:**

| Path | Change |
|---|---|
| `src/core/informer.ts` | `Informer` constructor takes a `WatchStream`. `InformerFactory` becomes a discriminated-union of `{ mode: "remote", ... }` / `{ mode: "local", ... }`. Add `factory.relist(kind?)`. Public `informerFor(kind)` API unchanged. |
| `src/core/informer.test.ts` | Update test setup to construct `WatchClient` explicitly and pass it to `Informer`, OR continue to construct via the remote factory. |
| `src/core/watch-client.ts` | Implement `WatchStream` interface (declarative — already has the `run({ onEvent, signal })` shape; just add `implements WatchStream`). |
| `src/tui/main.ts` | At boot: build `InformerFactory` from env (remote or local), eagerly start all 3 informers, render `<InformerProvider>` and `<RefreshProvider>` around the React tree. **No** view changes. **No** `setInterval` changes. |

**Untouched in PR1:**

- `src/tui/hooks/use-polled-data.ts`, `use-panel-state.ts`, `use-refresh-context.ts` — stay; PR5 deletes them.
- All view files (`src/tui/views/`, `src/tui/screens/`, `src/tui/panels/`) — untouched. Call-site migration is PR2-PR4.
- `src/tui/main.ts` `setInterval`s — stay; PR5 moves them.

---

## Tasks

### Task 1: Define the `WatchStream` interface

**Files:**
- Create: `src/core/watch-stream.ts`

- [ ] **Step 1: Write `watch-stream.ts`**

```ts
/**
 * WatchStream — common contract implemented by remote (HTTP/SSE) and
 * in-process watch clients. Consumed by Informer (#294) so the cache
 * layer can be backend-agnostic.
 */

import type { WatchClientEvent } from "./watch-client.js";

export interface WatchStream {
  run(opts: {
    onEvent: (e: WatchClientEvent) => void | Promise<void>;
    signal: AbortSignal;
  }): Promise<void>;
}

export type { WatchClientEvent };
```

- [ ] **Step 2: Add `implements WatchStream` to `WatchClient`**

In `src/core/watch-client.ts`, change:

```ts
export class WatchClient {
```

to:

```ts
import type { WatchStream } from "./watch-stream.js";
// ...
export class WatchClient implements WatchStream {
```

(`WatchClient.run` already has the matching signature — this is purely declarative.)

- [ ] **Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: clean (no new errors).

- [ ] **Step 4: Commit**

```bash
git add src/core/watch-stream.ts src/core/watch-client.ts
git commit -m "feat(core): extract WatchStream interface, implement on WatchClient"
```

---

### Task 2: Build `LocalWatchClient` (TDD)

**Files:**
- Create: `src/core/local-watch-client.ts`
- Create: `src/core/local-watch-client.test.ts`

`LocalWatchClient` mimics `WatchClient.run`'s event sequence but reads from an in-process `WatchHub` instead of HTTP/SSE. Sequence per `run()` invocation:

1. Capture `currentRv` from the hub (the snapshot boundary).
2. Subscribe to the hub from `currentRv` (live deltas; arrives async via `AsyncIterable<WatchEvent>`).
3. Emit `RELIST_BEGIN { rv: currentRv }`.
4. For each entity from `listFn()`, emit `RELIST { rv: currentRv, entity }`.
5. Emit `RELIST_END { rv: currentRv }`.
6. Loop the subscription; for each `WatchEvent`, emit `{ op: e.op, rv: e.rv, kind: e.kind, entity: e.entity }` to `onEvent`.
7. On abort: stop the loop, return.

Note: `WatchHub.subscribe` rejects `fromRv > currentRv`. We capture `currentRv` first, then subscribe from that exact value, so we get only events strictly after the snapshot.

Boundary events have `entity: null` to match remote `WatchClient` semantics.

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/local-watch-client.test.ts
import { describe, expect, test } from "bun:test";
import { LocalWatchClient } from "./local-watch-client.js";
import { WatchHub } from "./watch-hub.js";
import type { WatchClientEvent } from "./watch-client.js";
import type { WatchEntity } from "./watch-events.js";

const NS = "default";

function mkContribution(id: string, rv: string): WatchEntity {
  return {
    kind: "Contribution",
    namespace: NS,
    id,
    spec: {
      contributionKind: "code",
      mode: "direct",
      summary: id,
      artifacts: {},
      relations: [],
      tags: [],
    },
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: rv,
    metadata: { generation: 1 },
  } as unknown as WatchEntity;
}

describe("LocalWatchClient", () => {
  test("emits RELIST_BEGIN, one RELIST per snapshot entity, then RELIST_END", async () => {
    const hub = new WatchHub();
    const e1 = mkContribution("a", "1");
    const e2 = mkContribution("b", "1");
    const events: WatchClientEvent[] = [];
    const ac = new AbortController();

    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: NS,
      listFn: () => [e1, e2],
    });

    const runPromise = client.run({
      onEvent: (e) => {
        events.push(e);
        if (e.op === "RELIST_END") ac.abort();
      },
      signal: ac.signal,
    });
    await runPromise;

    expect(events.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST", "RELIST", "RELIST_END"]);
    expect(events[1]?.entity?.id).toBe("a");
    expect(events[2]?.entity?.id).toBe("b");
    expect(events[0]?.entity).toBeNull();
    expect(events[3]?.entity).toBeNull();
  });

  test("emits live deltas after RELIST_END", async () => {
    const hub = new WatchHub();
    const events: WatchClientEvent[] = [];
    const ac = new AbortController();

    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: NS,
      listFn: () => [],
    });

    const runPromise = client.run({
      onEvent: (e) => {
        events.push(e);
        if (e.op === "ADDED") ac.abort();
      },
      signal: ac.signal,
    });

    // Wait one microtask so the client has emitted RELIST_BEGIN/END before we publish.
    await Promise.resolve();
    await Promise.resolve();
    hub.recordWrite({
      op: "ADDED",
      kind: "Contribution",
      namespace: NS,
      entity: mkContribution("a", "1"),
    });
    await runPromise;

    const ops = events.map((e) => e.op);
    expect(ops).toEqual(["RELIST_BEGIN", "RELIST_END", "ADDED"]);
    expect(events[2]?.entity?.id).toBe("a");
  });

  test("respects pre-aborted signal — no events emitted", async () => {
    const hub = new WatchHub();
    const events: WatchClientEvent[] = [];
    const ac = new AbortController();
    ac.abort();

    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: NS,
      listFn: () => [mkContribution("a", "1")],
    });

    await client.run({
      onEvent: (e) => events.push(e),
      signal: ac.signal,
    });

    expect(events).toEqual([]);
  });

  test("captures currentRv before listing — events written between capture and subscribe replay correctly", async () => {
    const hub = new WatchHub();
    // Pre-existing event in hub before run() starts.
    hub.recordWrite({
      op: "ADDED",
      kind: "Contribution",
      namespace: NS,
      entity: mkContribution("pre", "1"),
    });

    const events: WatchClientEvent[] = [];
    const ac = new AbortController();
    const client = new LocalWatchClient({
      hub,
      kind: "Contribution",
      namespace: NS,
      listFn: () => [mkContribution("a", "1")],
    });

    const runPromise = client.run({
      onEvent: (e) => {
        events.push(e);
        if (e.op === "RELIST_END") ac.abort();
      },
      signal: ac.signal,
    });
    await runPromise;

    // No replay of the pre-snapshot event — listFn is the source of truth at snapshot time.
    expect(events.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST", "RELIST_END"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/local-watch-client.test.ts`
Expected: FAIL with "Cannot find module './local-watch-client.js'" or similar.

- [ ] **Step 3: Implement `LocalWatchClient`**

```ts
// src/core/local-watch-client.ts
/**
 * LocalWatchClient — in-process WatchStream backend (#295).
 *
 * Reads a snapshot from `listFn` and subscribes to a process-local
 * WatchHub for deltas. Emits the same RELIST_BEGIN → RELIST* → RELIST_END
 * → live-delta sequence as the remote WatchClient so consumers (Informer)
 * can be backend-agnostic.
 *
 * Local mode (no Nexus) wires this against per-store snapshots; the stores
 * themselves call `hub.recordWrite` on each write. Remote mode keeps using
 * the HTTP-based WatchClient.
 */

import type { WatchClientEvent } from "./watch-client.js";
import { WatchHub } from "./watch-hub.js";
import type { WatchEntity, WatchKind } from "./watch-events.js";
import type { WatchStream } from "./watch-stream.js";

export interface LocalWatchClientOptions {
  readonly hub: WatchHub;
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly listFn: () => readonly WatchEntity[];
}

export class LocalWatchClient implements WatchStream {
  private readonly hub: WatchHub;
  private readonly kind: WatchKind;
  private readonly namespace: string;
  private readonly listFn: () => readonly WatchEntity[];

  constructor(opts: LocalWatchClientOptions) {
    this.hub = opts.hub;
    this.kind = opts.kind;
    this.namespace = opts.namespace;
    this.listFn = opts.listFn;
  }

  async run(opts: {
    onEvent: (e: WatchClientEvent) => void | Promise<void>;
    signal: AbortSignal;
  }): Promise<void> {
    const { onEvent, signal } = opts;
    if (signal.aborted) return;

    // Capture the watch RV at the snapshot boundary, BEFORE listFn executes.
    // The hub's subscribe() will replay everything strictly after this RV,
    // so any write that happens after capture is delivered as a live delta.
    const snapshotRv = this.hub.currentRv(this.namespace, this.kind);

    // Subscribe BEFORE emitting RELIST events so we don't miss writes that
    // race the snapshot. The hub buffers events into the subscriber's queue
    // until the consumer iterates.
    const stream = this.hub.subscribe(this.namespace, this.kind, snapshotRv, signal);

    // Emit the snapshot.
    await onEvent({
      op: "RELIST_BEGIN",
      rv: snapshotRv,
      kind: this.kind,
      entity: null,
    });
    if (signal.aborted) return;

    for (const entity of this.listFn()) {
      await onEvent({
        op: "RELIST",
        rv: snapshotRv,
        kind: this.kind,
        entity,
      });
      if (signal.aborted) return;
    }

    await onEvent({
      op: "RELIST_END",
      rv: snapshotRv,
      kind: this.kind,
      entity: null,
    });
    if (signal.aborted) return;

    // Drain live deltas. The async iterator returns when the abort signal fires.
    try {
      for await (const event of stream) {
        if (signal.aborted) return;
        await onEvent({
          op: event.op,
          rv: event.rv,
          kind: event.kind,
          entity: event.entity,
        });
      }
    } catch (err) {
      // Hub buffer overflow (unlikely in-process) — surface as RELIST_ABORTED so
      // the Informer can drop the snapshot in flight; not relevant here since
      // we're already past RELIST_END, so just rethrow for the caller's run loop.
      if (!signal.aborted) throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/local-watch-client.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/local-watch-client.ts src/core/local-watch-client.test.ts
git commit -m "feat(core): add LocalWatchClient — in-process WatchStream over WatchHub"
```

---

### Task 3: Refactor `Informer` to accept a `WatchStream`

**Files:**
- Modify: `src/core/informer.ts`
- Modify: `src/core/informer.test.ts`

Currently `Informer` takes `WatchClientOptions` and constructs its own `WatchClient`. Decouple it so callers inject any `WatchStream`. Keep `InformerFactory` working with the same public `informerFor(kind)` API.

- [ ] **Step 1: Change `Informer` constructor to take a `WatchStream`**

In `src/core/informer.ts`, replace the existing class header and constructor:

```ts
import type { WatchStream } from "./watch-stream.js";
// ... existing imports remain

export class Informer<K extends WatchKind = WatchKind> {
  private readonly stream: WatchStream;
  private readonly store = new Map<string, EntityForKind<K>>();
  private readonly handlers: Array<EventHandlerFn<K>> = [];
  private _synced = false;
  private staging: Map<string, EntityForKind<K>> | null = null;
  private _running = false;
  private _signal: AbortSignal | null = null;

  constructor(stream: WatchStream) {
    this.stream = stream;
  }

  // ... addEventHandler, hasSynced, getById, list unchanged
```

Replace the existing `run()`:

```ts
async run(signal: AbortSignal): Promise<void> {
  if (this._running) {
    throw new Error(
      "Informer.run() called while already running; only one concurrent run is allowed",
    );
  }
  this._running = true;
  this._signal = signal;
  try {
    await this.stream.run({ onEvent: (e) => this.onEvent(e), signal });
  } finally {
    this._signal = null;
    this._running = false;
  }
}
```

Delete the import of `WatchClient` from `informer.ts` (no longer used inside the class).

- [ ] **Step 2: Update `InformerFactory` to a discriminated-union options shape**

Replace the existing `InformerFactoryOptions` and `InformerFactory` class:

```ts
import { WatchClient, type WatchClientOptions } from "./watch-client.js";
import { LocalWatchClient } from "./local-watch-client.js";
import type { WatchHub } from "./watch-hub.js";

export type Backoff = NonNullable<WatchClientOptions["backoff"]>;

export type InformerFactoryOptions =
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
      readonly listFn: (kind: WatchKind) => readonly WatchEntity[];
      readonly backoff?: Backoff;
    };

interface RunningInformer {
  readonly informer: Informer;
  controller: AbortController;
  runPromise: Promise<void> | null;
}

export class InformerFactory {
  private readonly opts: InformerFactoryOptions;
  private readonly running = new Map<string, RunningInformer>();

  constructor(opts: InformerFactoryOptions) {
    this.opts = opts;
  }

  /**
   * Returns the Informer for a kind. Lazily constructs it on first call,
   * but does NOT start `run()` — call `startAll()` (or rely on it being
   * called by the app's boot sequence) to start watching.
   */
  informerFor<K extends WatchKind>(kind: K): Informer<K> {
    const existing = this.running.get(kind);
    if (existing) return existing.informer as Informer<K>;
    const stream = this.makeStream(kind);
    const informer = new Informer<K>(stream);
    this.running.set(kind, {
      informer: informer as Informer,
      controller: new AbortController(),
      runPromise: null,
    });
    return informer;
  }

  /**
   * Start `run()` on all 3 known kinds. Idempotent — calling on an already-
   * started kind is a no-op. Caller is responsible for calling `stop()`
   * (or aborting the parent signal) on shutdown.
   */
  startAll(): void {
    for (const kind of ALL_KINDS) {
      this.startKind(kind);
    }
  }

  /**
   * Abort all running informers. After this returns, the run() promises have
   * settled and the factory is reusable (caller can startAll() again).
   */
  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const r of this.running.values()) {
      r.controller.abort();
      if (r.runPromise) promises.push(r.runPromise.catch(() => undefined));
    }
    await Promise.all(promises);
  }

  /**
   * Force a relist on a single kind (or all kinds when undefined). Aborts the
   * current run, awaits its settlement, then starts a new run with a fresh
   * AbortController. Intended for the global `r`-key refresh.
   */
  async relist(kind?: WatchKind): Promise<void> {
    const kinds: WatchKind[] = kind ? [kind] : [...ALL_KINDS];
    for (const k of kinds) {
      const r = this.running.get(k);
      if (!r) continue;
      r.controller.abort();
      if (r.runPromise) await r.runPromise.catch(() => undefined);
      r.controller = new AbortController();
      r.runPromise = null;
      this.startKind(k);
    }
  }

  private startKind(kind: WatchKind): void {
    const r = this.running.get(kind) ?? this.bootKind(kind);
    if (r.runPromise) return; // already running
    r.runPromise = r.informer.run(r.controller.signal);
  }

  private bootKind(kind: WatchKind): RunningInformer {
    this.informerFor(kind);
    const r = this.running.get(kind);
    if (!r) throw new Error(`unreachable: informerFor(${kind}) did not register a running entry`);
    return r;
  }

  private makeStream(kind: WatchKind): WatchStream {
    if (this.opts.mode === "remote") {
      const clientOpts: WatchClientOptions = {
        baseUrl: this.opts.baseUrl,
        kind,
        authHeader: this.opts.authHeader,
        ...(this.opts.fetch !== undefined ? { fetch: this.opts.fetch } : {}),
        ...(this.opts.backoff !== undefined ? { backoff: this.opts.backoff } : {}),
      };
      return new WatchClient(clientOpts);
    }
    return new LocalWatchClient({
      hub: this.opts.hub,
      kind,
      namespace: this.opts.namespace,
      listFn: () => this.opts.listFn(kind),
    });
  }
}

const ALL_KINDS: readonly WatchKind[] = ["Contribution", "Claim", "AgentSession"];
```

- [ ] **Step 3: Update existing `informer.test.ts` to construct streams explicitly**

The existing tests construct `Informer` with `WatchClientOptions`. Update each construction site to create a `WatchClient` and pass it:

Find blocks like:

```ts
const informer = new Informer({
  baseUrl: "http://t",
  kind: "Contribution",
  authHeader: "Bearer x",
  fetch: fetchImpl,
  backoff: { minMs: 0, maxMs: 0, jitter: 0 },
});
```

Replace with:

```ts
const informer = new Informer(
  new WatchClient({
    baseUrl: "http://t",
    kind: "Contribution",
    authHeader: "Bearer x",
    fetch: fetchImpl,
    backoff: { minMs: 0, maxMs: 0, jitter: 0 },
  }),
);
```

Add `import { WatchClient } from "./watch-client.js";` at the top of `informer.test.ts`.

For tests that exercise `InformerFactory`, update the construction:

```ts
// Before:
const factory = new InformerFactory({ baseUrl: "...", authHeader: "..." });

// After:
const factory = new InformerFactory({ mode: "remote", baseUrl: "...", authHeader: "..." });
```

- [ ] **Step 4: Run informer tests to verify they pass**

Run: `bun test src/core/informer.test.ts`
Expected: all existing tests pass.

- [ ] **Step 5: Run full typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/informer.ts src/core/informer.test.ts
git commit -m "refactor(core): Informer takes WatchStream; InformerFactory gains mode + relist"
```

---

### Task 4: Contract test fixture for `WatchStream`

**Files:**
- Create: `src/core/watch-stream.contract.test.ts`

Same assertions over both backends. Catches drift between `WatchClient` and `LocalWatchClient`.

- [ ] **Step 1: Write the contract test**

```ts
// src/core/watch-stream.contract.test.ts
import { describe, expect, test } from "bun:test";
import type { WatchClientEvent } from "./watch-client.js";
import { WatchClient } from "./watch-client.js";
import { LocalWatchClient } from "./local-watch-client.js";
import { WatchHub } from "./watch-hub.js";
import type { WatchEntity, WatchKind } from "./watch-events.js";
import type { WatchStream } from "./watch-stream.js";

const NS = "default";
const KIND: WatchKind = "Contribution";

function mkEntity(id: string, rv: string): WatchEntity {
  return {
    kind: "Contribution",
    namespace: NS,
    id,
    spec: {
      contributionKind: "code",
      mode: "direct",
      summary: id,
      artifacts: {},
      relations: [],
      tags: [],
    },
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: rv,
    metadata: { generation: 1 },
  } as unknown as WatchEntity;
}

interface Backend {
  readonly name: string;
  readonly stream: WatchStream;
  readonly publishLive: (entity: WatchEntity) => void;
}

function localBackend(snapshot: readonly WatchEntity[]): Backend {
  const hub = new WatchHub();
  const stream = new LocalWatchClient({
    hub,
    kind: KIND,
    namespace: NS,
    listFn: () => snapshot,
  });
  return {
    name: "LocalWatchClient",
    stream,
    publishLive: (entity) => {
      hub.recordWrite({ op: "ADDED", kind: KIND, namespace: NS, entity });
    },
  };
}

function sse(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function remoteBackend(snapshot: readonly WatchEntity[], live: readonly WatchEntity[]): Backend {
  const list = { items: [...snapshot], listResourceVersion: "0" };
  let body = "";
  let rv = 1n;
  for (const e of live) {
    body += sse("ADDED", { rv: String(rv), op: "ADDED", kind: KIND, entity: e }, String(rv));
    rv += 1n;
  }
  const ac = new AbortController();
  let watchCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/list")) {
      return new Response(JSON.stringify(list), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/watch")) {
      watchCalls += 1;
      if (watchCalls === 1) {
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      ac.abort();
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const stream = new WatchClient({
    baseUrl: "http://t",
    kind: KIND,
    authHeader: "Bearer x",
    fetch: fetchImpl,
    backoff: { minMs: 0, maxMs: 0, jitter: 0 },
  });
  return {
    name: "WatchClient (remote, fake fetch)",
    stream,
    publishLive: () => {
      throw new Error("remote backend's live events are pre-baked into the SSE body");
    },
  };
}

describe("WatchStream contract", () => {
  for (const make of [
    () => localBackend([mkEntity("a", "1"), mkEntity("b", "1")]),
    () => remoteBackend([mkEntity("a", "1"), mkEntity("b", "1")], []),
  ]) {
    const backend = make();

    test(`${backend.name}: snapshot order = BEGIN, RELIST*, END`, async () => {
      const events: WatchClientEvent[] = [];
      const ac = new AbortController();
      const runPromise = backend.stream.run({
        onEvent: (e) => {
          events.push(e);
          if (e.op === "RELIST_END") ac.abort();
        },
        signal: ac.signal,
      });
      await runPromise.catch(() => undefined);

      expect(events.map((e) => e.op)).toEqual([
        "RELIST_BEGIN",
        "RELIST",
        "RELIST",
        "RELIST_END",
      ]);
      expect(events[0]?.entity).toBeNull();
      expect(events[3]?.entity).toBeNull();
    });
  }

  test("LocalWatchClient: live ADDED arrives after RELIST_END", async () => {
    const backend = localBackend([]);
    const events: WatchClientEvent[] = [];
    const ac = new AbortController();
    const run = backend.stream.run({
      onEvent: (e) => {
        events.push(e);
        if (e.op === "ADDED") ac.abort();
      },
      signal: ac.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    backend.publishLive(mkEntity("live-a", "1"));
    await run;
    expect(events.map((e) => e.op)).toEqual(["RELIST_BEGIN", "RELIST_END", "ADDED"]);
  });
});
```

- [ ] **Step 2: Run the contract test**

Run: `bun test src/core/watch-stream.contract.test.ts`
Expected: all tests pass for both backends.

- [ ] **Step 3: Commit**

```bash
git add src/core/watch-stream.contract.test.ts
git commit -m "test(core): contract suite proves WatchStream parity for remote and local"
```

---

### Task 5: `InformerProvider` + `useInformer`

**Files:**
- Create: `src/tui/hooks/informer-context.tsx`

- [ ] **Step 1: Write `informer-context.tsx`**

```tsx
/**
 * InformerProvider — supplies an InformerFactory to React subscribers.
 *
 * Eager startAll() at provider mount, stopAll() on unmount. All hooks
 * (useEntities, useEntity, useDerived) consume the factory through this
 * context. Throws when used outside the provider.
 */

import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { InformerFactory } from "../../core/informer.js";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";

const InformerContext = createContext<InformerFactory | null>(null);

export interface InformerProviderProps {
  readonly value: InformerFactory;
  readonly children: ReactNode;
}

export function InformerProvider(props: InformerProviderProps): ReactNode {
  const { value, children } = props;
  useEffect(() => {
    value.startAll();
    return () => {
      void value.stopAll();
    };
  }, [value]);
  return <InformerContext.Provider value={value}>{children}</InformerContext.Provider>;
}

export function useInformerFactory(): InformerFactory {
  const factory = useContext(InformerContext);
  if (!factory) {
    throw new Error("useInformer*: must be called inside <InformerProvider>");
  }
  return factory;
}

export function useInformer<K extends WatchKind>(kind: K): Informer<K> {
  return useInformerFactory().informerFor(kind);
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/informer-context.tsx
git commit -m "feat(tui): InformerProvider + useInformer context"
```

---

### Task 6: `useEntities` hook + pure helpers

**Files:**
- Create: `src/tui/hooks/use-entities.ts`
- Create: `src/tui/hooks/use-entities.test.ts`

Hook tests in this codebase test pure logic (no React renderer). Extract two helpers into the module: `computeFilteredEntities` (apply optional predicate, return identity-stable array if predicate is undefined) and `shallowArraysEqual` (length + per-index `Object.is`). Test those. The hook itself is a thin wrapper.

- [ ] **Step 1: Write the failing tests**

```ts
// src/tui/hooks/use-entities.test.ts
import { describe, expect, test } from "bun:test";
import { computeFilteredEntities, shallowArraysEqual } from "./use-entities.js";

describe("shallowArraysEqual", () => {
  test("identical references → true", () => {
    const a = [1, 2, 3];
    expect(shallowArraysEqual(a, a)).toBe(true);
  });

  test("different lengths → false", () => {
    expect(shallowArraysEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  test("same elements in same order → true", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    expect(shallowArraysEqual([a, b], [a, b])).toBe(true);
  });

  test("same length, different element identity → false", () => {
    expect(shallowArraysEqual([{ id: "a" }], [{ id: "a" }])).toBe(false);
  });

  test("NaN handled by Object.is", () => {
    expect(shallowArraysEqual([Number.NaN], [Number.NaN])).toBe(true);
  });
});

describe("computeFilteredEntities", () => {
  const e1 = { id: "a" } as unknown as { id: string };
  const e2 = { id: "b" } as unknown as { id: string };

  test("undefined predicate returns the input array reference", () => {
    const list = [e1, e2];
    expect(computeFilteredEntities(list, undefined)).toBe(list);
  });

  test("predicate filters", () => {
    const out = computeFilteredEntities([e1, e2], (e) => e.id === "a");
    expect(out).toEqual([e1]);
  });

  test("predicate that throws is propagated to caller", () => {
    const boom = (): boolean => {
      throw new Error("boom");
    };
    expect(() => computeFilteredEntities([e1], boom)).toThrow("boom");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/hooks/use-entities.test.ts`
Expected: FAIL with "Cannot find module" / "is not a function".

- [ ] **Step 3: Implement helpers + hook**

```ts
// src/tui/hooks/use-entities.ts
/**
 * useEntities — reactive filtered list view over the informer cache.
 *
 * Subscribes to the named kind's informer once per consumer; recomputes
 * the filtered list on every event; commits a new array reference only
 * when the filtered slice actually changed (shallow equality).
 *
 * Pure helpers below are exported for unit tests; the React hook is a
 * thin wrapper around them.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useInformer } from "./informer-context.js";

type EntityFor<I extends Informer> = I extends Informer<infer K>
  ? ReturnType<I["list"]>[number]
  : never;

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

export function useEntities<K extends WatchKind>(
  kind: K,
  predicate?: (e: ReturnType<Informer<K>["list"]>[number]) => boolean,
): UseEntitiesResult<ReturnType<Informer<K>["list"]>[number]> {
  type E = ReturnType<Informer<K>["list"]>[number];
  const informer = useInformer(kind);
  const predicateRef = useRef(predicate);
  predicateRef.current = predicate;

  const initial = useMemo<readonly E[]>(() => {
    try {
      return computeFilteredEntities(informer.list() as readonly E[], predicateRef.current);
    } catch {
      return [];
    }
  }, [informer]);

  const [data, setData] = useState<readonly E[]>(initial);
  const [hasSynced, setHasSynced] = useState<boolean>(informer.hasSynced());
  const [error, setError] = useState<Error | null>(null);
  const dataRef = useRef<readonly E[]>(initial);
  dataRef.current = data;

  useEffect(() => {
    const unsub = informer.addEventHandler(() => {
      try {
        const next = computeFilteredEntities(informer.list() as readonly E[], predicateRef.current);
        if (!shallowArraysEqual(dataRef.current, next)) {
          setData(next);
        }
        if (!hasSynced && informer.hasSynced()) setHasSynced(true);
        if (error) setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return unsub;
  }, [informer, hasSynced, error]);

  return { data, hasSynced, error };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/hooks/use-entities.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-entities.ts src/tui/hooks/use-entities.test.ts
git commit -m "feat(tui): useEntities hook with shallow-equal output memo"
```

---

### Task 7: `useEntity` hook + pure helper

**Files:**
- Create: `src/tui/hooks/use-entity.ts`
- Create: `src/tui/hooks/use-entity.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/tui/hooks/use-entity.test.ts
import { describe, expect, test } from "bun:test";
import { selectEntityById } from "./use-entity.js";
import type { Informer } from "../../core/informer.js";

function fakeInformer<E extends { id: string }>(items: readonly E[]): Informer {
  return {
    list: () => items,
    getById: (id: string) => items.find((i) => i.id === id),
    hasSynced: () => true,
    addEventHandler: () => () => undefined,
  } as unknown as Informer;
}

describe("selectEntityById", () => {
  test("undefined id returns undefined and never calls getById", () => {
    let calls = 0;
    const inf = {
      ...fakeInformer([{ id: "a" }]),
      getById: (id: string) => {
        calls += 1;
        return undefined;
      },
    } as unknown as Informer;
    expect(selectEntityById(inf, undefined)).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("id present in cache returns the entity", () => {
    const a = { id: "a" };
    const inf = fakeInformer([a]);
    expect(selectEntityById(inf, "a")).toBe(a);
  });

  test("id absent returns undefined", () => {
    const inf = fakeInformer<{ id: string }>([{ id: "a" }]);
    expect(selectEntityById(inf, "missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/hooks/use-entity.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement helper + hook**

```ts
// src/tui/hooks/use-entity.ts
/**
 * useEntity — reactive single-record subscription over the informer cache.
 *
 * Subscribes to the named kind, but the handler ignores events whose
 * entity id ≠ id, avoiding re-render churn for unrelated changes.
 */

import { useEffect, useState } from "react";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useInformer } from "./informer-context.js";

export function selectEntityById<I extends Informer>(
  informer: I,
  id: string | undefined,
): ReturnType<I["getById"]> | undefined {
  if (id === undefined) return undefined;
  return informer.getById(id) as ReturnType<I["getById"]>;
}

export interface UseEntityResult<E> {
  readonly data: E | undefined;
  readonly hasSynced: boolean;
}

export function useEntity<K extends WatchKind>(
  kind: K,
  id: string | undefined,
): UseEntityResult<ReturnType<Informer<K>["getById"]> & ({} | undefined)> {
  type E = NonNullable<ReturnType<Informer<K>["getById"]>>;
  const informer = useInformer(kind);
  const [data, setData] = useState<E | undefined>(
    () => selectEntityById(informer, id) as E | undefined,
  );
  const [hasSynced, setHasSynced] = useState<boolean>(informer.hasSynced());

  useEffect(() => {
    if (id === undefined) {
      setData(undefined);
      return;
    }
    setData(selectEntityById(informer, id) as E | undefined);
    const unsub = informer.addEventHandler((_op, entity) => {
      if (entity.id !== id) return;
      setData(selectEntityById(informer, id) as E | undefined);
      if (!hasSynced && informer.hasSynced()) setHasSynced(true);
    });
    return unsub;
  }, [informer, id, hasSynced]);

  return { data, hasSynced };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/hooks/use-entity.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-entity.ts src/tui/hooks/use-entity.test.ts
git commit -m "feat(tui): useEntity hook for single-record subscription"
```

---

### Task 8: `useDerived` hook + pure helper

**Files:**
- Create: `src/tui/hooks/use-derived.ts`
- Create: `src/tui/hooks/use-derived.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/tui/hooks/use-derived.test.ts
import { describe, expect, test } from "bun:test";
import { stepDerived } from "./use-derived.js";

describe("stepDerived", () => {
  test("first compute success → data set, error null", () => {
    const next = stepDerived({ data: undefined, error: null }, () => 42);
    expect(next.data).toBe(42);
    expect(next.error).toBeNull();
    expect(next.committed).toBe(true);
  });

  test("compute returns same value (Object.is) → no commit", () => {
    const obj = { a: 1 };
    const next = stepDerived({ data: obj, error: null }, () => obj);
    expect(next.committed).toBe(false);
  });

  test("custom equals comparator → no commit when equal", () => {
    const next = stepDerived(
      { data: { a: 1 }, error: null },
      () => ({ a: 1 }),
      (a, b) => a.a === b.a,
    );
    expect(next.committed).toBe(false);
  });

  test("compute throws → error set, last data preserved", () => {
    const next = stepDerived({ data: 7, error: null }, () => {
      throw new Error("boom");
    });
    expect(next.data).toBe(7);
    expect(next.error?.message).toBe("boom");
    expect(next.committed).toBe(true); // error state changed
  });

  test("recovery: previous error cleared on success", () => {
    const next = stepDerived({ data: 7, error: new Error("old") }, () => 8);
    expect(next.data).toBe(8);
    expect(next.error).toBeNull();
    expect(next.committed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/hooks/use-derived.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement helper + hook**

```ts
// src/tui/hooks/use-derived.ts
/**
 * useDerived — reactive projection over one or more informers.
 *
 * Subscribes to every listed kind; recomputes `compute()` on any event
 * from any of them; commits a new state only when the output changed
 * (Object.is by default, caller-provided `equals` for non-trivial
 * shapes). Exceptions in `compute` set `error`; last-good `data`
 * is preserved.
 */

import { useEffect, useRef, useState } from "react";
import { useInformerFactory } from "./informer-context.js";
import type { WatchKind } from "../../core/watch-events.js";

export interface DerivedState<T> {
  readonly data: T | undefined;
  readonly error: Error | null;
}

export interface DerivedStep<T> extends DerivedState<T> {
  readonly committed: boolean;
}

export function stepDerived<T>(
  prev: DerivedState<T>,
  compute: () => T,
  equals: (a: T, b: T) => boolean = Object.is,
): DerivedStep<T> {
  try {
    const next = compute();
    if (prev.data !== undefined && equals(prev.data, next)) {
      if (prev.error === null) {
        return { data: prev.data, error: null, committed: false };
      }
      return { data: prev.data, error: null, committed: true };
    }
    return { data: next, error: null, committed: true };
  } catch (err) {
    return {
      data: prev.data,
      error: err instanceof Error ? err : new Error(String(err)),
      committed: true,
    };
  }
}

export interface UseDerivedResult<T> {
  readonly data: T | undefined;
  readonly hasSynced: boolean;
  readonly error: Error | null;
}

export function useDerived<T>(
  compute: () => T,
  kinds: readonly WatchKind[],
  equals: (a: T, b: T) => boolean = Object.is,
): UseDerivedResult<T> {
  const factory = useInformerFactory();
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const equalsRef = useRef(equals);
  equalsRef.current = equals;

  const [state, setState] = useState<DerivedState<T>>(() =>
    stepDerived<T>({ data: undefined, error: null }, () => computeRef.current()),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const informers = kinds.map((k) => factory.informerFor(k));
  const [hasSynced, setHasSynced] = useState<boolean>(() => informers.every((i) => i.hasSynced()));

  useEffect(() => {
    const tick = (): void => {
      const next = stepDerived<T>(
        stateRef.current,
        () => computeRef.current(),
        equalsRef.current,
      );
      if (next.committed) setState({ data: next.data, error: next.error });
      if (!hasSynced && informers.every((i) => i.hasSynced())) setHasSynced(true);
    };
    const unsubs = informers.map((i) => i.addEventHandler(tick));
    return () => {
      for (const u of unsubs) u();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factory, kinds.join(","), hasSynced]);

  return { data: state.data, hasSynced, error: state.error };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/hooks/use-derived.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-derived.ts src/tui/hooks/use-derived.test.ts
git commit -m "feat(tui): useDerived hook for cross-kind aggregates"
```

---

### Task 9: New `RefreshProvider` over `factory.relist`

**Files:**
- Create: `src/tui/hooks/refresh-context.tsx`

The existing `use-refresh-context.ts` broadcasts a numeric signal that `usePolledData` consumers listen to. New `RefreshProvider` wraps `factory.relist()` so the global `r`-key triggers a single relist across all kinds. The old context stays in PR1; PR5 deletes it.

- [ ] **Step 1: Write `refresh-context.tsx`**

```tsx
/**
 * RefreshProvider — wires the global refresh trigger (r-key) to
 * factory.relist(). Replaces use-refresh-context.ts's numeric-signal
 * approach for informer-backed hooks. The old context stays in tree
 * during the migration; PR5 deletes it.
 */

import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { InformerFactory } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";

type RefreshFn = (kind?: WatchKind) => void;

const RefreshContext = createContext<RefreshFn | null>(null);

export interface RefreshProviderProps {
  readonly factory: InformerFactory;
  readonly children: ReactNode;
}

export function RefreshProvider(props: RefreshProviderProps): ReactNode {
  const { factory, children } = props;
  const refresh = useCallback<RefreshFn>(
    (kind) => {
      void factory.relist(kind);
    },
    [factory],
  );
  return <RefreshContext.Provider value={refresh}>{children}</RefreshContext.Provider>;
}

export function useRelistTrigger(): RefreshFn {
  const fn = useContext(RefreshContext);
  if (!fn) throw new Error("useRelistTrigger: must be inside <RefreshProvider>");
  return fn;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/refresh-context.tsx
git commit -m "feat(tui): RefreshProvider wired to factory.relist()"
```

---

### Task 10: Wire factory and providers in `main.ts`

**Files:**
- Modify: `src/tui/main.ts`

`main.ts` constructs the factory at boot, mounts `<InformerProvider>` and `<RefreshProvider>` around the React tree, and registers a stop callback. **No** view migration. **No** `setInterval` removal. Existing data flow continues to work via `usePolledData`.

In **local mode**, the factory is constructed but the local stores don't yet publish to a `WatchHub` (PR2 wires that). `LocalWatchClient.run()` will list the snapshot, emit `RELIST_END`, and then sit idle waiting for hub events that never arrive. That's intentional and harmless: no view consumes the cache yet.

- [ ] **Step 1: Read `src/tui/main.ts` and find the React-render call site**

Run: `grep -n "render\|<App" src/tui/main.ts | head -20`

Identify the line that renders `<App ... />` (or similar). Insert the providers as wrappers around it.

- [ ] **Step 2: Add factory construction near the boot/auth logic**

Locate the section that determines `nexusUrl` / `apiKey` (around line 437 per the existing `eventBus` boot block). Add factory construction next to it. Sketch:

```ts
import { InformerFactory } from "../core/informer.js";
import { WatchHub } from "../core/watch-hub.js";
import { contributionToEntity, claimToEntity, agentSessionToEntity } from "../core/entity.js";

// ... inside main(), after eventBus / cleanupRuntime setup ...

let informerFactory: InformerFactory;
const namespace = projectId ?? "default"; // use whatever the existing project-id resolution returns

if (nexusUrl && apiKey) {
  informerFactory = new InformerFactory({
    mode: "remote",
    baseUrl: nexusUrl,
    authHeader: `Bearer ${apiKey}`,
  });
} else if (groveDir && cleanupRuntime) {
  // Local mode: factory uses a local WatchHub. PR2 wires stores → hub.recordWrite.
  // Until then, snapshots are static and live deltas don't arrive — no view consumes
  // the cache in PR1 so this is harmless.
  const localHub = new WatchHub();
  informerFactory = new InformerFactory({
    mode: "local",
    hub: localHub,
    namespace,
    listFn: (kind) => {
      switch (kind) {
        case "Contribution":
          return cleanupRuntime.contributionStore
            .listAll()
            .map((c) => contributionToEntity(c, namespace));
        case "Claim":
          return cleanupRuntime.claimStore.listAll().map((c) => claimToEntity(c));
        case "AgentSession":
          // Sessions live in goalSessionStore; project to AgentSession entities here.
          // Confirm the listing API on goalSessionStore — adapt as needed for PR1's
          // dark ship.
          return [];
      }
    },
  });
} else {
  // Headless / non-grove-dir startup — factory is unused. Construct an empty remote
  // stub against an unreachable URL only if the React tree needs to mount; otherwise
  // skip the provider entirely.
  informerFactory = new InformerFactory({
    mode: "remote",
    baseUrl: "http://127.0.0.1:0",
    authHeader: "",
  });
}

stopCallbacks.push(() => {
  void informerFactory.stopAll();
});
```

> **Confirmation note for the implementer:** verify the actual store APIs (`contributionStore.listAll()` etc.) before pasting — adapt the `listFn` to whatever the local stores expose. PR1's correctness only requires the factory to be constructible; the snapshots being empty is acceptable (no view consumes them yet).

- [ ] **Step 3: Wrap the React render with the providers**

Find the existing `render(<App ... />)` (or the equivalent OpenTUI render call) and wrap:

```tsx
import { InformerProvider } from "./hooks/informer-context.js";
import { RefreshProvider } from "./hooks/refresh-context.js";

// ... existing render call ...
render(
  <InformerProvider value={informerFactory}>
    <RefreshProvider factory={informerFactory}>
      <App {...existingProps} />
    </RefreshProvider>
  </InformerProvider>,
);
```

The exact prop shape on `<App>` is unchanged.

- [ ] **Step 4: Typecheck and run the full test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck clean, all existing tests still pass, new tests added in this PR pass.

- [ ] **Step 5: Smoke-run the TUI in local mode**

Run: `bun run src/tui/main.ts` (or the existing dev command — check `package.json scripts` if unsure)
Expected: TUI launches, no runtime errors, all existing screens render. The new informer factory is alive but unused by views.

- [ ] **Step 6: Commit**

```bash
git add src/tui/main.ts
git commit -m "feat(tui): wire InformerFactory + InformerProvider at app root"
```

---

### Task 11: Verify acceptance for PR1

**Files:** none (verification only).

- [ ] **Step 1: Confirm PR1's scope is met**

PR1 ships dark — no view migrated. Verify:

- `grep -n usePolledData src/tui` matches the same set of files as before PR1 (no removals).
- `grep -n useEntities\\\|useEntity\\\|useDerived src/tui` matches only the new hook source/test files (no view consumers).
- `grep -n setInterval src/tui` matches only the existing 3 sites in `main.ts` (PR5's job to remove).

Run all three greps, paste their output into the PR description.

- [ ] **Step 2: Run the full test suite one more time**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: clean (or only pre-existing warnings unrelated to PR1).

- [ ] **Step 4: Confirm commit log is clean and informative**

Run: `git log --oneline main..HEAD`
Expected: ~10 commits, each scoped to one task. Commit messages match the conventional-commit style of the repo.

- [ ] **Step 5: Open the PR**

Use `gh pr create` with title and body referencing issue #295 and labeling this as PR1 of 5.

```bash
gh pr create --title "A8 PR1: WatchStream contract + informer hooks (infra, ships dark)" --body "$(cat <<'EOF'
## Summary

PR1 of 5 for issue #295 (A8 — Retire all polling reactive paths).

- Extracts a `WatchStream` interface implemented by both the existing remote `WatchClient` and a new in-process `LocalWatchClient`.
- Refactors `Informer` to take a `WatchStream`; `InformerFactory` becomes a discriminated-union of `{ mode: "remote" }` / `{ mode: "local" }` and gains `factory.relist(kind?)` for the global r-key.
- Adds `<InformerProvider>`, `<RefreshProvider>`, and the new view hooks `useEntities`, `useEntity`, `useDerived` (with pure helpers covered by unit tests).
- `main.ts` constructs the factory and mounts the providers around the React tree.

**Ships dark.** No `usePolledData` call site is changed; no `setInterval` is removed. Spec: `docs/superpowers/specs/2026-04-30-retire-polling-a8-design.md`.

## Test plan

- [ ] `bun test` passes (existing + new unit tests + WatchStream contract suite)
- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] TUI launches in local mode, all existing screens render, no regressions
- [ ] TUI launches in remote (Nexus) mode, all existing screens render, no regressions

## Acceptance grep status

- `grep -r setInterval src/tui` — still 3 matches in `main.ts` (PR5 job).
- `grep -r usePolledData src/tui` — unchanged from main (PR2-PR4 job).
EOF
)"
```

---

## Self-review checklist

**Spec coverage:**
- ✅ §1 Architecture (WatchStream contract, two backends): Tasks 1, 2, 4.
- ✅ §2 Components / new files: Tasks 1-9 cover all PR1 new files; PR2-5 plans cover remaining files.
- ✅ §2 Components / modified files: Task 3 (`informer.ts`), Task 10 (`main.ts`), Task 1 (`watch-client.ts` adds `implements`).
- ✅ §3 Data flow / boot: Task 10.
- ✅ §3 Data flow / read path: Tasks 6-8.
- ✅ §3 Data flow / refresh: Task 9 (`RefreshProvider`).
- ✅ §3 Data flow / local-mode write fanout: noted explicitly as PR2 work in Task 10.
- ✅ §3 Data flow / non-Entity sources: out of PR1 scope (PR4).
- ✅ §4 Error handling / hook predicate throws: covered in Tasks 6, 8 helpers and tests.
- ✅ §4 Error handling / hook outside provider: Task 5 throws.
- ✅ §5 Testing / unit suites: Tasks 2, 4, 6, 7, 8.
- ✅ §5 Testing / contract fixture: Task 4.
- 🟡 §5 Testing / migration regression smoke tests: deferred to PR2-PR4 plans (no migrated views in PR1).
- 🟡 §5 Testing / kill-restart E2E: deferred to a later PR (probably PR5 or after).
- 🟡 PR2-PR5 plans: not written here. Each will be authored after its predecessor lands and the implementer can grep concrete signatures.

**Placeholder scan:** No "TBD", "TODO", "implement later" content in any task. The note in Task 10 about "verify the actual store APIs" is a real verification step the implementer must do, with explicit guidance on what's acceptable; not a placeholder.

**Type consistency:**
- `WatchStream` shape: `run({ onEvent, signal }) → Promise<void>` — consistent across Tasks 1, 2, 3.
- `InformerFactory.relist(kind?)` and `startAll`/`stopAll` — defined in Task 3, consumed by Tasks 5, 9, 10.
- `useInformer<K>(kind)` returns `Informer<K>` — consistent across Tasks 5, 6, 7, 8.
- Pure helpers (`stepDerived`, `shallowArraysEqual`, `computeFilteredEntities`, `selectEntityById`) — names and signatures are consistent between their definition tasks and the tests that exercise them.
