# C1 — Generic EntityView Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `<EntityView kind columns … />` in `src/tui/components/`, port 5 list views to it, end the duplicated dual-path data fetching across the TUI.

**Architecture:** Three units — `useEntityData<K>` (data hook collapsing informer + polled fallback), `EntityView<K>` (pure render layer atop Table), and a `columns/` library (per-kind column factories). Migration is one commit per view.

**Tech Stack:** TypeScript, React 18 + react-test-renderer, OpenTUI intrinsics, bun:test, Biome.

**Spec:** `docs/superpowers/specs/2026-05-06-c1-entity-view-design.md`

---

## File Structure

**Created:**
- `src/tui/hooks/use-entity-data.ts` — data hook
- `src/tui/hooks/use-entity-data.test.ts` — pure-helper unit tests
- `src/tui/hooks/use-entity-data.mount.test.tsx` — mount-level integration test
- `src/tui/components/entity-view.tsx` — render component
- `src/tui/components/entity-view.test.tsx` — mount-level component tests
- `src/tui/components/entity-view.perf.test.tsx` — 500-row perf test (skipped in CI)
- `src/tui/components/columns/claim-columns.ts` — Claim column factories
- `src/tui/components/columns/contribution-columns.ts` — Contribution column factories
- `src/tui/components/columns/agent-columns.ts` — Agent column factories (with join-context)

**Modified:**
- `src/core/informer.ts` — export `EntityForKind<K>`
- `src/tui/data/entity-store.ts` — import `EntityForKind` (replace local type alias)
- `src/tui/hooks/use-entities.ts` — import `EntityForKind` (replace local type alias)
- `src/tui/hooks/use-entity.ts` — import `EntityForKind` (replace local type alias)
- `src/tui/components/table.tsx` — raise `MAX_RENDER_ITEMS` from 200 to 500
- `src/tui/views/claims.tsx` — port to EntityView
- `src/tui/views/activity-panel.tsx` — port to EntityView
- `src/tui/views/activity.tsx` — port to EntityView
- `src/tui/views/agent-list.tsx` — port to EntityView (with join wrapper)
- `src/tui/views/search-panel.tsx` — **NOT migrated in this PR.** The contribution result table needs server-side full-text search when `searchQuery` is non-empty (provider's `getContributions({ search })`), which the EntityStore predicate path can't model. The transcript result table renders local in-memory data, also not EntityStore-backed. Search-panel stays on `<Table>` for now; revisit if a watch-side search filter lands.

---

## Task 0: Foundation — export `EntityForKind<K>`

**Files:**
- Modify: `src/core/informer.ts:19`
- Modify: `src/tui/data/entity-store.ts:23`
- Modify: `src/tui/hooks/use-entities.ts:42`
- Modify: `src/tui/hooks/use-entity.ts:28`

- [ ] **Step 1: Export the existing type alias**

In `src/core/informer.ts:19`, change:
```ts
type EntityForKind<K extends WatchKind> = K extends "Contribution"
```
to:
```ts
export type EntityForKind<K extends WatchKind> = K extends "Contribution"
```

- [ ] **Step 2: Replace local alias in `entity-store.ts`**

Replace the local definition at `src/tui/data/entity-store.ts:23`:
```ts
type EntityFor<K extends WatchKind> = ReturnType<Informer<K>["list"]>[number];
```
with an import (top of file, alongside existing imports):
```ts
import type { EntityForKind } from "../../core/informer.js";
```
Then `find-and-replace` `EntityFor<` → `EntityForKind<` in that file.

- [ ] **Step 3: Replace local alias in `use-entities.ts`**

At `src/tui/hooks/use-entities.ts:42`, delete:
```ts
type EntityFor<K extends WatchKind> = ReturnType<Informer<K>["list"]>[number];
```
Add to imports:
```ts
import type { EntityForKind } from "../../core/informer.js";
```
Find-and-replace `EntityFor<` → `EntityForKind<` in this file.

- [ ] **Step 4: Replace local alias in `use-entity.ts`**

At `src/tui/hooks/use-entity.ts:28`, delete the local type. Note this one uses `NonNullable<ReturnType<Informer<K>["getById"]>>` — that's a different shape (no-undefined). Keep the local alias OR rename to avoid collision; recommended: leave `use-entity.ts` alone (it's `getById`-shaped, not `list`-shaped). Skip this step.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS — no errors.

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: PASS — no behavior change, only type renames.

- [ ] **Step 7: Commit**

```bash
git add src/core/informer.ts src/tui/data/entity-store.ts src/tui/hooks/use-entities.ts
git commit -m "refactor(core): export EntityForKind<K> for reuse in EntityView"
```

---

## Task 1: `useEntityData<K>` — pure helpers

**Files:**
- Create: `src/tui/hooks/use-entity-data.ts`
- Create: `src/tui/hooks/use-entity-data.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/hooks/use-entity-data.test.ts`:

```ts
/**
 * Tests for useEntityData pure helpers.
 */
import { describe, expect, test } from "bun:test";
import { applyEntityShape } from "./use-entity-data.js";

describe("applyEntityShape", () => {
  const e = (id: string, ts: number) => ({ id, _ts: ts }) as unknown as { id: string; _ts: number };

  test("no opts → input array reference returned", () => {
    const list = [e("a", 1), e("b", 2)];
    expect(applyEntityShape(list, {})).toBe(list);
  });

  test("predicate filters", () => {
    const list = [e("a", 1), e("b", 2)];
    expect(applyEntityShape(list, { predicate: (x) => x.id === "b" })).toEqual([e("b", 2)]);
  });

  test("sort orders by comparator (desc on _ts)", () => {
    const list = [e("a", 1), e("b", 3), e("c", 2)];
    const sorted = applyEntityShape(list, { sort: (x, y) => y._ts - x._ts });
    expect(sorted.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  test("limit slices after sort", () => {
    const list = [e("a", 1), e("b", 3), e("c", 2)];
    const out = applyEntityShape(list, { sort: (x, y) => y._ts - x._ts, limit: 2 });
    expect(out.map((x) => x.id)).toEqual(["b", "c"]);
  });

  test("predicate before sort before limit", () => {
    const list = [e("a", 1), e("b", 3), e("c", 2), e("d", 4)];
    const out = applyEntityShape(list, {
      predicate: (x) => x._ts > 1,
      sort: (x, y) => x._ts - y._ts,
      limit: 2,
    });
    expect(out.map((x) => x.id)).toEqual(["c", "b"]);
  });

  test("offset skips first N after sort", () => {
    const list = [e("a", 1), e("b", 2), e("c", 3)];
    const out = applyEntityShape(list, { sort: (x, y) => x._ts - y._ts, offset: 1, limit: 2 });
    expect(out.map((x) => x.id)).toEqual(["b", "c"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/hooks/use-entity-data.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helper + hook scaffold**

Create `src/tui/hooks/use-entity-data.ts`:

```ts
/**
 * useEntityData — collapses the dual-path (informer cache + polled
 * fallback) currently inlined in every list view. Both `useEntities`
 * and `useEventDrivenData` are always called to keep React's hook
 * order stable when `useEntityWatchEnabled` toggles.
 */

import { useCallback, useMemo } from "react";
import type { EntityForKind } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useEntityWatchEnabled } from "./informer-context.js";
import { useEntities } from "./use-entities.js";
import { useEventDrivenData } from "./use-event-driven-data.js";

export interface EntityShapeOpts<E> {
  readonly predicate?: (e: E) => boolean;
  readonly sort?: (a: E, b: E) => number;
  readonly offset?: number;
  readonly limit?: number;
}

/** Pure: predicate → sort → offset/limit. Exported for unit tests. */
export function applyEntityShape<E>(list: readonly E[], opts: EntityShapeOpts<E>): readonly E[] {
  let out: readonly E[] = list;
  if (opts.predicate) out = out.filter(opts.predicate);
  if (opts.sort) out = [...out].sort(opts.sort);
  const offset = opts.offset ?? 0;
  if (offset > 0 || opts.limit !== undefined) {
    const end = opts.limit !== undefined ? offset + opts.limit : undefined;
    out = out.slice(offset, end);
  }
  return out;
}

export interface UseEntityDataOpts<K extends WatchKind> extends EntityShapeOpts<EntityForKind<K>> {
  readonly fallbackFetcher?: () => Promise<readonly EntityForKind<K>[]>;
  readonly active: boolean;
}

export interface UseEntityDataResult<K extends WatchKind> {
  readonly data: readonly EntityForKind<K>[];
  readonly loading: boolean;
  readonly isStale: boolean;
  readonly error: Error | undefined;
}

export function useEntityData<K extends WatchKind>(
  provider: unknown,
  kind: K,
  opts: UseEntityDataOpts<K>,
): UseEntityDataResult<K> {
  const useInformerPath = useEntityWatchEnabled(provider, kind);

  // Both branches always evaluated: stable hook order across path flips.
  const entityResult = useEntities(kind, opts.predicate);

  const fetcher = useCallback(async () => {
    if (!opts.fallbackFetcher) return [] as readonly EntityForKind<K>[];
    return opts.fallbackFetcher();
  }, [opts.fallbackFetcher]);

  const polled = useEventDrivenData<readonly EntityForKind<K>[]>(
    fetcher,
    undefined,
    undefined,
    opts.active && !useInformerPath && !!opts.fallbackFetcher,
  );

  const data = useMemo<readonly EntityForKind<K>[]>(() => {
    if (useInformerPath) {
      // entityResult.data already had `predicate` applied inside useEntities.
      // Apply only sort + offset/limit here to avoid double-filtering.
      return applyEntityShape(entityResult.data, {
        sort: opts.sort,
        offset: opts.offset,
        limit: opts.limit,
      });
    }
    if (polled.data === null) return [];
    // Polled fallback: predicate was NOT applied by the hook — apply here.
    return applyEntityShape(polled.data, opts);
  }, [
    useInformerPath,
    entityResult.data,
    polled.data,
    opts.sort,
    opts.offset,
    opts.limit,
    opts.predicate,
  ]);

  return {
    data,
    loading: useInformerPath
      ? !entityResult.hasSynced && data.length === 0
      : polled.loading && polled.data === null,
    isStale: useInformerPath ? false : polled.isStale,
    error: useInformerPath ? (entityResult.error ?? undefined) : (polled.error ?? undefined),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/hooks/use-entity-data.test.ts`
Expected: PASS — all `applyEntityShape` cases.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/hooks/use-entity-data.ts src/tui/hooks/use-entity-data.test.ts
git commit -m "feat(tui): useEntityData hook collapsing dual-path informer/polled fetch"
```

---

## Task 2: `useEntityData` — mount integration test

**Files:**
- Create: `src/tui/hooks/use-entity-data.mount.test.tsx`

- [ ] **Step 1: Write the integration test**

Create `src/tui/hooks/use-entity-data.mount.test.tsx`:

```tsx
/**
 * Mount integration: useEntityData under InformerProvider + EntityStoreProvider.
 * Mirrors use-entities.store-backed.test.tsx setup.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "./entity-store-context.js";
import { InformerProvider } from "./informer-context.js";
import { useEntityData } from "./use-entity-data.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NS = "default";

function entity(id: string, ts: string): WatchEntity {
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
    } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "1",
    metadata: { generation: 1, creationTimestamp: ts },
  };
}

function Probe({ onResult, provider }: { onResult: (r: unknown) => void; provider: unknown }) {
  const r = useEntityData(provider, "Contribution", {
    sort: (a, b) =>
      (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""),
    limit: 2,
    active: true,
  });
  onResult(r);
  return null;
}

describe("useEntityData — mount integration", () => {
  test("informer path: returns sorted+sliced entity snapshot", async () => {
    const hub = new WatchHub();
    const informerFactory = new InformerFactory({
      mode: "remote",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    const provider = { hasSessionScope: () => false };

    let last: { data: readonly WatchEntity[]; loading: boolean } = {
      data: [],
      loading: true,
    };
    await act(async () => {
      TestRenderer.create(
        (
          <InformerProvider value={informerFactory} eager>
            <EntityStoreProvider value={storeFactory}>
              <Probe
                provider={provider}
                onResult={(r) => {
                  last = r as typeof last;
                }}
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
    });

    await act(async () => {
      hub.emit({
        type: "ADDED",
        kind: "Contribution",
        namespace: NS,
        entity: entity("a", "2026-01-01T00:00:00Z"),
      });
      hub.emit({
        type: "ADDED",
        kind: "Contribution",
        namespace: NS,
        entity: entity("b", "2026-01-02T00:00:00Z"),
      });
      hub.emit({
        type: "ADDED",
        kind: "Contribution",
        namespace: NS,
        entity: entity("c", "2026-01-03T00:00:00Z"),
      });
    });

    expect(last.data.map((e) => e.id)).toEqual(["c", "b"]); // sorted desc, limit 2
  });

  test("polled fallback: when no InformerProvider, calls fetcher", async () => {
    let calls = 0;
    const provider = {};

    function PolledProbe({ onResult }: { onResult: (r: unknown) => void }) {
      const r = useEntityData(provider, "Contribution", {
        active: true,
        fallbackFetcher: async () => {
          calls += 1;
          return [entity("p", "2026-01-01T00:00:00Z")] as readonly WatchEntity[];
        },
      });
      onResult(r);
      return null;
    }

    let last: { data: readonly WatchEntity[]; loading: boolean } = {
      data: [],
      loading: true,
    };
    await act(async () => {
      TestRenderer.create(
        (
          <PolledProbe
            onResult={(r) => {
              last = r as typeof last;
            }}
          />
        ) as React.ReactElement,
      );
    });
    // Allow the fetcher's microtask to settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(last.data.map((e) => e.id)).toEqual(["p"]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test src/tui/hooks/use-entity-data.mount.test.tsx`
Expected: PASS — both informer and polled paths.

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/use-entity-data.mount.test.tsx
git commit -m "test(tui): mount integration for useEntityData (informer + polled paths)"
```

---

## Task 3: `EntityView` component skeleton + tests

**Files:**
- Create: `src/tui/components/entity-view.tsx`
- Create: `src/tui/components/entity-view.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `src/tui/components/entity-view.test.tsx`:

```tsx
/**
 * Mount tests for EntityView: header, empty state, row mapping, onSelect.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "../hooks/entity-store-context.js";
import { InformerProvider } from "../hooks/informer-context.js";
import { EntityView } from "./entity-view.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NS = "default";

function entity(id: string): WatchEntity {
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
    } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: "1",
    metadata: { generation: 1, creationTimestamp: "2026-01-01T00:00:00Z" },
  };
}

const COLUMNS = [
  { header: "ID", key: "id", width: 8, render: (e: WatchEntity) => e.id },
] as const;

function mountWithEntities(
  entities: readonly WatchEntity[],
  props: Partial<{ cursor: number; onSelect: (e: WatchEntity | undefined) => void }> = {},
): { hub: WatchHub; renderer: TestRenderer.ReactTestRenderer } {
  const hub = new WatchHub();
  const informerFactory = new InformerFactory({
    mode: "remote",
    hub,
    namespace: NS,
    listFn: () => [],
  });
  const storeFactory = new EntityStoreFactory(informerFactory);
  const provider = { hasSessionScope: () => false };

  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(
      (
        <InformerProvider value={informerFactory} eager>
          <EntityStoreProvider value={storeFactory}>
            <EntityView
              kind="Contribution"
              columns={[...COLUMNS]}
              provider={provider}
              active={true}
              cursor={props.cursor ?? -1}
              {...(props.onSelect ? { onSelect: props.onSelect } : {})}
              title="TestView"
              emptyTitle="(none)"
            />
          </EntityStoreProvider>
        </InformerProvider>
      ) as React.ReactElement,
    );
  });
  for (const e of entities) {
    TestRenderer.act(() => {
      hub.emit({ type: "ADDED", kind: "Contribution", namespace: NS, entity: e });
    });
  }
  return { hub, renderer };
}

describe("EntityView", () => {
  test("renders empty state when no data", async () => {
    const { renderer } = mountWithEntities([]);
    const tree = renderer.toJSON();
    const flat = JSON.stringify(tree);
    expect(flat).toContain("(none)");
  });

  test("renders title and rows when data present", async () => {
    const { renderer } = mountWithEntities([entity("a"), entity("b")]);
    await act(async () => {
      await Promise.resolve();
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("TestView");
    expect(flat).toContain("a");
    expect(flat).toContain("b");
  });

  test("onSelect fires with entity at cursor", async () => {
    let selected: WatchEntity | undefined;
    const { renderer } = mountWithEntities([entity("a"), entity("b")], {
      cursor: 1,
      onSelect: (e) => {
        selected = e;
      },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(selected?.id).toBeDefined();
    renderer.unmount();
  });

  test("onDataChanged fires with current entity slice", async () => {
    let received: readonly WatchEntity[] = [];
    const hub = new WatchHub();
    const factory = new InformerFactory({ mode: "remote", hub, namespace: NS, listFn: () => [] });
    const storeFactory = new EntityStoreFactory(factory);
    TestRenderer.act(() => {
      TestRenderer.create(
        (
          <InformerProvider value={factory} eager>
            <EntityStoreProvider value={storeFactory}>
              <EntityView
                kind="Contribution"
                columns={[...COLUMNS]}
                provider={{ hasSessionScope: () => false }}
                active={true}
                cursor={-1}
                onDataChanged={(d) => {
                  received = d;
                }}
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
    });
    TestRenderer.act(() => {
      hub.emit({ type: "ADDED", kind: "Contribution", namespace: NS, entity: entity("x") });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(received.map((e) => e.id)).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/components/entity-view.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement EntityView**

Create `src/tui/components/entity-view.tsx`:

```tsx
/**
 * EntityView<K> — generic kind-parameterized list view.
 *
 * Replaces the duplicated dual-path data wiring across claims,
 * agent-list, activity, and activity-panel. Owns:
 *   - data fetch (via useEntityData)
 *   - row mapping from columns[].render(entity)
 *   - title/count header (DataStatus)
 *   - empty state
 *   - cursor → onSelect / onRowCountChanged
 *
 * Does NOT install keyboard handlers. `hints` is metadata for the
 * C3 hint bar (#309) and C2 command prompt (#302). Mutation goes
 * through confirmAndMutate (C6, #304), not EntityView.
 */

import React, { useEffect, useMemo } from "react";
import type { EntityForKind } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useEntityData } from "../hooks/use-entity-data.js";
import { DataStatus } from "./data-status.js";
import { EmptyState } from "./empty-state.js";
import { Table, type TableColumn } from "./table.js";

export interface EntityColumn<E> {
  readonly header: string;
  readonly key: string;
  readonly width?: number;
  readonly align?: "left" | "right";
  readonly render: (entity: E) => string;
}

export interface EntityHint {
  readonly key: string;
  readonly label: string;
}

export interface EntityViewProps<K extends WatchKind> {
  readonly kind: K;
  readonly columns: readonly EntityColumn<EntityForKind<K>>[];
  readonly provider: unknown;
  readonly active: boolean;
  readonly cursor: number;

  readonly predicate?: (e: EntityForKind<K>) => boolean;
  readonly sort?: (a: EntityForKind<K>, b: EntityForKind<K>) => number;
  readonly offset?: number;
  readonly limit?: number;
  readonly fallbackFetcher?: () => Promise<readonly EntityForKind<K>[]>;

  readonly title?: string;
  readonly headerSuffix?: React.ReactNode;
  readonly emptyTitle?: string;
  readonly emptyHint?: string;

  readonly onRowCountChanged?: (n: number) => void;
  readonly onSelect?: (entity: EntityForKind<K> | undefined) => void;
  readonly onDataChanged?: (data: readonly EntityForKind<K>[]) => void;

  readonly hints?: readonly EntityHint[];
}

const MAX_ROWS = 500;

function EntityViewInner<K extends WatchKind>(props: EntityViewProps<K>): React.ReactNode {
  const {
    kind,
    columns,
    provider,
    active,
    cursor,
    predicate,
    sort,
    offset,
    limit,
    fallbackFetcher,
    title,
    headerSuffix,
    emptyTitle,
    emptyHint,
    onRowCountChanged,
    onSelect,
    onDataChanged,
  } = props;

  const opts: Parameters<typeof useEntityData<K>>[2] = { active };
  if (predicate) opts.predicate = predicate;
  if (sort) opts.sort = sort;
  if (offset !== undefined) opts.offset = offset;
  if (limit !== undefined) opts.limit = limit;
  if (fallbackFetcher) opts.fallbackFetcher = fallbackFetcher;

  const { data, loading, isStale, error } = useEntityData<K>(provider, kind, opts);

  const rows = useMemo<readonly Record<string, string>[]>(
    () =>
      data.map((entity) => {
        const row: Record<string, string> = {};
        for (const col of columns) row[col.key] = col.render(entity);
        return row;
      }),
    [data, columns],
  );

  const tableColumns = useMemo<readonly TableColumn[]>(
    () =>
      columns.map((c) => ({
        header: c.header,
        key: c.key,
        width: c.width,
        align: c.align,
      })),
    [columns],
  );

  useEffect(() => {
    if (onRowCountChanged) onRowCountChanged(data.length);
  }, [data.length, onRowCountChanged]);

  useEffect(() => {
    if (!onSelect) return;
    onSelect(cursor >= 0 && cursor < data.length ? data[cursor] : undefined);
  }, [cursor, data, onSelect]);

  useEffect(() => {
    if (onDataChanged) onDataChanged(data);
  }, [data, onDataChanged]);

  if (loading && data.length === 0) {
    return (
      <box>
        <text opacity={0.5}>{`Loading ${String(kind).toLowerCase()}...`}</text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      {title !== undefined && (
        <box marginBottom={1} flexDirection="row">
          <text>{`${title} (${data.length})`}</text>
          <DataStatus loading={false} isStale={isStale} error={error?.message} />
          {headerSuffix}
        </box>
      )}
      {data.length === 0 ? (
        <EmptyState
          title={emptyTitle ?? `No ${String(kind).toLowerCase()}.`}
          {...(emptyHint ? { hint: emptyHint } : {})}
        />
      ) : (
        <Table columns={[...tableColumns]} rows={rows} cursor={cursor} maxRows={MAX_ROWS} />
      )}
    </box>
  );
}

export const EntityView = React.memo(EntityViewInner) as <K extends WatchKind>(
  props: EntityViewProps<K>,
) => React.ReactNode;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/components/entity-view.test.tsx`
Expected: PASS — all 3 tests.

- [ ] **Step 5: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/entity-view.tsx src/tui/components/entity-view.test.tsx
git commit -m "feat(tui): EntityView<K> generic list component (C1, #301)"
```

---

## Task 4: Raise Table windowing to 500 + perf test

**Files:**
- Modify: `src/tui/components/table.tsx:21`
- Create: `src/tui/components/entity-view.perf.test.tsx`

- [ ] **Step 1: Raise the cap**

In `src/tui/components/table.tsx:21`, change:
```ts
const MAX_RENDER_ITEMS = 200;
```
to:
```ts
const MAX_RENDER_ITEMS = 500;
```

- [ ] **Step 2: Update existing Table tests if any windowing assertion uses 200**

Run: `bun test src/tui/components/table.test.ts`
Expected: PASS. If any test hard-codes 200 in `computeWindow`, update the local mirror to 500.

- [ ] **Step 3: Add perf test**

Create `src/tui/components/entity-view.perf.test.tsx`:

```tsx
/**
 * Skipped in CI; runnable locally for the #301 acceptance criterion
 * "500-row list scrolls at 60fps".
 *
 * Mounts EntityView with 500 synthetic entities, performs 100 cursor
 * moves, asserts p95 useMemo+render cost < 16ms.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { InformerFactory } from "../../core/informer.js";
import type { WatchEntity } from "../../core/watch-events.js";
import { WatchHub } from "../../core/watch-hub.js";
import { EntityStoreFactory } from "../data/entity-store.js";
import { EntityStoreProvider } from "../hooks/entity-store-context.js";
import { InformerProvider } from "../hooks/informer-context.js";
import { EntityView } from "./entity-view.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NS = "default";
const COLUMNS = [
  { header: "ID", key: "id", width: 8, render: (e: WatchEntity) => e.id },
  { header: "SUM", key: "sum", width: 24, render: (e: WatchEntity) => e.id.repeat(3) },
] as const;
function entity(i: number): WatchEntity {
  return {
    kind: "Contribution",
    namespace: NS,
    id: `c${i}`,
    spec: {
      contributionKind: "code",
      mode: "direct",
      summary: `s${i}`,
      artifacts: {},
      relations: [],
      tags: [],
    } as never,
    status: {},
    conditions: [],
    observedGeneration: 0,
    resourceVersion: String(i),
    metadata: { generation: 1, creationTimestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` },
  };
}

const ENABLED = process.env.RUN_PERF === "1";

describe.skipIf(!ENABLED)("EntityView perf", () => {
  test("500 rows × 100 cursor moves: p95 render < 16ms", async () => {
    const hub = new WatchHub();
    const informerFactory = new InformerFactory({
      mode: "remote",
      hub,
      namespace: NS,
      listFn: () => [],
    });
    const storeFactory = new EntityStoreFactory(informerFactory);
    const provider = { hasSessionScope: () => false };
    let cursor = 0;
    let renderer!: TestRenderer.ReactTestRenderer;

    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        (
          <InformerProvider value={informerFactory} eager>
            <EntityStoreProvider value={storeFactory}>
              <EntityView
                kind="Contribution"
                columns={[...COLUMNS]}
                provider={provider}
                active={true}
                cursor={cursor}
                title="Perf"
              />
            </EntityStoreProvider>
          </InformerProvider>
        ) as React.ReactElement,
      );
    });
    for (let i = 0; i < 500; i += 1) {
      TestRenderer.act(() => {
        hub.emit({ type: "ADDED", kind: "Contribution", namespace: NS, entity: entity(i) });
      });
    }

    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      cursor = i;
      const t0 = performance.now();
      await act(async () => {
        renderer.update(
          (
            <InformerProvider value={informerFactory} eager>
              <EntityStoreProvider value={storeFactory}>
                <EntityView
                  kind="Contribution"
                  columns={[...COLUMNS]}
                  provider={provider}
                  active={true}
                  cursor={cursor}
                  title="Perf"
                />
              </EntityStoreProvider>
            </InformerProvider>
          ) as React.ReactElement,
        );
      });
      samples.push(performance.now() - t0);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(16);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `bun test src/tui/components/`
Expected: PASS — perf test skipped (ENABLED=false).

- [ ] **Step 5: Optional — verify perf locally**

Run: `RUN_PERF=1 bun test src/tui/components/entity-view.perf.test.tsx`
Expected: PASS — p95 < 16ms on a typical dev machine.

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/table.tsx src/tui/components/entity-view.perf.test.tsx
git commit -m "perf(tui): raise Table windowing to 500 rows + EntityView perf gate"
```

---

## Task 5: Columns library — Contribution

**Files:**
- Create: `src/tui/components/columns/contribution-columns.ts`

- [ ] **Step 1: Write the columns module**

Create `src/tui/components/columns/contribution-columns.ts`:

```ts
/**
 * Reusable Contribution columns for EntityView. Imported by activity,
 * activity-panel, and search-panel to keep column definitions DRY.
 */

import type { ContributionEntity } from "../../../core/entity.js";
import { compareTimestampsDesc, formatTimestamp, truncateCid } from "../../../shared/format.js";
import type { EntityColumn } from "../entity-view.js";

const trunc = (s: string | undefined, max: number): string =>
  !s ? "" : s.length > max ? `${s.slice(0, max - 2)}..` : s;

export const cidColumn = (width = 22): EntityColumn<ContributionEntity> => ({
  header: "CID",
  key: "cid",
  width,
  render: (e) => truncateCid(e.id),
});

export const kindColumn = (width = 14): EntityColumn<ContributionEntity> => ({
  header: "KIND",
  key: "kind",
  width,
  render: (e) => e.spec.contributionKind,
});

export const modeColumn = (width = 12): EntityColumn<ContributionEntity> => ({
  header: "MODE",
  key: "mode",
  width,
  render: (e) => e.spec.mode,
});

export const summaryColumn = (width = 36): EntityColumn<ContributionEntity> => ({
  header: "SUMMARY",
  key: "summary",
  width,
  render: (e) => trunc(e.spec.summary, width),
});

export const agentColumn = (width = 16): EntityColumn<ContributionEntity> => ({
  header: "AGENT",
  key: "agent",
  width,
  render: (e) =>
    e.spec.agent?.role ?? e.spec.agent?.agentName ?? e.spec.agent?.agentId ?? "unknown",
});

export const tagsColumn = (width = 16, max = 3): EntityColumn<ContributionEntity> => ({
  header: "TAGS",
  key: "tags",
  width,
  render: (e) => (e.spec.tags ?? []).slice(0, max).join(", "),
});

export const createdColumn = (
  header = "CREATED",
  width = 12,
): EntityColumn<ContributionEntity> => ({
  header,
  key: "created",
  width,
  render: (e) => formatTimestamp(e.metadata.creationTimestamp ?? ""),
});

/** Sort: newest first by creationTimestamp. */
export const byCreatedDesc = (a: ContributionEntity, b: ContributionEntity): number =>
  compareTimestampsDesc(a.metadata.creationTimestamp, b.metadata.creationTimestamp);
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/columns/contribution-columns.ts
git commit -m "feat(tui): contribution-columns library for EntityView"
```

---

## Task 6: Migrate `activity-panel.tsx`

**Files:**
- Modify: `src/tui/views/activity-panel.tsx` (full rewrite)

- [ ] **Step 1: Replace the file with the EntityView wrapper**

Overwrite `src/tui/views/activity-panel.tsx`:

```tsx
/**
 * Activity panel — recent contributions, EntityView-backed.
 */

import React from "react";
import {
  agentColumn,
  byCreatedDesc,
  cidColumn,
  createdColumn,
  kindColumn,
  summaryColumn,
  tagsColumn,
} from "../components/columns/contribution-columns.js";
import { EntityView } from "../components/entity-view.js";
import type { TuiDataProvider } from "../provider.js";

export interface ActivityPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

const COLUMNS = [
  cidColumn(16),
  kindColumn(12),
  summaryColumn(32),
  agentColumn(14),
  tagsColumn(14, 2),
  createdColumn("TIME", 10),
];

const PANEL_LIMIT = 30;

export const ActivityPanelView: React.NamedExoticComponent<ActivityPanelProps> = React.memo(
  function ActivityPanelView(props: ActivityPanelProps): React.ReactNode {
    return (
      <EntityView
        kind="Contribution"
        columns={COLUMNS}
        provider={props.provider}
        active={props.active}
        cursor={props.cursor}
        sort={byCreatedDesc}
        limit={PANEL_LIMIT}
        title="Activity"
        emptyTitle="No recent activity."
        emptyHint="Activity appears as agents publish contributions."
        {...(props.onRowCountChanged ? { onRowCountChanged: props.onRowCountChanged } : {})}
      />
    );
  },
);
```

- [ ] **Step 2: Run all tests touching activity-panel**

Run: `bun test src/tui/`
Expected: PASS — no test references this view's internals; props contract unchanged.

- [ ] **Step 3: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tui/views/activity-panel.tsx
git commit -m "refactor(tui): port activity-panel to EntityView (C1, #301)"
```

---

## Task 7: Migrate `activity.tsx`

**Files:**
- Modify: `src/tui/views/activity.tsx` (full rewrite)

This view has paging (`pageOffset`/`pageSize`) and a custom header ("showing N-M"). The wrapper renders the custom header; EntityView omits `title`. `onContributionsLoaded` callers expect the full entity slice — flow it through EntityView's `onDataChanged` (defined in Task 3).

- [ ] **Step 1: Overwrite the file**

Overwrite `src/tui/views/activity.tsx`:

```tsx
/**
 * Activity stream view — paged contributions feed, EntityView-backed.
 *
 * Pagination: sort by createdAt desc, slice via EntityView's offset+limit.
 * Wrapper owns the custom header ("showing N-M") because EntityView's
 * built-in title doesn't model offset display.
 */

import React, { useState } from "react";
import type { ContributionEntity } from "../../core/entity.js";
import type { Contribution } from "../../core/models.js";
import {
  agentColumn,
  byCreatedDesc,
  cidColumn,
  createdColumn,
  kindColumn,
  modeColumn,
  summaryColumn,
  tagsColumn,
} from "../components/columns/contribution-columns.js";
import { EntityView } from "../components/entity-view.js";
import type { TuiDataProvider } from "../provider.js";

export interface ActivityProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly pageOffset: number;
  readonly pageSize: number;
  readonly onContributionsLoaded?: (contributions: readonly Contribution[]) => void;
}

const COLUMNS = [
  cidColumn(22),
  kindColumn(14),
  modeColumn(12),
  summaryColumn(36),
  agentColumn(16),
  tagsColumn(16, 3),
  createdColumn("CREATED", 12),
];

function entityToContribution(e: ContributionEntity): Contribution {
  return {
    cid: e.id,
    manifestVersion: 0,
    kind: e.spec.contributionKind,
    mode: e.spec.mode,
    summary: e.spec.summary,
    description: e.spec.description,
    artifacts: e.spec.artifacts,
    relations: e.spec.relations,
    scores: e.spec.scores,
    tags: e.spec.tags,
    context: e.spec.context,
    agent: e.spec.agent,
    createdAt: e.metadata.creationTimestamp ?? "",
  };
}

export const ActivityView: React.NamedExoticComponent<ActivityProps> = React.memo(
  function ActivityView(props: ActivityProps): React.ReactNode {
    const { provider, active, cursor, pageOffset, pageSize, onContributionsLoaded } = props;
    const [count, setCount] = useState(0);

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Activity Stream</text>
          {count > 0 ? (
            <text opacity={0.5}>{`  showing ${pageOffset + 1}-${pageOffset + count}`}</text>
          ) : pageOffset > 0 ? (
            <text opacity={0.5}>{"  "}(no more results — press p to go back)</text>
          ) : null}
        </box>
        <EntityView
          kind="Contribution"
          columns={COLUMNS}
          provider={provider}
          active={active}
          cursor={cursor}
          sort={byCreatedDesc}
          offset={pageOffset}
          limit={pageSize}
          onRowCountChanged={setCount}
          onDataChanged={(entities) => {
            if (onContributionsLoaded)
              onContributionsLoaded(entities.map(entityToContribution));
          }}
        />
      </box>
    );
  },
);
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tui/`
Expected: PASS — no test exercises the view's internals.

- [ ] **Step 3: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tui/views/activity.tsx
git commit -m "refactor(tui): port activity stream to EntityView (C1, #301)"
```

---

## Task 8: Columns library — Claim

**Files:**
- Create: `src/tui/components/columns/claim-columns.ts`

- [ ] **Step 1: Write the module**

Create `src/tui/components/columns/claim-columns.ts`:

```ts
/**
 * Reusable Claim columns for EntityView (claims.tsx, agent-list.tsx).
 */

import type { ClaimEntity } from "../../../core/entity.js";
import { formatDuration } from "../../../shared/duration.js";
import { formatTimestamp } from "../../../shared/format.js";
import type { EntityColumn } from "../entity-view.js";

const trunc = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 2)}..` : s);

export const claimIdColumn = (width = 20): EntityColumn<ClaimEntity> => ({
  header: "CLAIM_ID",
  key: "claimId",
  width,
  render: (e) => trunc(e.id, width),
});

export const targetColumn = (width = 24): EntityColumn<ClaimEntity> => ({
  header: "TARGET",
  key: "target",
  width,
  render: (e) => trunc(e.spec.targetRef, width),
});

export const agentColumn = (width = 16): EntityColumn<ClaimEntity> => ({
  header: "AGENT",
  key: "agent",
  width,
  render: (e) => e.spec.agent.agentName ?? e.spec.agent.agentId,
});

export const intentColumn = (width = 28): EntityColumn<ClaimEntity> => ({
  header: "INTENT",
  key: "intent",
  width,
  render: (e) => trunc(e.spec.intentSummary ?? "", width),
});

export const heartbeatColumn = (width = 12): EntityColumn<ClaimEntity> => ({
  header: "HEARTBEAT",
  key: "heartbeat",
  width,
  render: (e) => formatTimestamp(e.status.heartbeatAt),
});

/**
 * STATUS column with duplicate-target highlight. Closes over a
 * `targetCounts` map so the wrapper can pre-compute counts and pass
 * them in. Returns the same EntityColumn shape; the render function
 * is recreated when counts change (cheap).
 */
export const statusColumnWithCounts = (
  targetCounts: ReadonlyMap<string, number>,
  width = 10,
): EntityColumn<ClaimEntity> => ({
  header: "STATUS",
  key: "status",
  width,
  render: (e) => {
    const remaining = new Date(e.status.leaseExpiresAt).getTime() - Date.now();
    const dup = (targetCounts.get(e.spec.targetRef) ?? 0) > 1;
    const phase = e.status.phase;
    if (phase === "active" && remaining <= 0) return "EXPIRED";
    return dup ? `${phase} DUP` : phase;
  },
});

export const leaseColumn = (width = 14): EntityColumn<ClaimEntity> => ({
  header: "LEASE",
  key: "lease",
  width,
  render: (e) => {
    const remaining = new Date(e.status.leaseExpiresAt).getTime() - Date.now();
    return remaining > 0 ? formatDuration(remaining) : "expired";
  },
});

/** Predicate: only entities in `active` phase. */
export const isActive = (e: ClaimEntity): boolean => e.status.phase === "active";
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/columns/claim-columns.ts
git commit -m "feat(tui): claim-columns library for EntityView"
```

---

## Task 9: Migrate `claims.tsx`

**Files:**
- Modify: `src/tui/views/claims.tsx` (full rewrite)

- [ ] **Step 1: Replace the file**

Overwrite `src/tui/views/claims.tsx`:

```tsx
/**
 * Claims view — active claims with lease countdown, EntityView-backed.
 *
 * Scoped sessions (provider.hasSessionScope) render an EmptyState
 * directly without mounting EntityView, preserving the pre-port
 * behavior where `getClaims` lacks sessionId filtering.
 */

import React, { useCallback, useMemo } from "react";
import type { ClaimEntity } from "../../core/entity.js";
import { EmptyState } from "../components/empty-state.js";
import {
  agentColumn,
  claimIdColumn,
  heartbeatColumn,
  intentColumn,
  isActive,
  leaseColumn,
  statusColumnWithCounts,
  targetColumn,
} from "../components/columns/claim-columns.js";
import { EntityView } from "../components/entity-view.js";
import { useProviderScoped } from "../hooks/informer-context.js";
import type { TuiDataProvider } from "../provider.js";

export interface ClaimsProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: (count: number) => void;
  readonly activeClaims?: readonly unknown[] | undefined;
}

export const ClaimsView: React.NamedExoticComponent<ClaimsProps> = React.memo(
  function ClaimsView(props: ClaimsProps): React.ReactNode {
    const { provider, active, cursor, onRowCountChanged } = props;
    const isScoped = useProviderScoped(provider);

    const fallbackFetcher = useCallback(async (): Promise<readonly ClaimEntity[]> => {
      // Provider returns flat Claim shapes for the polled fallback path;
      // synthesize minimal ClaimEntity envelopes so the column renders work.
      const claims = await provider.getClaims({ status: "active" });
      return claims.map(
        (c) =>
          ({
            kind: "Claim",
            namespace: "default",
            id: c.claimId,
            spec: {
              targetRef: c.targetRef,
              agent: c.agent,
              intentSummary: c.intentSummary,
              context: c.context,
            },
            status: {
              phase: c.status as "active" | "expired" | "released" | "completed",
              heartbeatAt: c.heartbeatAt,
              leaseExpiresAt: c.leaseExpiresAt,
              attemptCount: c.attemptCount ?? 0,
            },
            conditions: [],
            observedGeneration: 0,
            resourceVersion: "0",
            metadata: { generation: 0, creationTimestamp: c.createdAt },
          }) as unknown as ClaimEntity,
      );
    }, [provider]);

    // Pre-computing target counts is per-render; closes over data each render
    // via columns memo. Keep it simple: compute inside columns memo by reading
    // the entity list; but EntityView owns the list. Trade-off: skip dup
    // highlight in wrapper, OR derive counts via onDataChanged.
    const [targetCounts, setTargetCounts] = React.useState<ReadonlyMap<string, number>>(new Map());
    const onDataChanged = useCallback((data: readonly ClaimEntity[]) => {
      const m = new Map<string, number>();
      for (const e of data) m.set(e.spec.targetRef, (m.get(e.spec.targetRef) ?? 0) + 1);
      setTargetCounts(m);
    }, []);

    const columns = useMemo(
      () => [
        claimIdColumn(20),
        targetColumn(24),
        agentColumn(16),
        statusColumnWithCounts(targetCounts, 10),
        leaseColumn(14),
        heartbeatColumn(12),
        intentColumn(28),
      ],
      [targetCounts],
    );

    if (isScoped) {
      return (
        <box flexDirection="column">
          <box marginBottom={1}>
            <text>Active Claims (0)</text>
          </box>
          <EmptyState
            title="Active work claims. Claims prevent agents from duplicating each other's work."
            hint="Spawn agents with Ctrl+P. Each agent automatically claims work before starting."
          />
        </box>
      );
    }

    return (
      <EntityView
        kind="Claim"
        columns={columns}
        provider={provider}
        active={active}
        cursor={cursor}
        predicate={isActive}
        fallbackFetcher={fallbackFetcher}
        title="Active Claims"
        emptyTitle="Active work claims. Claims prevent agents from duplicating each other's work."
        emptyHint="Spawn agents with Ctrl+P. Each agent automatically claims work before starting."
        onDataChanged={onDataChanged}
        {...(onRowCountChanged ? { onRowCountChanged } : {})}
      />
    );
  },
);
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tui/`
Expected: PASS — claims has no dedicated test file; nothing to break.

- [ ] **Step 3: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 4: Manual smoke (skip if subagent-driven)**

Run grove TUI against a Nexus stack with active claims; verify the Claims tab matches pre-port behavior.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/claims.tsx
git commit -m "refactor(tui): port claims view to EntityView (C1, #301)"
```

---

## Task 10: Columns library — Agent

**Files:**
- Create: `src/tui/components/columns/agent-columns.ts`

- [ ] **Step 1: Write the module**

Create `src/tui/components/columns/agent-columns.ts`:

```ts
/**
 * Agent columns for the agent-list view. Several columns depend on
 * a join context (tmux session names, cost rollups) — those are
 * factory functions that close over the context.
 */

import type { ClaimEntity } from "../../../core/entity.js";
import type { Claim } from "../../../core/models.js";
import { agentStatusIcon } from "../../theme.js";
import type { EntityColumn } from "../entity-view.js";

export interface AgentJoinCtx {
  readonly tmuxSessions: readonly string[];
  readonly agentSessions: ReadonlyMap<string, string>; // agentId → session
  readonly costs: ReadonlyMap<
    string,
    { costUsd: number; tokens: number; contextPercent?: number }
  >;
  readonly spinnerFrame: number;
}

const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n);

const trunc = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 2)}..` : s);

const claimToFlat = (e: ClaimEntity): Claim => ({
  claimId: e.id,
  targetRef: e.spec.targetRef,
  agent: e.spec.agent,
  status: e.status.phase,
  intentSummary: e.spec.intentSummary,
  createdAt: e.metadata.creationTimestamp ?? e.status.heartbeatAt,
  heartbeatAt: e.status.heartbeatAt,
  leaseExpiresAt: e.status.leaseExpiresAt,
  context: e.spec.context,
  attemptCount: e.status.attemptCount,
});

const deriveAgentStatus = (
  claim: Claim,
  session: string | undefined,
  tmuxSessions: readonly string[],
): string => {
  const remaining = new Date(claim.leaseExpiresAt).getTime() - Date.now();
  if (remaining <= 0) return "expired";
  if (!session) return "claimed";
  if (!tmuxSessions.includes(session)) return "error";
  if (Date.now() - new Date(claim.heartbeatAt).getTime() > 60_000) return "stalled";
  return "running";
};

export const agentIdColumn = (width = 16): EntityColumn<ClaimEntity> => ({
  header: "AGENT",
  key: "agentId",
  width,
  render: (e) => e.spec.agent.agentName ?? e.spec.agent.agentId,
});

export const roleColumn = (width = 12): EntityColumn<ClaimEntity> => ({
  header: "ROLE",
  key: "role",
  width,
  render: (e) => e.spec.agent.role ?? "worker",
});

export const platformColumn = (width = 12): EntityColumn<ClaimEntity> => ({
  header: "PLATFORM",
  key: "platform",
  width,
  render: (e) => e.spec.agent.platform ?? "-",
});

export const targetColumn = (width = 18): EntityColumn<ClaimEntity> => ({
  header: "TARGET",
  key: "target",
  width,
  render: (e) => trunc(e.spec.targetRef, width),
});

export const statusColumn = (
  ctx: AgentJoinCtx,
  width = 12,
): EntityColumn<ClaimEntity> => ({
  header: "STATUS",
  key: "status",
  width,
  render: (e) => {
    const claim = claimToFlat(e);
    const session = ctx.agentSessions.get(claim.agent.agentId);
    const status = deriveAgentStatus(claim, session, ctx.tmuxSessions);
    const { icon } = agentStatusIcon(status, ctx.spinnerFrame);
    return `${icon} ${status}`;
  },
});

export const costColumn = (ctx: AgentJoinCtx, width = 14): EntityColumn<ClaimEntity> => ({
  header: "COST",
  key: "cost",
  width,
  render: (e) => {
    const c = ctx.costs.get(e.spec.agent.agentId);
    return c ? `$${c.costUsd.toFixed(2)} | ${formatTokens(c.tokens)}` : "-";
  },
});

export const sessionColumn = (ctx: AgentJoinCtx, width = 16): EntityColumn<ClaimEntity> => ({
  header: "SESSION",
  key: "session",
  width,
  render: (e) => ctx.agentSessions.get(e.spec.agent.agentId) ?? "-",
});

/** Sort: coordinators first, then alphabetical by name. */
export const byRoleAndName = (a: ClaimEntity, b: ClaimEntity): number => {
  const ra = a.spec.agent.role ?? "worker";
  const rb = b.spec.agent.role ?? "worker";
  if (ra !== rb) {
    if (ra === "coordinator") return -1;
    if (rb === "coordinator") return 1;
    return ra.localeCompare(rb);
  }
  const na = a.spec.agent.agentName ?? a.spec.agent.agentId;
  const nb = b.spec.agent.agentName ?? b.spec.agent.agentId;
  return na.localeCompare(nb);
};
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/columns/agent-columns.ts
git commit -m "feat(tui): agent-columns library with join-context factories"
```

---

## Task 11: Migrate `agent-list.tsx`

**Files:**
- Modify: `src/tui/views/agent-list.tsx` (full rewrite)

- [ ] **Step 1: Replace the file**

Overwrite `src/tui/views/agent-list.tsx`:

```tsx
/**
 * Agent list view — running agents derived from active claims joined
 * with tmux session list and cost rollups. EntityView renders the
 * list; the wrapper computes the join context and passes it to the
 * column factories.
 */

import React, { useCallback, useMemo, useState } from "react";
import type { ClaimEntity } from "../../core/entity.js";
import { useInterval } from "../../local/use-interval.js";
import { agentIdFromSession, type TmuxManager } from "../agents/tmux-manager.js";
import {
  type AgentJoinCtx,
  agentIdColumn,
  byRoleAndName,
  costColumn,
  platformColumn,
  roleColumn,
  sessionColumn,
  statusColumn,
  targetColumn,
} from "../components/columns/agent-columns.js";
import { isActive } from "../components/columns/claim-columns.js";
import { EntityView } from "../components/entity-view.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../provider.js";
import { BRAILLE_SPINNER, timing } from "../theme.js";

export interface AgentListProps {
  readonly provider: TuiDataProvider;
  readonly tmux?: TmuxManager | undefined;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onSelectSession?: ((sessionName: string | undefined) => void) | undefined;
}

export const AgentListView: React.NamedExoticComponent<AgentListProps> = React.memo(
  function AgentListView(props: AgentListProps): React.ReactNode {
    const { provider, tmux, active, cursor, onSelectSession } = props;
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    useInterval(
      () => setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length),
      timing.spinner,
      active,
    );

    const tmuxFetcher = useCallback(async (): Promise<readonly string[]> => {
      if (!tmux) return [];
      return (await tmux.isAvailable()) ? tmux.listSessions() : [];
    }, [tmux]);
    const { data: tmuxSessions } = useEventDrivenData<readonly string[]>(
      tmuxFetcher,
      undefined,
      undefined,
      active && !!tmux,
    );

    const costFetcher = useCallback(async () => {
      const cp = provider as unknown as {
        getSessionCosts?: () => Promise<{
          byAgent: readonly {
            agentId: string;
            costUsd: number;
            tokens: number;
            contextPercent?: number;
          }[];
        }>;
      };
      if (!cp.getSessionCosts)
        return new Map<string, { costUsd: number; tokens: number; contextPercent?: number }>();
      const out = await cp.getSessionCosts();
      const m = new Map<string, { costUsd: number; tokens: number; contextPercent?: number }>();
      for (const a of out.byAgent) {
        const entry: { costUsd: number; tokens: number; contextPercent?: number } = {
          costUsd: a.costUsd,
          tokens: a.tokens,
        };
        if (a.contextPercent !== undefined) entry.contextPercent = a.contextPercent;
        m.set(a.agentId, entry);
      }
      return m;
    }, [provider]);
    const { data: costs } = useEventDrivenData(costFetcher, undefined, undefined, active);

    const agentSessions = useMemo<ReadonlyMap<string, string>>(() => {
      const m = new Map<string, string>();
      for (const name of tmuxSessions ?? []) {
        const id = agentIdFromSession(name);
        if (id) m.set(id, name);
      }
      return m;
    }, [tmuxSessions]);

    const ctx = useMemo<AgentJoinCtx>(
      () => ({
        tmuxSessions: tmuxSessions ?? [],
        agentSessions,
        costs:
          costs ??
          new Map<string, { costUsd: number; tokens: number; contextPercent?: number }>(),
        spinnerFrame,
      }),
      [tmuxSessions, agentSessions, costs, spinnerFrame],
    );

    const columns = useMemo(
      () => [
        agentIdColumn(16),
        roleColumn(12),
        platformColumn(12),
        statusColumn(ctx, 12),
        costColumn(ctx, 14),
        targetColumn(18),
        sessionColumn(ctx, 16),
      ],
      [ctx],
    );

    const onSelect = useCallback(
      (entity: ClaimEntity | undefined) => {
        if (!onSelectSession) return;
        if (!entity) return onSelectSession(undefined);
        const session = agentSessions.get(entity.spec.agent.agentId);
        onSelectSession(session ?? undefined);
      },
      [onSelectSession, agentSessions],
    );

    return (
      <EntityView
        kind="Claim"
        columns={columns}
        provider={provider}
        active={active}
        cursor={cursor}
        predicate={isActive}
        sort={byRoleAndName}
        title="Agents"
        emptyTitle="No agents registered."
        emptyHint="Press r to register, or Ctrl+P to spawn."
        onSelect={onSelect}
      />
    );
  },
);
```

- [ ] **Step 2: Run tests + typecheck + lint**

Run: `bun test src/tui/ && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/agent-list.tsx
git commit -m "refactor(tui): port agent-list to EntityView with join-context columns"
```

---

## Task 12: Acceptance verification

**Files:** none (audit step)

- [ ] **Step 1: Confirm ≥4 screens share EntityView**

Run: `grep -l "EntityView" src/tui/views/`
Expected output:
```
src/tui/views/activity-panel.tsx
src/tui/views/activity.tsx
src/tui/views/claims.tsx
src/tui/views/agent-list.tsx
```
That's 4 files, meeting the issue's ≥4 acceptance.

- [ ] **Step 2: Confirm "no new component" pattern**

Pick a kind not yet wired (e.g. `Plan` or `Decision`). Sketch in a comment that adding the view requires:
1. New `src/tui/components/columns/<kind>-columns.ts` (config).
2. A wrapper that calls `<EntityView kind="X" columns={X_COLUMNS} … />`.
No new component file under `src/tui/components/`. Add this note to the spec or the issue comment.

- [ ] **Step 3: Run perf gate locally**

Run: `RUN_PERF=1 bun test src/tui/components/entity-view.perf.test.tsx`
Expected: PASS — p95 < 16ms with 500 rows × 100 cursor moves.

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: PASS — no regressions.

- [ ] **Step 5: Final lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit / open PR**

If any minor doc updates were needed in step 2 (spec note), commit them. Open the PR titled:
> feat(tui): generic EntityView component (C1, #301)

PR body links the spec, the plan, and lists the 4 migrated views (claims, agent-list, activity, activity-panel). Notes that `search-panel.tsx` is intentionally not migrated in this PR (server-side search isn't expressible via EntityStore predicate).

---

## Self-review notes

**Spec coverage:**
- Section "Architecture / 1. useEntityData" → Tasks 1, 2.
- Section "Architecture / 2. EntityView" → Task 3 (includes `onDataChanged`).
- Section "Architecture / 2a. EntityFor consolidation" → Task 0.
- Section "Architecture / 3. Columns library" → Tasks 5, 8, 10.
- Section "Migration plan" claims/agent-list/activity/activity-panel → Tasks 6, 7, 9, 11. (search-panel deferred — see plan note.)
- Section "Testing" unit/hook/perf → Tasks 1, 2, 3, 4.
- Section "Acceptance criteria mapping" → Task 12.

**Consistency:**
- `useEntityData(provider, kind, opts)` signature consistent across Tasks 1–3 and all migration tasks.
- `EntityViewProps<K>` field set defined in Task 3; Tasks 6, 7, 9, 11 use only the names declared there: `kind`, `columns`, `provider`, `active`, `cursor`, `predicate`, `sort`, `offset`, `limit`, `fallbackFetcher`, `title`, `headerSuffix`, `emptyTitle`, `emptyHint`, `onRowCountChanged`, `onSelect`, `onDataChanged`, `hints`.

**Open risk:**
- Task 9's claims migration synthesizes `ClaimEntity` envelopes inside `fallbackFetcher` because the polled `getClaims` returns flat `Claim` objects. Works for column rendering but is awkward; if it bites, an alternative is keeping the fallback path on a private hook that returns rows directly. Acceptable for the first pass.
- search-panel is intentionally out of scope. Spec note in `docs/superpowers/specs/2026-05-06-c1-entity-view-design.md` should be updated to match before PR merge.
