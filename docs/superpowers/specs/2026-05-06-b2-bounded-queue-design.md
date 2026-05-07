# B2 — Bounded Write Queue + Overflow → Full Resync (Design Spec)

**Issue**: [#298](https://github.com/windoliver/grove/issues/298)
**Parent epic**: [#283 Epic B — State Layer](https://github.com/windoliver/grove/issues/283)
**Depends on**: #296 (EntityStore, closed), #292 (watch protocol, closed), #294 (Informer)
**Date**: 2026-05-06

## Problem

The TUI consumes a watch stream of `WatchClientEvent`s through `Informer<K>` into the per-kind `EntityStore<K>` central store (B1, #296). Today the path is fully synchronous: `WatchClient → Informer.onEvent → store mutation + handler dispatch`. Slow handlers back-pressure the watcher itself; a flood of deltas can starve the React event loop and freeze the TUI.

We need an explicit bounded buffer between SSE delivery and store apply, with a deterministic recovery path when the buffer fills: stop applying individual deltas, abort the watch, increment a counter, trigger a fresh `list → watch` handshake. After the burst subsides, normal pass-through resumes and store state matches server truth.

The original issue's "out of scope" deferrals (RV-coalescing, dynamic queue sizing, depth gauge) are pulled into this spec per user direction — they materially reduce overflow risk and improve observability with low marginal cost.

## Architecture

```
WatchClient (SSE)
   ↓ stream.run({ onEvent })
Informer.enqueue(e)
   ├─ control event (RELIST_BEGIN/RELIST/RELIST_END/RELIST_ABORTED)
   │     → drain queue first → apply inline (preserves staging-Map invariant)
   └─ delta event (ADDED/MODIFIED/DELETED)
         ├─ id already in map     → overwrite (RV-coalesce)
         ├─ map.size  < limit     → insert, schedule drain
         └─ map.size == limit AND id new
                                  → drop event, clear map, overflows++,
                                    fire onOverflow(kind) → factory.relist(kind)
   ↓ drain (microtask)
   for each entry: existing applyEvent(e) → mutate Map + dispatch handlers
   ↓
EntityStore.onEvent (unchanged) → bumpAndNotify → React subscribers
```

Single-threaded JS guarantees the enqueue/drain interleaving is serializable; no locks needed beyond what already exists in `InformerFactory.withLock` for relist serialization.

## Components

### `Informer<K>` (modified, src/core/informer.ts)

New constructor options:

```ts
interface InformerOptions {
  readonly queueLimit?: number;          // default 1000
  readonly onOverflow?: (kind: WatchKind) => void;
}
```

New internal state:

```ts
private readonly queue = new Map<string, WatchClientEvent>(); // by entity.id
private readonly queueLimit: number;
private readonly onOverflow: ((kind: WatchKind) => void) | null;
private overflows = 0;
private flushScheduled = false;
```

Renamed: existing `private async onEvent(e)` → `private async applyEvent(e)`. Keeps the apply logic intact (RELIST_BEGIN/END staging, ADDED/MODIFIED/DELETED dispatch).

New entry point used by `stream.run`:

```ts
// Return type is intentionally `void | Promise<void>`. The hot delta path
// returns `void` synchronously so a 100k/s burst doesn't pay one microtask
// per event in the WatchClient's `await onEvent(e)` loop. Only the control-
// event path needs an async signature for the drain barrier.
private enqueue(e: WatchClientEvent): void | Promise<void> {
  if (isControlEvent(e.op)) return this.enqueueControl(e);
  // delta path — synchronous
  const id = e.entity?.id;
  if (id === undefined) return; // defensive — deltas always carry an entity
  if (this.queue.has(id)) {
    this.queue.set(id, e); // coalesce — newer wins
    return;
  }
  if (this.queue.size >= this.queueLimit) {
    this.queue.clear();
    this.overflows += 1;
    if (this.onOverflow) {
      try {
        this.onOverflow(this.kind);
      } catch (err) {
        console.error(`Informer[${this.kind}]: onOverflow callback threw, recovery skipped:`, err);
      }
    }
    return; // dropped — relist will repopulate from server truth
  }
  this.queue.set(id, e);
  this.scheduleDrain();
}

private async enqueueControl(e: WatchClientEvent): Promise<void> {
  // Drain pending deltas before applying the control event so a RELIST_END
  // atomic-replace happens after all deltas that arrived before it.
  if (this.queue.size > 0) {
    const pending = this.queue;
    this.queue = new Map();
    for (const ev of pending.values()) await this.applyEvent(ev);
  }
  await this.applyEvent(e);
}

private scheduleDrain(): void {
  if (this.flushScheduled) return;
  this.flushScheduled = true;
  queueMicrotask(() => {
    void this.drain();
  });
}

private async drain(): Promise<void> {
  // Hold flushScheduled=true for the drain's full lifetime so events that
  // arrive during an `await applyEvent(...)` accumulate in `this.queue`
  // without scheduling a second microtask. The loop sweeps them on its
  // next iteration, preserving the serialized-fanout invariant — only
  // one drain runs at a time, which is required because applyEvent
  // mutates shared state (this.store, this.staging) and dispatches
  // handlers that themselves may await.
  try {
    while (this.queue.size > 0) {
      const pending = this.queue;
      this.queue = new Map();
      for (const ev of pending.values()) {
        await this.applyEvent(ev);
      }
    }
  } finally {
    this.flushScheduled = false;
  }
}
```

> **Drain re-entry note:** an earlier draft had `flushScheduled = false` at the top of `drain()`, which would let a delta arriving during `await applyEvent(...)` schedule a second microtask. Two drains running concurrently would race on `this.store`/`this.staging` and break the serialized-fanout guarantee that an existing test asserts. The loop pattern above keeps a single drain in flight while still draining all queued events.

`isControlEvent`: `op in {RELIST_BEGIN, RELIST, RELIST_END, RELIST_ABORTED}`. (BOOKMARK is consumed inside `WatchClient` for cursor-advance and never reaches `Informer`.) `RELIST` is treated as a control op even though it carries an entity, because snapshot rows must land in `staging`, not the in-flight delta queue — draining first is a cheap no-op when the server respects the BEGIN→END ordering.

New observability surface:

```ts
getQueueStats(): {
  readonly depth: number;
  readonly limit: number;
  readonly overflows: number;
} {
  return { depth: this.queue.size, limit: this.queueLimit, overflows: this.overflows };
}
```

Note: `Informer` already takes `kind` only implicitly via the stream. Add `private readonly kind: WatchKind` to the constructor so `onOverflow` can pass it through. Existing call sites in `InformerFactory.makeStream` already know the kind.

### `InformerFactory` (modified, src/core/informer.ts)

`InformerFactoryOptions` gains:

```ts
readonly queueLimits?: Partial<Record<WatchKind, number>>;
```

`informerFor(kind)` constructs Informer with:

```ts
new Informer<K>(stream, kind, {
  queueLimit: this.opts.queueLimits?.[kind] ?? 1000,
  onOverflow: () => { void this.relist(kind); },
});
```

`relist()` is already serialized via `withLock` so concurrent overflow-driven calls coalesce safely.

### `EntityStore<K>` (modified, src/tui/data/entity-store.ts)

`getStats()` extended:

```ts
getStats(): {
  readonly writes: number;
  readonly version: number;
  readonly overflows: number;
  readonly queueDepth: number;
  readonly queueLimit: number;
  readonly lagSamples: readonly number[];
} {
  const q = (this.informer as Informer<K>).getQueueStats();
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

`EntityStoreStats` type updated to match. `EntityStoreFactory.getAllStats()` already iterates per-kind, so the per-kind overflow counter rolls up automatically.

The `entity-store-context.tsx` placeholder stub (see existing `getStats: () => ({ writes: 0, version: 0, lagSamples: [] })`) is updated to include the new fields with `0`.

### `entity-store-context.tsx` and other consumers

The placeholder stats shape in `entity-store-context.tsx` (line 54) needs the three new fields. No other consumers read `getStats()` outside tests.

## Data flow under three regimes

### Normal load (queue stays at depth ≤ limit)

`enqueue` → map insert → microtask drain → `applyEvent` → `dispatch` → `EntityStore.onEvent` → microtask-coalesced subscriber notify (B1 path, unchanged). End-to-end: same tick + one microtask. Subscribers see the same coalescing as today.

### Bursty same-id load (RV-coalescing kicks in)

100 MODIFIED events for entity `c1` arrive in one tick → enqueue overwrites in place → map size stays at 1 → drain applies the latest one → 1 dispatch → 1 EntityStore notify. Equivalent to today minus 99 wasted Map writes and 99 wasted dispatch calls.

### Overflow (>1000 distinct ids burst beyond drain rate)

Event #1001 with new id arrives while drain hasn't started yet → map.size === 1000 and id absent → drop event, clear map, overflows++, `onOverflow` fires → `factory.relist(kind)` → current run aborts → new run starts → `RELIST_BEGIN/RELIST*/RELIST_END` rebuilds Map atomically from server snapshot. Subscribers see one notify on the snapshot replace. Any subsequent live deltas resume the normal path.

## Coalescing edge cases

| Sequence (same id) | Map after coalesce | Apply effect |
|---|---|---|
| ADDED, MODIFIED | MODIFIED | Map gets latest entity |
| ADDED, DELETED | DELETED | Map.delete (no-op since never inserted) — final state absent ✓ |
| MODIFIED, DELETED | DELETED | Map.delete on existing — final state absent ✓ |
| DELETED, ADDED | ADDED (recreated entity) | Map.set — final state present ✓ |
| DELETED, ADDED, DELETED | DELETED | Map.delete — final state absent ✓ |

All collapse to the "final-state" semantics k8s informers already produce. The intermediate states a slow consumer would have seen are irrelevant — only the final state is visible to the React subscribers because notifications are already microtask-coalesced (B1).

## Error handling

- **Handler throws during drain**: existing `dispatch` already catches per-handler exceptions and continues. No change.
- **Drain throws (shouldn't, but defensive)**: caught at top of `drain()`; `flushScheduled` reset so a future enqueue can re-schedule.
- **Overflow during overflow recovery**: `relist()` is per-kind serialized via `withLock`; the second `relist` call queues behind the first. The aborted run produces a `RELIST_ABORTED` which clears any staging map; the new run starts fresh. The `overflows` counter still increments per overflow event so the metric reflects pressure honestly.
- **`onOverflow` callback throws**: caught inside `enqueue`; queue stays cleared, counter stays incremented. Recovery does not happen — but the next overflow will retry. Logged as `Informer[kind]: onOverflow callback threw, recovery skipped`.

## Testing

### Unit (src/core/informer.test.ts additions)

- `enqueue → drain in next microtask, single applyEvent per id, version bump = N`.
- `enqueue 10k events same id → drain produces 1 applyEvent, peak depth 1`.
- `enqueue ADDED then DELETED same id → final state absent, 1 dispatch (DELETED) on entity not in store is no-op`.
- `enqueue DELETED then ADDED same id → final state present with new RV`.
- `enqueue 1001 distinct ids in tight loop → overflows=1, queue cleared, onOverflow fired exactly once`.
- `RELIST_BEGIN arriving with 500 deltas queued → deltas drained first, then RELIST_BEGIN sets staging`.
- `Per-kind limits: factory with {AgentSession: 5} → overflow at 6 distinct ids; Contribution still uses 1000`.
- `getQueueStats during partial drain → depth visible mid-batch (use a handler that captures depth on first invocation)`.

### Acceptance test (src/core/informer.burst.test.ts, new)

100k events/sec for 5s burst, per #298 acceptance criteria.

```
fake stream emits at 100k/s for 5s (use scheduled batches with setImmediate yields)
factory.relist mock counts invocations
assert:
  overflows >= 1                    (queue overran at least once)
  factory.relist called >= 1        (recovery triggered)
  no drain microtask exceeded 50ms wall-time (TUI never freezes)
post-burst:
  inject final RELIST_END with snapshot of N entities
  store.list().length === N         (state converges to server truth)
  every entity.resourceVersion matches snapshot
```

The "TUI never freezes" assertion uses a wall-clock measurement around each `drain()` invocation. If a single drain exceeds 50ms in CI, we add a 16ms-budget yield inside drain (defer until measured to avoid premature complexity).

### EntityStore propagation (src/tui/data/entity-store.test.ts additions)

- `getStats() returns informer overflow counter`.
- `EntityStoreFactory.getAllStats() rolls up overflows per kind`.

## Files touched

- `src/core/informer.ts` — queue, overflow, callback wiring; rename `onEvent` → `applyEvent`; add `kind` field; new `InformerOptions`; `getQueueStats`.
- `src/core/informer.test.ts` — overflow + coalesce unit tests.
- `src/core/informer.burst.test.ts` (new) — 100k/5s acceptance.
- `src/tui/data/entity-store.ts` — extend `getStats()`, `EntityStoreStats` type.
- `src/tui/data/entity-store.test.ts` — assert overflow + queue depth propagation.
- `src/tui/hooks/entity-store-context.tsx` — update placeholder stub stats shape.

## Out of scope

- Wiring `grove_store_overflow` into a Prometheus exporter or external metrics surface — same posture as B1's `grove_store_sse_lag`. Stats are exposed via `getStats()` for future scrape.
- Adaptive queue resizing at runtime (per-kind static limits only).
- Cross-kind quota or memory-budget enforcement.
- Backpressure signaling to the SSE server (we just close the watch and re-list).

## Migration / rollout

No flag — the queue is always on. Default limit 1000 matches issue spec; no tuning needed for current Grove workloads. Existing `entity-store.burst.test.ts` (10k events same id, must remain green) validates RV-coalescing doesn't break the lossless-write contract from B1.
