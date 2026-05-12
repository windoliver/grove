# C1 — Generic `<EntityView>` component

**Issue**: [#301](https://github.com/windoliver/grove/issues/301)
**Parent epic**: [#284](https://github.com/windoliver/grove/issues/284) — Epic C: TUI Views + Mutation Safety
**Depends on**: #296 (B1 Central store, MERGED — `EntityStore`/`useEntities` available)
**Reference**: k9s `internal/view/browser.go`, `internal/render/*`

## Goal

Land one generic `<EntityView kind columns … />` component that replaces the duplicated dual-path data fetching, row mapping, loading/empty/error rendering, and cursor handling currently copy-pasted across the TUI's list-style views. Adding a new entity-backed list view becomes "import EntityView, declare a `columns` array, declare a `predicate`/`sort`" — no new component file.

## Non-goals

- Keyboard input handling. The App's screen-manager remains the keymap authority. EntityView accepts a `hints` prop (metadata only) so the C3 hint bar (#309) can render context-aware actions, and so C2 command prompt (#302) can read available actions, without EntityView fighting the parent for input events.
- Mutation. Destructive actions are gated by `confirmAndMutate` (C6, #304); EntityView never mutates.
- Migrating `pipeline-view.tsx` (flex-card grid) or `agent-graph.tsx` (custom edge layout). These are not row-based; forcing them into EntityView would distort it.

## Migration scope

Four concrete view files port to EntityView in this epic:

| File | Kind | Notes |
|------|------|------|
| `claims.tsx` | `Claim` | Cleanest fit; canonical migration |
| `activity-panel.tsx` | `Contribution` | Subset of Activity columns; `limit=30` |
| `activity.tsx` | `Contribution` | Paged list; sort+slice via EntityView props |
| `agent-list.tsx` | `Claim` | Multi-source join (claims × tmux × cost) — wrapper retains the join, EntityView handles list scaffold |

`search-panel.tsx` was an initial candidate but is deferred. Its contribution result table needs server-side full-text search via `provider.getContributions({ search })` when the user has a query, which the EntityStore-predicate path can't model. Migrating only the no-query branch would split the view's logic awkwardly. Search-panel can revisit when a watch-side search filter lands.

The acceptance criterion "≥4 screens share one component" is met by the four migrations above.

## Architecture

Three units, each independently testable:

### 1. `useEntityData<K>` — data hook

`src/tui/hooks/use-entity-data.ts`. Collapses the dual-path (informer cache + polled fallback) currently inlined in every list view.

```ts
export function useEntityData<K extends WatchKind>(
  kind: K,
  opts: {
    readonly predicate?: (e: EntityFor<K>) => boolean;
    readonly sort?: (a: EntityFor<K>, b: EntityFor<K>) => number;
    readonly limit?: number;
    readonly fallbackFetcher?: () => Promise<readonly EntityFor<K>[]>;
    readonly active: boolean;
  },
): {
  readonly data: readonly EntityFor<K>[];
  readonly loading: boolean;
  readonly isStale: boolean;
  readonly error: Error | undefined;
};
```

Internal flow:
1. `useEntityWatchEnabled(provider, kind)` → `useInformerPath`.
2. `useEntities(kind, predicate)` always called (stable hook order across re-renders even when path flips).
3. `useEventDrivenData(fallbackFetcher, …, active && !useInformerPath && !!fallbackFetcher)`.
4. memoize: if `useInformerPath`, apply `sort` then `limit` to the informer snapshot; else return polled data.
5. Merge `loading`/`isStale`/`error` from the active branch.

Both branches are evaluated each render to keep React's hook order stable when `useEntityWatchEnabled` toggles (already a known concern in current views).

### 2. `EntityView<K>` — component

`src/tui/components/entity-view.tsx`. Pure render layer atop `useEntityData` and `Table`.

```tsx
export interface EntityColumn<E> {
  readonly header: string;
  readonly key: string;                       // stable id; row-map column key
  readonly width?: number;
  readonly align?: "left" | "right";
  readonly render: (entity: E) => string;
}

export interface EntityHint {
  readonly key: string;                       // "d", "ctrl+k", …
  readonly label: string;                     // "delete", "kill", …
}

export interface EntityViewProps<K extends WatchKind> {
  readonly kind: K;
  readonly columns: readonly EntityColumn<EntityFor<K>>[];
  readonly provider: unknown;                 // forwarded to useEntityWatchEnabled

  readonly predicate?: (e: EntityFor<K>) => boolean;
  readonly sort?: (a: EntityFor<K>, b: EntityFor<K>) => number;
  readonly offset?: number;                   // pagination start
  readonly limit?: number;                    // pagination length
  readonly fallbackFetcher?: () => Promise<readonly EntityFor<K>[]>;

  readonly title?: string;
  readonly headerSuffix?: React.ReactNode;    // extra header content after DataStatus
  readonly emptyTitle?: string;
  readonly emptyHint?: string;

  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: (n: number) => void;
  readonly onSelect?: (entity: EntityFor<K> | undefined) => void;
  readonly onDataChanged?: (data: readonly EntityFor<K>[]) => void;

  readonly hints?: readonly EntityHint[];     // for C3 hint bar; no key handlers installed
}
```

Render body:

```tsx
const { data, loading, isStale, error } = useEntityData(kind, { predicate, sort, limit, fallbackFetcher, active });
const rows = useMemo(
  () => data.map(e => Object.fromEntries(columns.map(c => [c.key, c.render(e)]))),
  [data, columns],
);
useEffect(() => onSelect?.(data[cursor]), [cursor, data, onSelect]);
useEffect(() => onRowCountChanged?.(data.length), [data.length, onRowCountChanged]);

if (loading && data.length === 0) return <text opacity={0.5}>Loading {kind.toLowerCase()}…</text>;
return (
  <box flexDirection="column">
    {title && <Header title rowCount={data.length} loading={loading} isStale={isStale} error={error} />}
    {data.length === 0
      ? <EmptyState title={emptyTitle ?? `No ${kind.toLowerCase()}.`} hint={emptyHint} />
      : <Table columns={[...columns]} rows={rows} cursor={cursor} maxRows={MAX_ROWS} />}
  </box>
);
```

`MAX_ROWS = 500`. The current `Table` already does cursor-centered windowing via `MAX_RENDER_ITEMS`; raising it to 500 satisfies the acceptance criterion. If real-terminal measurement shows 60fps regression, file a follow-up to add viewport-sized windowing.

### 2a. `EntityFor<K>` consolidation

Currently re-derived locally in `entity-store.ts`, `use-entities.ts`, `use-entity.ts`. As part of step 1 of the migration plan, export the existing `EntityForKind<K>` from `src/core/informer.ts` (already defined there, just not exported) and switch the three callers to import it. EntityView and `useEntityData` import the same type. No behavior change.

### 3. Columns library

`src/tui/components/columns/`:

- `claim-columns.ts` — `CLAIM_ID`, `TARGET`, `AGENT`, `STATUS`, `LEASE`, `HEARTBEAT`, `INTENT`.
- `contribution-columns.ts` — `CID`, `KIND`, `SUMMARY`, `AGENT`, `TAGS`, `TIME`.
- `agent-columns.ts` — `AGENT_ID`, `ROLE`, `PLATFORM`, `STATUS`, `COST`, `SESSION`. Some columns close over a join context (tmux sessions, cost map) — exposed as factory functions: `agentStatusColumn(ctx: AgentJoinCtx)`.

Columns are plain consts/factories — no React, no hooks. Importable across views.

## Data flow

```
EntityStore (B1) → useEntities(kind, predicate) → useEntityData ─┐
                                                                  ├→ EntityView → Table
provider.getX (fallback)  → useEventDrivenData ──────────────────┘
```

EntityView is a passive consumer. It does not own informer/store lifecycle (those are managed by `informer-context.tsx` / `EntityStoreFactory`). On unmount it relinquishes its subscriptions via the underlying hooks.

## Migration plan (one commit per row)

1. Land `EntityView` + `useEntityData` + columns library skeleton + tests. No view migrations yet. Confirms the abstraction compiles, tests pass, no callers broken.
2. Migrate `claims.tsx` — canonical reference. Wrapper preserves the `isScoped → []` short-circuit by rendering a standalone `<EmptyState />` (with the existing scope hint) when `isScoped` is true, instead of mounting EntityView with empty data. EntityView mounts only on the unscoped path.
3. Migrate `activity-panel.tsx`.
4. Migrate `activity.tsx`.
5. Migrate `agent-list.tsx` — wrapper retains the claims × tmux × cost join; passes derived columns to EntityView via factory functions that close over the join context.

Each step keeps existing view-level tests green. Net deletion: ~500 lines of duplicated dual-path / row-mapping / loading-state code across the 4 files, replaced by ~250 lines of EntityView + columns library.

## Testing

**Unit — `entity-view.test.tsx`**:
- Title + count rendered from data length.
- Empty state when filtered data is empty.
- Loading state when informer not synced and no data.
- Error surfaces in `DataStatus`.
- `onSelect(data[cursor])` fires on cursor change.
- `predicate` filters before `sort` before `limit`.
- `onRowCountChanged` fires only when count changes (no churn on identical counts).
- Hook order stable when `useEntityWatchEnabled` toggles mid-mount.

**Hook — `use-entity-data.test.ts`**:
- Informer path: returns sorted/sliced snapshot, `loading=false` after sync.
- Polled path (no informer): returns fallback fetcher result, respects `active=false`.
- Path switch: cleanly transitions when `useEntityWatchEnabled` flips.
- Both hooks (`useEntities`, `useEventDrivenData`) always called regardless of path.

**Performance — `entity-view.perf.test.tsx`** (skipped in CI, runnable locally):
- Mount EntityView with 500 synthetic entities.
- Run 100 cursor moves; measure `useMemo` cost.
- Assert p95 < 16ms (60fps budget).

**Migration regressions**:
- Existing tests for `claims.tsx`, `activity.tsx`, `activity-panel.tsx`, `agent-list.tsx`, `search-panel.tsx` stay green after each port (they test view output, not internals). `entity-store.burst.test.ts` (10k events) already covers the underlying store; EntityView inherits its guarantees through `useEntities`.

## Acceptance criteria mapping

| Criterion (issue #301) | How met |
|------|------|
| ≥4 screens share one component | 4 view files (claims, activity, activity-panel, agent-list) |
| Adding new kind = config file + renderer fn, no new component | Demonstrated by `claim-columns.ts`/`contribution-columns.ts`/`agent-columns.ts` lib + the `<EntityView kind="X" columns={X_COLUMNS} />` migration pattern |
| 500-row list scrolls at 60fps | `MAX_ROWS=500` window + perf test asserting <16ms p95 cursor-move cost |

## Open questions / follow-ups

- If the perf test fails on real terminals, viewport-sized virtualization becomes a follow-up issue (replace Table's window-of-N with a height-aware window).
- Cross-cutting columns (e.g. AGENT) used by both Claim and Contribution views — for now, each domain has its own columns lib. If duplication appears, extract to `shared-columns.ts`. Don't pre-extract.
- `useDerived`-style joins (agent-list's claims × tmux × cost) stay in the view wrapper. If multiple views need similar joins, consider a separate `useEntityJoin` hook in a later issue. Out of scope here.
