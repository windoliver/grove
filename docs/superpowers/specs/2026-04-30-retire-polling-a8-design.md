# A8 — Retire All Polling Reactive Paths

**Issue:** [#295](https://github.com/windoliver/grove/issues/295)
**Parent epic:** [#282](https://github.com/windoliver/grove/issues/282) — Foundation: Entity Model + Watch Protocol
**Depends on:** #294 (Informer client, closed)
**Date:** 2026-04-30

---

## Goal

Eliminate polling from the Grove TUI. After A8, every reactive view in `src/tui/` is driven by SSE → informer cache → React hook. The literal acceptance check `grep -r setInterval src/tui` returns zero.

## Acceptance criteria (from #295)

1. `grep -r setInterval src/tui` returns zero.
2. Single reactive path: SSE → informer → store → hook.
3. E2E suite validates against Nexus stores.

## Non-goals

- Expanding the Entity model. The watch protocol stays at three kinds: `Contribution`, `Claim`, `AgentSession`. Non-Entity sources (GitHub PR, vfs, terminal output, gossip, etc.) keep their existing fetchers and migrate to event-driven re-fetch via the already-built `useEventDrivenData`.
- Redesigning the watch protocol or informer (#292, #293, #294 already shipped).
- New visual regressions / golden snapshots.
- Load-burst testing (covered by #294).

---

## Architecture

One reactive path:

```
[ source of truth ]
        │
        ▼
   WatchHub  ──────────► (remote) WatchClient ──┐
                                                ├──► Informer<K> ──► React hook ──► view
              (in-process) LocalWatchClient ────┘
```

Two transport backends behind a single `WatchStream` contract:

- **Remote mode** (Nexus available): existing `WatchClient` over HTTP/SSE.
- **Local mode** (no Nexus): new `LocalWatchClient` subscribes directly to a process-local `WatchHub` over local stores. Same `WatchClientEvent` stream, same RELIST handshake, same RV semantics.

`InformerFactory` is constructed with the appropriate transport at boot and provided through React context at the app root. It eagerly starts one informer per kind on mount; aborts all on unmount.

Three view-layer hooks consume this:

- `useEntities(kind, predicate?)` — filtered list view from `informer.list()`.
- `useEntity(kind, id)` — single-record subscription.
- `useDerived(deps, kinds, equals?)` — pure projection over informer caches for cross-kind aggregates.

Existing `useEventDrivenData` (already polling-free) covers non-Entity sources.

The three `setInterval`-driven cleanup loops in `src/tui/main.ts` (claim cleanup, blob GC, session GC) are not reactive UI; they move out of `src/tui/` to `src/local/cleanup-scheduler.ts` so the acceptance grep is literally zero. Semantics unchanged.

## Components

### New files

- `src/core/watch-stream.ts` — extracted interface

  ```ts
  export interface WatchStream {
    run(opts: { onEvent: (e: WatchClientEvent) => void | Promise<void>; signal: AbortSignal }): Promise<void>;
  }
  ```

  Implemented by both `WatchClient` and `LocalWatchClient`.

- `src/core/local-watch-client.ts` — `LocalWatchClient` class. Constructor:

  ```ts
  new LocalWatchClient({
    hub: WatchHub,
    kind: WatchKind,
    listFn: () => readonly WatchEntity[],
    backoff?: WatchClientOptions["backoff"],  // same shape as remote: { minMs, maxMs, jitter }
  })
  ```

  Behavior on `run({ onEvent, signal })`:
  1. Subscribe to `hub` for `kind` (buffer events while listing).
  2. Emit `RELIST_BEGIN`.
  3. For each entity from `listFn()`, emit `RELIST` events.
  4. Emit `RELIST_END`.
  5. Drain buffered live events; from then on emit live `ADDED/MODIFIED/DELETED` from the hub subscription.
  6. On abort: detach the hub subscription, return.

  No HTTP, no socket. Same `WatchClientEvent` shape and ordering as remote.

- `src/tui/hooks/informer-context.tsx` —

  ```ts
  <InformerProvider value={factory}>{children}</InformerProvider>
  function useInformer<K extends WatchKind>(kind: K): {
    list(): readonly EntityForKind<K>[];
    getById(id: string): EntityForKind<K> | undefined;
    hasSynced(): boolean;
    addEventHandler(fn: EventHandlerFn<K>): () => void;
  }
  ```

  Throws when used outside the provider.

- `src/tui/hooks/use-entities.ts` —

  ```ts
  function useEntities<K extends WatchKind>(
    kind: K,
    predicate?: (e: EntityForKind<K>) => boolean,
  ): { data: readonly EntityForKind<K>[]; hasSynced: boolean; error: Error | null };
  ```

  Subscribes via `informer.addEventHandler`. On any event, recomputes the filtered list and shallow-compares against the previous output (length + per-index `Object.is`); only commits new state when the array actually changed. Predicate exceptions are caught: error is set, last-good data preserved.

- `src/tui/hooks/use-entity.ts` —

  ```ts
  function useEntity<K extends WatchKind>(
    kind: K,
    id: string | undefined,
  ): { data: EntityForKind<K> | undefined; hasSynced: boolean };
  ```

  Subscribes, but the handler ignores events with `entity.id !== id`. Returns `informer.getById(id)`. `undefined` id returns `undefined` data without subscribing.

- `src/tui/hooks/use-derived.ts` —

  ```ts
  function useDerived<T>(
    compute: () => T,
    kinds: readonly WatchKind[],
    equals?: (a: T, b: T) => boolean,
  ): { data: T; hasSynced: boolean; error: Error | null };
  ```

  Subscribes to every listed kind. Recomputes on any event. `equals` defaults to `Object.is`. Caller is responsible for keeping `compute` referentially stable (or accepting the recompute on every render).

- `src/local/cleanup-scheduler.ts` —

  ```ts
  function startCleanupScheduler(opts: {
    cleanupRuntime: LocalCleanupRuntime;
  }): { stop(): void };
  ```

  Owns the three `setInterval` timers (claim cleanup 60s, blob GC 10min, session GC 5min). Returns one `stop()` that clears all and closes the runtime. Caller (main.ts) keeps a single stop callback in `stopCallbacks`.

### Modified files

- `src/core/informer.ts` — `Informer` constructor takes a `WatchStream` (`{ run({ onEvent, signal }) }`) instead of `WatchClientOptions`. `InformerFactory` gains a discriminated-union options shape:

  ```ts
  type Backoff = { minMs: number; maxMs: number; jitter: number };
  type InformerFactoryOptions =
    | {
        mode: "remote";
        baseUrl: string;
        authHeader: string;
        fetch?: typeof fetch;
        backoff?: Backoff;
      }
    | {
        mode: "local";
        hub: WatchHub;
        listFn: (k: WatchKind) => readonly WatchEntity[];
        backoff?: Backoff;
      };
  ```

  Public `informerFor(kind)` API unchanged. Internally constructs the right `WatchStream` for the mode.

  New: `factory.relist(kind?: WatchKind)` aborts the current `run()` for the given kind (or all) and starts a new one. Used by the global `r`-key refresh.

- `src/tui/main.ts` —
  - At boot: select mode from `GROVE_NEXUS_URL + NEXUS_API_KEY`. Construct factory.
  - Eagerly start all three informers under one `AbortController`.
  - Render `<InformerProvider value={factory}><App /></InformerProvider>`.
  - Replace the three inline `setInterval`s with `startCleanupScheduler(...)`.

- ~30 view/hook/screen files — call sites swap `usePolledData` → `useEntities` / `useEntity` / `useDerived` / `useEventDrivenData` per the per-source table below.

### Deleted (after PR5 lands)

- `src/tui/hooks/use-polled-data.ts` and `.test.ts`
- `src/tui/hooks/use-panel-state.ts` (a thin wrapper over `usePolledData`; replace with inline `useEntities` calls or a new tiny wrapper if a use case survives).
- `src/tui/hooks/use-refresh-context.ts` — replaced by a smaller `RefreshProvider` that calls `factory.relist()` instead of broadcasting a poll-poke signal.

### Per-source migration table

A view may pull from multiple sources; in that case it appears in multiple rows and migrates piece-by-piece across the PRs in the migration plan.

| Source | New hook |
|---|---|
| Active claims, claim lists; the `Claim` portion of `agent-list` and `pipeline-view` | `useEntities("Claim", predicate)` |
| Contribution feeds; the `Contribution` portion of `panel-manager` detail; contribution detail by id | `useEntities("Contribution", predicate)` / `useEntity("Contribution", id)` |
| Agent sessions (`AgentSession` entities); the session portion of `agent-list` / `pipeline-view` / `agent-graph` | `useEntities("AgentSession", predicate)` |
| Cross-kind aggregates: dashboard counts, dag layout, frontier projections, agent-graph layout | `useDerived(...)` over `Claim` / `AgentSession` / `Contribution` |
| Cost rollups, agent profiles, palette sessions list, gossip peers, GitHub PR summary, threads, bounties, outcomes, decisions, handoffs, search results, full-text search beyond cache | `useEventDrivenData` — these read from non-Entity stores or external sources and are not projected through the watch protocol |
| VFS browser entries, artifact preview, terminal output buffers, tmux capture, the tmux/session-output portion of `agent-list` and `pipeline-view` | `useEventDrivenData` — requires PR4 to add a coarse-grained event from the producer (file watcher or ACP stream listener) so the existing hook re-fetches without a timer |

## Data flow

### Boot sequence (`main.ts`)

1. Determine mode from env.
2. Construct factory:
   - Remote: `createInformerFactory({ mode: "remote", baseUrl, authHeader })`.
   - Local: open local stores, construct `WatchHub`, `createInformerFactory({ mode: "local", hub, listFn })` where `listFn(kind)` returns the current snapshot from the appropriate store.
3. Eagerly start all 3 informers under one `AbortController`. `signal.addEventListener("abort", ...)` aborts on shutdown.
4. Render `<InformerProvider value={factory}><App /></InformerProvider>`.
5. `startCleanupScheduler(...)`, push its `stop` into `stopCallbacks`.

### Read path (typical view)

- `useEntities("Claim", c => c.status.phase === "active")` resolves the kind's `Informer` from context.
- On mount: subscribes via `addEventHandler`, computes initial `list().filter(...)`, returns `{ data, hasSynced }`.
- On event: predicate re-runs; output is shallow-compared with previous; React commits only when changed.
- `useEntity("Claim", id)` ignores events whose `entity.id !== id`.

### `useDerived` for aggregates

`useDerived(() => buildDag(claimsInformer.list(), sessionsInformer.list()), ["Claim", "AgentSession"])` subscribes to both informers, recomputes on any event from either kind, returns memoized output via `equals`.

### First-render gating

Per-kind `hasSynced` is read off the factory; views render their own placeholder until `true`. The informer doesn't surface the cache until `RELIST_END` lands (existing #294 behavior) — no empty-flash.

### Refresh (`r` key)

`RefreshProvider` is reimplemented over the factory. Global `r` calls `factory.relist()`; `WatchClient` / `LocalWatchClient` re-issue `/api/list` (or re-snapshot) → atomic Replace.

### Local-mode write fanout

Local stores write → `WatchHub.publish(kind, event)` → `LocalWatchClient.onEvent` → informer dispatch → React subscribers. For kinds where the local store does not yet publish to `WatchHub`, PR1 adds the publish call (this is small and was likely missed when remote-only was the focus).

### Non-Entity sources

`useEventDrivenData` re-fetches when an `EventBus` event arrives. For sources that don't currently emit:

- **VFS**: file watcher in `src/local/` emits a coarse `vfs.changed` event when the workspace tree changes; the hook re-fetches.
- **Terminal buffers**: ACP stream listener emits `agent.output` events; the hook re-fetches the captured buffer.
- **GitHub PR**: server-side webhook or periodic cron at the *producer* layer (out of TUI) publishes a `github.pr.changed` event; client just re-fetches on event. (Producer-side polling is acceptable — the acceptance criterion is `src/tui`.)

## Error handling

- **Watch stream failures (transient):** `WatchClient` already handles backoff + reconnect with `RELIST_BEGIN/END` Replace on resume (existing #292/#293). Views see only post-Replace state — no torn intermediate. `LocalWatchClient` mirrors the contract (logs + retries on backing-store error).
- **Stale RV** (server-side compaction, #293): `WatchClient` raises `StaleResourceVersionError` internally → triggers full relist. Same path on local for symmetry.
- **Predicate / projection throws in hooks:** wrapped in try/catch. Caught error sets `error` state and logs via `console.error`; last-good `data` preserved.
- **Hook used outside `InformerProvider`:** `useInformer(kind)` throws synchronously with a clear message.
- **Local-mode boot when stores aren't ready:** factory constructor doesn't throw; informer's `run()` surfaces the error. Main.ts treats that as fatal — same as remote startup failure.
- **Cleanup scheduler errors:** non-fatal, swallowed + logged to stderr (preserves current behavior).
- **`r`-key relist failure:** `factory.relist(kind)` aborts and restarts. If the new run immediately fails, `WatchClient`'s reconnect/backoff loop takes over. UI shows last-good cache.
- **Hot-reload / unmount during dispatch:** `Informer.dispatch` already races handlers against the abort signal (existing implementation).

## Testing

### Unit tests

- `local-watch-client.test.ts` — fake `WatchHub`, verifies `RELIST_BEGIN/RELIST*/RELIST_END` ordering, abort, error path.
- `informer-context.test.tsx` — provider mount/unmount, `useInformer` outside provider throws.
- `use-entities.test.tsx` — predicate filtering, shallow-equal output memo, `hasSynced` gating, predicate-throw → `error` state.
- `use-entity.test.tsx` — single-id subscription, no re-render on unrelated id, `null` when id absent.
- `use-derived.test.tsx` — recomputes on any listed kind, custom `equals` honored, throw in `compute` sets `error`.
- `cleanup-scheduler.test.ts` — three timers fire on cadence, `stop()` clears all, errors don't crash the scheduler.

### Contract test fixture

- `watch-stream.contract.test.ts` — single test suite parameterized over `[remote WatchClient + fake server, LocalWatchClient + WatchHub]`. Same assertions on both: list→watch handshake, RELIST atomicity, abort behavior, late-event-after-RELIST_END is delivered as a delta. Catches drift between backends.

### Migration regression tests

For each migrated view in PR2/3/4: a smoke test that mounts the view with a seeded informer/event-bus, asserts initial render matches seed, publishes an event, asserts re-rendered output. Per-batch coverage without standing up E2E.

### Acceptance verification

- `grep -r setInterval src/tui` returns zero — added as a one-line CI check in PR5.
- Existing Nexus E2E suite stays green across all PRs.
- New targeted E2E: Nexus-backed run, kill+restart server mid-stream, assert TUI views recover without missed events or stale state past reconnect.

## Migration plan (5 PRs)

1. **PR1 — infra.** `WatchStream` interface, `LocalWatchClient`, `InformerFactory` discriminated-union options, `factory.relist`, `<InformerProvider>`, `useEntities` / `useEntity` / `useDerived`. New `RefreshProvider` over factory. Tests including the contract fixture. Local-store `WatchHub.publish` calls added where missing. Zero call-site changes — infra ships dark.

2. **PR2 — Entity-backed reads.** Migrate the `usePolledData` *call sites* that read directly from the 3 kinds. Includes the claim portion of `claims.tsx`, `agent-list.tsx`, `pipeline-view.tsx`, `agent-graph.tsx`; the contribution portion of `activity.tsx`, `activity-panel.tsx`, `search-panel.tsx` (in-cache scope only), `detail.tsx`; the session portion of `agent-list.tsx`, `pipeline-view.tsx`, `agent-graph.tsx`. Mixed-source views keep their non-Entity polling paths until PR4. `usePolledData` itself stays in tree.

3. **PR3 — aggregates.** Migrate views that compose across kinds: dag, dashboard cross-cuts, panel-manager detail (single-record + cross-kind context). Use `useDerived`.

4. **PR4 — non-Entity sources.** Migrate GitHub PR, gossip, threads, bounties, outcomes, decisions, vfs, terminal output, artifact preview, search to `useEventDrivenData`. Add producer-side events for vfs (file watcher) and terminal output (ACP listener) so re-fetch is event-driven, not timer-driven.

5. **PR5 — cleanup.** Move 3 `setInterval`s out of `src/tui/main.ts` into `src/local/cleanup-scheduler.ts`. Delete `usePolledData`, `usePanelState`, old `useRefreshContext`. Add CI grep check. Final acceptance grep == 0.

## Risks and mitigations

- **Two `WatchStream` implementations drift.** → Contract test fixture, parameterized over both, in PR1.
- **Eager 3-kind subscription wastes resources on screens that need one.** → 3 SSE streams per TUI process is negligible; server multiplexes. Confirmed acceptable in design discussion.
- **`useEntities` predicate-on-list churn under high event rate.** → Shallow-equal memo on the output array. If still hot, add a coarse opt-in indexed view in a follow-up; not required for A8.
- **Local-mode hub doesn't publish for some kinds.** → PR1 adds publish calls where missing. Caught by the contract fixture if any kind regresses.
- **Dual-path window between PR2 and PR5.** → Acceptable: each PR is small enough to revert. Final PR is mostly deletions.

## Open items deferred to follow-ups

- Server-side polling at the *producer* layer for non-Entity sources (e.g. GitHub webhook ingest). Out of A8 — acceptance is `src/tui` only.
- Indexed views over the informer cache for predicates that scan large lists. Add only if profiling shows it matters.
- Suspense-style loading boundaries instead of per-hook `hasSynced`. Larger React refactor; not blocking.
