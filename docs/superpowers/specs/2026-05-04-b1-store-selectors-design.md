# B1 — Central Store with Selector Subscriptions

**Issue:** [#296](https://github.com/windoliver/grove/issues/296)
**Parent epic:** [#283](https://github.com/windoliver/grove/issues/283) — State Layer: Store + Overload Control
**Depends on:** #294 (Informer client, closed)
**Date:** 2026-05-04

---

## Goal

Add a thin reactive store layer between the per-kind `Informer<K>` cache and the existing TUI hooks (`useEntities`, `useEntity`, `useDerived`). The store gives React subscribers a version-stable snapshot, microtask-coalesced notifications, a selector-memoized read path, and a per-kind ring buffer of `grove_store_sse_lag` samples. Data writes remain lossless; render notifications coalesce.

## Acceptance criteria (from #296)

1. 10k events/sec burst: every event is applied to the store (write counter verified), render cadence ≤60Hz without stalling.
2. Selector memoization verified by snapshot test.
3. Store DevTools shows every event applied, in order.
4. `grove_store_sse_lag` metric exported.

## Non-goals

- Bounded write queue and overflow→full-resync. That work belongs to B2 (#298).
- Adding a third-party state library (Zustand, Jotai, Redux, etc.). The issue text says "Zustand or equivalent"; we take "equivalent" — the existing `Informer<K>.store: Map<id, Entity>` is already the per-kind slice keyed by `kind/namespace/id`. The new layer is the React-binding wrapper, not a parallel cache.
- Migrating any view. B1 is pure infrastructure plus the underneath-the-hood swap of three existing hooks. View migrations live in epic C (#284).
- OTEL / Prometheus / PerfBot exporters. The lag ring is exposed via `EntityStore.getStats()`; a future bridge can read it. Wiring an exporter now is scope creep with no consumer.

---

## Architecture

```
[ source of truth (server or in-process hub) ]
                │
                ▼ (with emittedAt on each event)
        WatchClient / LocalWatchClient
                │
                ▼
           Informer<K>            ← unchanged (#294)
           ├── Map<id, Entity>    ← canonical, synchronous data writes
           └── addEventHandler / addSyncHandler
                │
                ▼  (new in B1)
           EntityStore<K>
           ├── version: number              ← bumped per event (post-Informer-write)
           ├── writeCounter: number         ← monotonic, exposed via getStats()
           ├── lagRing: number[] (1024)     ← grove_store_sse_lag samples
           ├── snapshotCache: ReadonlyArray<E> | null  ← invalidated on version bump
           └── subscribe(fn) / list() / getById() / hasSynced() / getStats()
                │
                ▼  (microtask-coalesced)
           subscribers: useSyncExternalStore(subscribe, getVersion)
                │
                ▼
           selector(store.list()) → shallow-equal vs prev → setState only on change
                │
                ▼
           React commit (≤60Hz, framework-batched)
```

Untouched code:

- `core/informer.ts` — no changes to `Informer.run()`, `onEvent`, `dispatch`, fanout semantics, or backoff.
- `core/local-watch-client.ts` — only the `emittedAt` stamp at fan-out boundary (additive).
- `core/watch-client.ts` — only consumes `emittedAt` if present in the SSE frame (additive).

New code:

- `core/watch-events.ts` — `WatchEvent.emittedAt?: string` (optional ISO timestamp; server-stamped at SSE serialize boundary; local-mode-stamped at hub fan-out).
- `core/watch-stream.ts` (`WatchClientEvent`) — same optional `emittedAt` propagated end-to-end.
- `tui/data/entity-store.ts` — `EntityStore<K>` and `EntityStoreFactory`.
- `tui/hooks/entity-store-context.tsx` — React provider mirroring `informer-context.tsx`. Exports `EntityStoreProvider`, `EntityStoreProviderHolder`, `useEntityStoreOptional<K>`, `useEntityStoreFactoryOptional`, plus a null-stub for the no-provider case.
- `server/serve.ts` (or wherever the SSE writer for `/api/watch/:kind` lives) — set `emittedAt` at frame-write time.

Modified hooks (signatures unchanged, internals only):

- `tui/hooks/use-entities.ts` — subscribe via `EntityStore` instead of `Informer.addEventHandler` + `addSyncHandler`.
- `tui/hooks/use-entity.ts` — same.
- `tui/hooks/use-derived.ts` — same.

---

## Components

### 1. `EntityStore<K>` (new)

```ts
class EntityStore<K extends WatchKind> {
  constructor(informer: Informer<K>, factory: InformerFactory, kind: K)

  // React subscription primitives (uSES-compatible)
  subscribe(fn: () => void): () => void
  getVersion(): number

  // Reads
  list(): readonly EntityFor<K>[]              // version-stable ref
  getById(id: string): EntityFor<K> | undefined
  hasSynced(): boolean

  // DevTools / lag
  getStats(): {
    readonly writes: number          // monotonic, +1 per applied event
    readonly version: number
    readonly lagSamples: readonly number[]   // ms, oldest-first, ≤1024
  }

  // Lifecycle (called by factory; not part of public hook surface)
  dispose(): void                    // unsubscribes from informer
}
```

**Internals.**

- `version`, `writeCounter`, `flushScheduled`, `subscribers: Set<() => void>`, `lagRing: number[]`, `snapshotCache: readonly EntityFor<K>[] | null`.
- On construction: `informer.addEventHandler(onInformerEvent)` + `informer.addSyncHandler(onSync)`. Both are idempotent under unsubscribe.
- `onInformerEvent(op, entity)`:
  1. (Informer has already mutated its `Map` synchronously before calling the handler — see #294 contract; data is already committed.)
  2. `writeCounter += 1`
  3. `version += 1`
  4. `snapshotCache = null` (invalidate; rebuilt lazily on next `list()`)
  5. push `(Date.now() - parseISO(emittedAt))` into `lagRing` if `emittedAt` is well-formed; else skip
  6. if `!flushScheduled`: `flushScheduled = true; queueMicrotask(flush)`
- `onSync()`: bumps `version`, invalidates `snapshotCache`, schedules flush. Does NOT bump `writeCounter` (per-row diffs during a relist already passed through `onInformerEvent` and counted there) and does NOT push a lag sample (sync envelopes carry no `emittedAt`). The version bump is required so a sync that flips `hasSynced` from `false` to `true` notifies subscribers even when the cache contents are identical.
- `flush()`:
  1. `flushScheduled = false`
  2. snapshot subscribers (`[...subscribers]`) so an unsubscribe inside a callback can't skip the next subscriber
  3. for each, invoke (no args); isolate throws via try/catch + `console.error`
- `list()`:
  - if `snapshotCache !== null` and `cachedVersion === version`: return `snapshotCache`
  - else: `snapshotCache = Object.freeze(Array.from(informer.list()))`, `cachedVersion = version`, return it
  - the returned array IS already deep-frozen since #294 freezes per-entity; the outer freeze guarantees ref-stability against accidental external `.push`.
- `getById(id)`: delegate to `informer.getById(id)`. Pre-flush calls see post-write state because the Informer mutates its `Map` before invoking handlers.

### 2. `EntityStoreFactory` (new)

Mirrors `InformerFactory`. Holds one `EntityStore<K>` per supported kind. Lazily constructs on first `storeFor(kind)`. Forwards `mode` and `supportsKind(kind)` to the underlying `InformerFactory`.

```ts
class EntityStoreFactory {
  constructor(informerFactory: InformerFactory)
  get mode(): "remote" | "local"
  supportsKind(kind: WatchKind): boolean
  storeFor<K extends WatchKind>(kind: K): EntityStore<K>
  getAllStats(): Record<WatchKind, EntityStore<any>['getStats'] extends () => infer S ? S : never>
  dispose(): void                  // dispose all stores; idempotent
}
```

`getAllStats()` is the bulk-read for a future telemetry bridge.

### 3. `EntityStoreProvider` (new, `tui/hooks/entity-store-context.tsx`)

Mirrors `InformerProvider` and `InformerProviderHolder`. Mounts the factory in React context. The existing `InformerProvider` stays mounted (the factory is needed for error-listener wiring through `addErrorListener`); `EntityStoreProvider` wraps it and consumes the same factory. The TUI bootstrap path (`tui-app.tsx`) constructs both and provides them in nested order.

The null-stub pattern from `informer-context.tsx` carries over: when no provider is mounted or the kind is unsupported, `useEntityStoreOptional<K>(kind)` returns a frozen no-op store (empty list, `hasSynced=false`, no-op subscribe). Hooks remain hook-order-stable across mounted/unmounted trees.

### 4. Hook migrations (`use-entities`, `use-entity`, `use-derived`)

Public signatures unchanged. Internal subscription pattern changes from:

```ts
const informer = useInformerOptional(kind);
useEffect(() => {
  const u1 = informer.addEventHandler(recompute);
  const u2 = informer.addSyncHandler(recompute);
  return () => { u1(); u2(); };
}, [informer]);
```

to:

```ts
const store = useEntityStoreOptional(kind);
const subscribe = useCallback((fn: () => void) => store.subscribe(fn), [store]);
const getSnapshotVersion = useCallback(() => store.getVersion(), [store]);
useSyncExternalStore(subscribe, getSnapshotVersion);
// then run selector(store.list()) and shallow-compare against prev
```

The `useSyncExternalStore` return value (the version number) is intentionally unused — the call exists only to register the subscription and trigger a re-render whenever the version advances. The actual data comes from `store.list()`, which is version-stable: callers get the same array reference until the next version bump. The hook is responsible for selector memoization — the store provides the version-stable input list; the hook's existing `shallowArraysEqual` logic provides ref-stable output.

The factory's existing `addErrorListener(kind, fn)` plumbing is preserved unchanged; hooks still subscribe to `factory.addErrorListener` for stream-error surfacing.

---

## Data flow

### Write path (lossless, synchronous)

```
Server (or hub) emits WatchEvent
  → SSE frame serialized with emittedAt = ISO now()      [server-stamped]
  → WatchClient.parse → WatchClientEvent (with emittedAt)
  → Informer.onEvent
      1. switch(op) → store.set / store.delete            [data committed, sync]
      2. fanout: for handler in handlers: await handler   [existing #294 path]
          → EntityStore.onInformerEvent
              writeCounter += 1
              version += 1
              snapshotCache = null
              lagRing.push(Date.now() - parseISO(emittedAt))
              if (!flushScheduled) {
                flushScheduled = true
                queueMicrotask(flush)
              }
```

A `getById(id)` issued anywhere after step 1 (but before flush) sees the new value. This is the lossless data-path invariant.

### Notify path (microtask-coalesced)

N events in one microtask → version bumps N times, but `flush` is scheduled exactly once (the second-and-later events see `flushScheduled === true` and skip). After the current microtask drains, React's scheduler runs the queued microtask:

```
flush()
  flushScheduled = false
  for sub of [...subscribers]:
    try { sub(currentVersion) } catch (err) { console.error(...) }
```

Each subscriber's `useSyncExternalStore` reads the new version, runs the selector, shallow-compares vs prev, and triggers `setState` only on change. React batches `setState` calls into a single commit at the next paint (≤60Hz).

### Snapshot stability

`list()` is the snapshot read for selectors. Its returned ref is stable across calls when version is unchanged. Selectors that filter or map over `list()` therefore observe input ref-equality and can return their own ref-stable output (the existing `shallowArraysEqual` short-circuit in `use-entities` still applies). Duplicate writes (MODIFIED that doesn't change the filtered slice) → ref-stable selector output → zero `setState` → zero re-renders.

### Lag ring

`grove_store_sse_lag = clientApplyTs - serverEmitTs` in milliseconds.

- Server stamps `emittedAt` at the SSE frame-write boundary. Stamping at frame-write (not at `recordWrite`) means the sample reflects when the event left the server, which is what client-perceived lag should compare against.
- Local mode (`LocalWatchClient` driven by in-process `WatchHub`) stamps at the hub-to-subscriber fan-out point. In-process so samples hover near zero, but recording them surfaces microtask-queue stalls inside the TUI process.
- Client measures `Date.now() - Date.parse(emittedAt)` at the EntityStore boundary (post-Informer-write, pre-flush). Pushes into `lagRing` (1024 entries, drop-oldest).
- Missing or unparseable `emittedAt` → skip the sample silently. RELIST_BEGIN / RELIST_END envelope events have no entity and no lag semantics; skipped.
- Clock-skew note: stamping is wall-clock. Large skew between client and server hosts shows up as a constant offset. Acceptable for B1 — this is a relative-trend signal, not an SLO. Documented inline in the metric exposition.

---

## Error handling

Adopts the patterns already established by Informer / InformerFactory:

- A subscriber callback that throws is isolated via try/catch around the call site. The error is logged via `console.error` and fanout continues to the next subscriber.
- A selector that throws (inside the migrated hook) is caught at the same boundary as today (`computeError` in `use-entities`). Stream errors from the factory still take precedence over compute errors.
- Disposal is idempotent. `EntityStore.dispose()` unsubscribes from the Informer and from the parent factory's error listener; double-dispose is a no-op.
- The factory does not own the Informer's lifecycle. Stop/start/relist are still driven by `InformerFactory` — `EntityStore` is a passive subscriber.

---

## Testing

Five test files. All are unit-level except the wire-format E2E.

### `tui/data/entity-store.test.ts`

Fake `Informer` exposing the same `addEventHandler` / `addSyncHandler` / `list` / `getById` / `hasSynced` surface.

- Single `ADDED` → version bumps once; subscriber fires once after a microtask drain.
- N writes inside one microtask → version bumps N times; subscribers fire once.
- N writes spread across N awaited microtasks → subscribers fire N times.
- `list()` returns the same ref across reads while version is unchanged; new ref after a version bump.
- `getById(id)` reflects writes synchronously, before any flush.
- `DELETE` then `ADD` of the same id within one microtask: final state is the added entity; `writeCounter += 2`.
- Subscriber that calls its own unsubscribe inside the flush callback does not skip the next subscriber.
- Subscriber that throws is logged + isolated; remaining subscribers still fire.
- `getStats().writes` equals total events delivered, in order; `getStats().version` matches.
- `dispose()` removes the Informer subscriptions; subsequent Informer events do not bump version.

### `tui/data/entity-store.burst.test.ts` (10k/sec AC)

- Synthesize 10,000 ADDED events at the Informer event boundary in one tight loop (no awaits between writes — same microtask).
- After one microtask drain, assert `getStats().writes === 10000` (lossless).
- Assert `subscriber.callCount === 1` (single coalesced flush).
- A selector that returns a constant: zero `setState` calls (duplicate-output AC).
- Wall-time budget: full burst + flush + selector pass completes in <500ms (loose enough for CI runners). Catches accidental O(N²) regressions in any of `list()`, snapshot caching, or fanout, while tolerating slow CI.

### `tui/data/entity-store-selector.test.ts` (selector memoization snapshot)

- Mount `useEntities` with predicate `() => true`. Issue 100 ADDED events on a different kind. Assert 0 `setState` calls (kind isolation — store is per-kind).
- Mount with predicate that filters everything out. Issue 100 MODIFIED events. Assert 0 `setState` calls (filtered-out items don't reach the output).
- Item update that doesn't change the filtered-slice contents (e.g. status field unrelated to predicate). Assert ref-stable output array → 0 `setState` calls.
- Direct snapshot equality: selector output is `===` across no-op writes.

### `tui/hooks/use-entities.store-backed.test.ts` (migration smoke)

- All cases in the existing `tui/hooks/use-entities.test.ts` continue to pass with the migrated implementation. (Replace the test's mock-Informer wiring with mock-EntityStore wiring; assertions are identical.)
- New: under noisy unrelated writes (other kinds, other ids), the hook does not re-render.

### `tests/e2e/watch-emitted-at.test.ts` (wire field)

- Stand up `grove-server` in-process. Subscribe to `/api/watch/Contribution`. Issue a contribute. Assert the SSE frame parsed by `WatchClient` carries an `emittedAt` whose `Date.parse` is finite and within (now - 5s, now + 5s).
- Lag sample after Informer apply is positive, finite, and < 1s for in-process loopback.
- Drop `emittedAt` from a synthetic frame: no sample pushed, no throw, downstream fanout unaffected.

---

## Migration / rollout

This is a single-PR change. The wire field is additive (optional) and the public hook signatures are unchanged, so there is no staged rollout and no dual-path period.

Order of work in the PR:

1. Add `WatchEvent.emittedAt?: string` to `core/watch-events.ts` and `WatchClientEvent.emittedAt?: string` to `core/watch-stream.ts`. Plumb through `local-watch-client.ts` and `watch-client.ts`.
2. Server: stamp `emittedAt` at SSE frame-write in `grove-server`; stamp `emittedAt` at fan-out in `WatchHub` for the local path.
3. New `tui/data/entity-store.ts` + tests.
4. New `tui/hooks/entity-store-context.tsx` + tests.
5. Migrate `use-entities`, `use-entity`, `use-derived` to subscribe via `EntityStore`. Keep all existing tests green.
6. Wire `EntityStoreFactory` into `tui-app.tsx`'s bootstrap alongside the existing `InformerFactory` mount; wrap the tree with `EntityStoreProvider` inside `InformerProvider`.

---

## Risks

- **Subscriber storm.** A pathological case where every render mounts a fresh `useEntities` and unmounts on the next render could spam subscribe/unsubscribe. `Set<fn>` add/delete is O(1); the iteration snapshot in `flush()` allocates a small array. Acceptable.
- **Microtask ordering vs React 19 scheduling.** React 19's auto-batch operates inside the scheduler; our subscribers fire from a `queueMicrotask` callback that runs before the next paint but after the current sync work. `setState` calls inside subscribers are still batched by React. Validated by the burst test's "single coalesced flush" assertion.
- **Wall-clock skew on the lag ring.** Documented in §Lag ring; not blocking for B1.
- **`emittedAt` stamping site.** If we stamp at `recordWrite` instead of frame-write, in-flight queue time on the server side is invisible to the metric. Stamping at frame-write is the correct boundary; deviation here is a bug.
