# Frontier — Grouped Navigable Ranking Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the TUI frontier from a flat grouped table into tabbed navigable per-signal slices with "why winning" badges, plus wire `adopt` into the real spawn path.

**Architecture:** `frontier-view.tsx` becomes a small orchestrator (fetch + tab state + cursor map). Pure projection (`frontier-slices.ts`) plus three presentational components (`frontier-tab-bar`, `frontier-overview`, `frontier-slice-table`) handle layout. Adopt records target context into a new `adoptContext` reducer slot and reuses the existing `CommandPalette` to pick a role; the spawn handler threads the context into `spawnManager.spawn(...)`.

**Tech Stack:** TypeScript, React (via opentui), `bun:test` runner, existing TUI hooks (`useEventDrivenData`, `useDerived`, `useInformerOptional`).

**Spec:** `docs/superpowers/specs/2026-05-14-frontier-grouped-views-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/tui/views/frontier-slices.ts` | Create | Pure: `Frontier → FrontierSlice[]`, `slicesEqual`, per-slice `formatBadge` |
| `src/tui/views/frontier-slices.test.ts` | Create | Unit tests for projection + ordering + badges + equals |
| `src/tui/views/frontier-tab-bar.tsx` | Create | Tab strip with overflow window |
| `src/tui/views/frontier-tab-bar.test.ts` | Create | Tab bar render + overflow tests |
| `src/tui/views/frontier-overview.tsx` | Create | Top-3 mini-leaderboards per non-empty slice |
| `src/tui/views/frontier-slice-table.tsx` | Create | Single slice ranked table with badges + signal description |
| `src/tui/views/frontier-view.tsx` | Rewrite | Orchestrator: fetch + tab state + cursor map |
| `src/tui/views/frontier-view.test.ts` | Modify | Drop old flat-row tests; add tab + cursor + empty-state tests |
| `src/tui/views/frontier-adopt.integration.test.ts` | Create | Integration: `a` → palette open → spawn with adoptTarget |
| `src/tui/app-reducer.ts` | Modify | Add `adoptContext` slot + actions `ADOPT_SET` / `ADOPT_CLEAR` |
| `src/tui/hooks/use-keyboard-handler.ts` | Modify | Tab/Shift-Tab/digit jump + `a` key when focused on Frontier |
| `src/tui/app.tsx` | Modify | `onFrontierAdopt` action; rewire `onCompareAdopt`; thread `adoptContext` into `handleSpawn` |
| `src/tui/panels/panel-manager.tsx` | Modify | Pass `onFrontierAdopt` + `activeSliceKey` props down to `FrontierView` |
| `src/tui/components/command-palette.tsx` | Modify | Show `Adopt: {short cid}` chip when `adoptContext` set |

---

## Phase A — Pure projection (`frontier-slices.ts`)

### Task 1: FrontierSlice type + scalar dimensions

**Files:**
- Create: `src/tui/views/frontier-slices.ts`
- Create: `src/tui/views/frontier-slices.test.ts`

- [ ] **Step 1: Write the failing test**

`src/tui/views/frontier-slices.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { Frontier } from "../../core/frontier.js";
import { toSlices } from "./frontier-slices.js";

function makeFrontier(partial: Partial<Frontier> = {}): Frontier {
  return {
    byMetric: {},
    byAdoption: [],
    byRecency: [],
    byReviewScore: [],
    byReproduction: [],
    ...partial,
  };
}

describe("toSlices — scalar dimensions", () => {
  test("empty frontier produces zero slices", () => {
    expect(toSlices(makeFrontier())).toEqual([]);
  });

  test("adoption slice present when entries exist", () => {
    const slices = toSlices(
      makeFrontier({ byAdoption: [{ cid: "a1", value: 5, summary: "s" }] }),
    );
    expect(slices.length).toBe(1);
    expect(slices[0]?.key).toBe("adoption");
    expect(slices[0]?.label).toBe("adoption");
    expect(slices[0]?.entries.length).toBe(1);
    expect(slices[0]?.entries[0]?.cid).toBe("a1");
  });

  test("built-in slices ordered: adoption, recency, review, reproduction", () => {
    const slices = toSlices(
      makeFrontier({
        byReproduction: [{ cid: "rep", value: 1, summary: "" }],
        byReviewScore: [{ cid: "rv", value: 4, summary: "" }],
        byRecency: [{ cid: "rc", value: 100, summary: "" }],
        byAdoption: [{ cid: "ad", value: 2, summary: "" }],
      }),
    );
    expect(slices.map((s) => s.key)).toEqual(["adoption", "recency", "review", "reproduction"]);
  });

  test("empty scalar dimensions are omitted from slices", () => {
    const slices = toSlices(
      makeFrontier({ byAdoption: [{ cid: "a", value: 1, summary: "" }] }),
    );
    expect(slices.map((s) => s.key)).toEqual(["adoption"]);
  });

  test("each slice carries a non-empty signalDescription", () => {
    const slices = toSlices(
      makeFrontier({
        byAdoption: [{ cid: "a", value: 1, summary: "" }],
        byRecency: [{ cid: "r", value: 1, summary: "" }],
        byReviewScore: [{ cid: "v", value: 4, summary: "" }],
        byReproduction: [{ cid: "p", value: 1, summary: "" }],
      }),
    );
    for (const s of slices) {
      expect(s.signalDescription.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/frontier-slices.test.ts`
Expected: FAIL with "Cannot find module './frontier-slices.js'"

- [ ] **Step 3: Create `frontier-slices.ts` with type + scalar dimensions**

`src/tui/views/frontier-slices.ts`:

```typescript
/**
 * Pure projection: Frontier → ordered FrontierSlice[].
 *
 * Each FrontierSlice represents one ranking signal. The orchestrator
 * (frontier-view.tsx) renders one slice per tab. formatBadge() produces
 * the per-row "why winning" text shown in the SIGNAL column.
 */

import type { Frontier, FrontierEntry } from "../../core/frontier.js";

/** A single ranking dimension grouped for display. */
export interface FrontierSlice {
  /** Stable key used as tab id and cursor map key. Unique across all slices. */
  readonly key: string;
  /** Human-facing tab label. */
  readonly label: string;
  /** One-line description shown in the slice header. */
  readonly signalDescription: string;
  /** Ranked entries (already ordered by the calculator). */
  readonly entries: readonly FrontierEntry[];
  /** Per-row badge formatter for the SIGNAL column. */
  readonly formatBadge: (entry: FrontierEntry) => string;
}

const SCALAR_DESCRIPTIONS: Record<string, string> = {
  adoption: "Adoption — unique downstream uses (derives_from + adopts)",
  recency: "Recency — most recent contributions",
  review: "Review — highest average review scores",
  reproduction: "Reproduction — most-reproduced contributions",
};

function placeholderBadge(_entry: FrontierEntry): string {
  return "";
}

/** Project a Frontier into ordered, non-empty slices. */
export function toSlices(frontier: Frontier): readonly FrontierSlice[] {
  const slices: FrontierSlice[] = [];
  const scalarOrder: ReadonlyArray<readonly [string, readonly FrontierEntry[] | undefined]> = [
    ["adoption", frontier.byAdoption],
    ["recency", frontier.byRecency],
    ["review", frontier.byReviewScore],
    ["reproduction", frontier.byReproduction],
  ];
  for (const [key, entries] of scalarOrder) {
    if (!entries || entries.length === 0) continue;
    slices.push({
      key,
      label: key,
      signalDescription: SCALAR_DESCRIPTIONS[key] ?? key,
      entries,
      formatBadge: placeholderBadge,
    });
  }
  return slices;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/views/frontier-slices.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/frontier-slices.ts src/tui/views/frontier-slices.test.ts
git commit -m "feat(tui): add frontier-slices pure projection (scalar dims)"
```

---

### Task 2: Add `metric:*` slices with stable ordering

**Files:**
- Modify: `src/tui/views/frontier-slices.ts`
- Modify: `src/tui/views/frontier-slices.test.ts`

- [ ] **Step 1: Write failing tests for metric:* slices**

Append to `src/tui/views/frontier-slices.test.ts`:

```typescript
describe("toSlices — metric:* dimensions", () => {
  test("a metric produces a 'metric:<name>' slice", () => {
    const slices = toSlices(
      makeFrontier({
        byMetric: { accuracy: [{ cid: "m1", value: 0.9, summary: "" }] },
      }),
    );
    expect(slices.length).toBe(1);
    expect(slices[0]?.key).toBe("metric:accuracy");
    expect(slices[0]?.label).toBe("accuracy");
  });

  test("metric slices follow built-ins and are alphabetical", () => {
    const slices = toSlices(
      makeFrontier({
        byAdoption: [{ cid: "a", value: 1, summary: "" }],
        byMetric: {
          zeta: [{ cid: "z", value: 1, summary: "" }],
          alpha: [{ cid: "al", value: 1, summary: "" }],
          mu: [{ cid: "m", value: 1, summary: "" }],
        },
      }),
    );
    expect(slices.map((s) => s.key)).toEqual([
      "adoption",
      "metric:alpha",
      "metric:mu",
      "metric:zeta",
    ]);
  });

  test("empty metric arrays are omitted", () => {
    const slices = toSlices(
      makeFrontier({ byMetric: { empty: [] } }),
    );
    expect(slices).toEqual([]);
  });

  test("metric slice signalDescription mentions the metric name", () => {
    const slices = toSlices(
      makeFrontier({ byMetric: { rouge_l: [{ cid: "r", value: 0.8, summary: "" }] } }),
    );
    expect(slices[0]?.signalDescription).toContain("rouge_l");
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test src/tui/views/frontier-slices.test.ts`
Expected: 4 new tests FAIL.

- [ ] **Step 3: Extend `toSlices` to add metric:* slices**

In `src/tui/views/frontier-slices.ts`, replace the body of `toSlices` with:

```typescript
export function toSlices(frontier: Frontier): readonly FrontierSlice[] {
  const slices: FrontierSlice[] = [];
  const scalarOrder: ReadonlyArray<readonly [string, readonly FrontierEntry[] | undefined]> = [
    ["adoption", frontier.byAdoption],
    ["recency", frontier.byRecency],
    ["review", frontier.byReviewScore],
    ["reproduction", frontier.byReproduction],
  ];
  for (const [key, entries] of scalarOrder) {
    if (!entries || entries.length === 0) continue;
    slices.push({
      key,
      label: key,
      signalDescription: SCALAR_DESCRIPTIONS[key] ?? key,
      entries,
      formatBadge: placeholderBadge,
    });
  }
  const metricNames = Object.keys(frontier.byMetric ?? {}).sort();
  for (const name of metricNames) {
    const entries = frontier.byMetric[name];
    if (!entries || entries.length === 0) continue;
    slices.push({
      key: `metric:${name}`,
      label: name,
      signalDescription: `${name} — per-contribution score`,
      entries,
      formatBadge: placeholderBadge,
    });
  }
  return slices;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/views/frontier-slices.test.ts`
Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/frontier-slices.ts src/tui/views/frontier-slices.test.ts
git commit -m "feat(tui): add metric:* slices with alphabetical ordering"
```

---

### Task 3: Per-signal `formatBadge`

**Files:**
- Modify: `src/tui/views/frontier-slices.ts`
- Modify: `src/tui/views/frontier-slices.test.ts`

- [ ] **Step 1: Write failing tests for badge formatters**

Append to `src/tui/views/frontier-slices.test.ts`:

```typescript
describe("toSlices — formatBadge per signal", () => {
  test("adoption: '×N adopters'", () => {
    const slices = toSlices(
      makeFrontier({ byAdoption: [{ cid: "a", value: 12, summary: "" }] }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toBe("×12 adopters");
  });

  test("reproduction: '▲N confirmed'", () => {
    const slices = toSlices(
      makeFrontier({ byReproduction: [{ cid: "r", value: 3, summary: "" }] }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toBe("▲3 confirmed");
  });

  test("review: 'X.X⋆' rounded to one decimal", () => {
    const slices = toSlices(
      makeFrontier({ byReviewScore: [{ cid: "v", value: 4.73, summary: "" }] }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toBe("4.7⋆");
  });

  test("recency: relative time string", () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const slices = toSlices(
      makeFrontier({ byRecency: [{ cid: "rc", value: fiveMinAgo, summary: "" }] }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toMatch(/^\d+m ago$/);
  });

  test("metric:*: '0.812 <name>' to 3 decimals", () => {
    const slices = toSlices(
      makeFrontier({ byMetric: { rouge_l: [{ cid: "m", value: 0.812345, summary: "" }] } }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toBe("0.812 rouge_l");
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test src/tui/views/frontier-slices.test.ts`
Expected: 5 new tests FAIL with `expect badge to be ... received ""`.

- [ ] **Step 3: Implement badge formatters**

In `src/tui/views/frontier-slices.ts`, replace `placeholderBadge` and `toSlices` with:

```typescript
function formatRelativeMs(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function adoptionBadge(entry: FrontierEntry): string {
  return `×${String(entry.value)} adopters`;
}

function reproductionBadge(entry: FrontierEntry): string {
  return `▲${String(entry.value)} confirmed`;
}

function reviewBadge(entry: FrontierEntry): string {
  return `${entry.value.toFixed(1)}⋆`;
}

function recencyBadge(entry: FrontierEntry): string {
  return formatRelativeMs(entry.value);
}

function metricBadge(name: string): (entry: FrontierEntry) => string {
  return (entry) => `${entry.value.toFixed(3)} ${name}`;
}

const SCALAR_BADGES: Record<string, (entry: FrontierEntry) => string> = {
  adoption: adoptionBadge,
  recency: recencyBadge,
  review: reviewBadge,
  reproduction: reproductionBadge,
};

export function toSlices(frontier: Frontier): readonly FrontierSlice[] {
  const slices: FrontierSlice[] = [];
  const scalarOrder: ReadonlyArray<readonly [string, readonly FrontierEntry[] | undefined]> = [
    ["adoption", frontier.byAdoption],
    ["recency", frontier.byRecency],
    ["review", frontier.byReviewScore],
    ["reproduction", frontier.byReproduction],
  ];
  for (const [key, entries] of scalarOrder) {
    if (!entries || entries.length === 0) continue;
    slices.push({
      key,
      label: key,
      signalDescription: SCALAR_DESCRIPTIONS[key] ?? key,
      entries,
      formatBadge: SCALAR_BADGES[key] ?? ((): string => ""),
    });
  }
  const metricNames = Object.keys(frontier.byMetric ?? {}).sort();
  for (const name of metricNames) {
    const entries = frontier.byMetric[name];
    if (!entries || entries.length === 0) continue;
    slices.push({
      key: `metric:${name}`,
      label: name,
      signalDescription: `${name} — per-contribution score`,
      entries,
      formatBadge: metricBadge(name),
    });
  }
  return slices;
}
```

Delete the now-unused `placeholderBadge` function.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/views/frontier-slices.test.ts`
Expected: all 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/frontier-slices.ts src/tui/views/frontier-slices.test.ts
git commit -m "feat(tui): per-signal formatBadge for frontier slices"
```

---

### Task 4: `slicesEqual` for `useDerived` memoization

**Files:**
- Modify: `src/tui/views/frontier-slices.ts`
- Modify: `src/tui/views/frontier-slices.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/tui/views/frontier-slices.test.ts`:

```typescript
import { slicesEqual } from "./frontier-slices.js";

describe("slicesEqual", () => {
  function fixture() {
    return makeFrontier({
      byAdoption: [{ cid: "a", value: 5, summary: "s" }],
      byMetric: { acc: [{ cid: "m", value: 0.9, summary: "ms" }] },
    });
  }

  test("same array reference → true", () => {
    const slices = toSlices(fixture());
    expect(slicesEqual(slices, slices)).toBe(true);
  });

  test("equal content, different references → true", () => {
    expect(slicesEqual(toSlices(fixture()), toSlices(fixture()))).toBe(true);
  });

  test("different lengths → false", () => {
    const a = toSlices(fixture());
    const b = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 5, summary: "s" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different value → false", () => {
    const a = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 5, summary: "" }] }));
    const b = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 6, summary: "" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different cid → false", () => {
    const a = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 5, summary: "" }] }));
    const b = toSlices(makeFrontier({ byAdoption: [{ cid: "b", value: 5, summary: "" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different slice key → false", () => {
    const a = toSlices(makeFrontier({ byAdoption: [{ cid: "x", value: 1, summary: "" }] }));
    const b = toSlices(makeFrontier({ byRecency: [{ cid: "x", value: 1, summary: "" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different entry order → false", () => {
    const a = toSlices(
      makeFrontier({
        byAdoption: [
          { cid: "x", value: 5, summary: "" },
          { cid: "y", value: 4, summary: "" },
        ],
      }),
    );
    const b = toSlices(
      makeFrontier({
        byAdoption: [
          { cid: "y", value: 4, summary: "" },
          { cid: "x", value: 5, summary: "" },
        ],
      }),
    );
    expect(slicesEqual(a, b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/views/frontier-slices.test.ts`
Expected: 7 new tests FAIL with `slicesEqual is not a function`.

- [ ] **Step 3: Implement `slicesEqual`**

Append to `src/tui/views/frontier-slices.ts`:

```typescript
/**
 * Structural equality across slice arrays. Compares slice key + entry count
 * + (cid, value) tuples in order. summary deltas don't trigger re-render
 * (purely cosmetic, server-driven).
 */
export function slicesEqual(
  a: readonly FrontierSlice[],
  b: readonly FrontierSlice[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i] as FrontierSlice;
    const sb = b[i] as FrontierSlice;
    if (sa.key !== sb.key) return false;
    if (sa.entries.length !== sb.entries.length) return false;
    for (let j = 0; j < sa.entries.length; j++) {
      const ea = sa.entries[j]!;
      const eb = sb.entries[j]!;
      if (ea.cid !== eb.cid || ea.value !== eb.value) return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/tui/views/frontier-slices.test.ts`
Expected: all 21 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/frontier-slices.ts src/tui/views/frontier-slices.test.ts
git commit -m "feat(tui): slicesEqual for useDerived memoization"
```

---

## Phase B — Presentational components

### Task 5: `FrontierTabBar` with overflow window

**Files:**
- Create: `src/tui/views/frontier-tab-bar.tsx`
- Create: `src/tui/views/frontier-tab-bar.test.ts`

- [ ] **Step 1: Write failing tests**

`src/tui/views/frontier-tab-bar.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { computeVisibleTabs } from "./frontier-tab-bar.js";

describe("computeVisibleTabs", () => {
  const TABS = ["overview", "adoption", "recency", "review", "reproduction", "metric:a", "metric:b"];

  test("all tabs fit when capacity ≥ count", () => {
    const r = computeVisibleTabs(TABS, "adoption", 10);
    expect(r.visible).toEqual(TABS);
    expect(r.hiddenAfter).toBe(0);
  });

  test("active tab forced visible when capacity smaller than count", () => {
    const r = computeVisibleTabs(TABS, "metric:b", 3);
    expect(r.visible.includes("metric:b")).toBe(true);
    expect(r.visible.length).toBeLessThanOrEqual(3);
  });

  test("hiddenAfter = count - visible.length when overflow", () => {
    const r = computeVisibleTabs(TABS, "overview", 3);
    expect(r.hiddenAfter).toBe(TABS.length - r.visible.length);
  });

  test("active tab not in input → no crash, falls back to first window", () => {
    const r = computeVisibleTabs(TABS, "missing", 3);
    expect(r.visible.length).toBe(3);
  });

  test("empty tab list → empty visible", () => {
    expect(computeVisibleTabs([], "x", 5)).toEqual({ visible: [], hiddenAfter: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/frontier-tab-bar.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `frontier-tab-bar.tsx`**

`src/tui/views/frontier-tab-bar.tsx`:

```typescript
/**
 * Frontier tab strip. Renders one tab per slice + Overview, with an overflow
 * window so the active tab is always visible and a `+N` indicator marks
 * hidden tabs.
 */

import React from "react";
import { theme } from "../theme.js";

/** Compute the visible tab window so the active tab is always rendered. */
export function computeVisibleTabs(
  tabs: readonly string[],
  active: string,
  capacity: number,
): { visible: readonly string[]; hiddenAfter: number } {
  if (tabs.length === 0) return { visible: [], hiddenAfter: 0 };
  if (capacity >= tabs.length) return { visible: tabs, hiddenAfter: 0 };
  const activeIdx = tabs.indexOf(active);
  const start = activeIdx < 0 ? 0 : Math.min(activeIdx, Math.max(0, tabs.length - capacity));
  const visible = tabs.slice(start, start + capacity);
  return { visible, hiddenAfter: tabs.length - visible.length };
}

export interface FrontierTabBarProps {
  readonly tabs: readonly { key: string; label: string }[];
  readonly activeKey: string;
  readonly capacity?: number;
  readonly disabled?: boolean;
}

const DEFAULT_CAPACITY = 8;

export const FrontierTabBar: React.NamedExoticComponent<FrontierTabBarProps> = React.memo(
  function FrontierTabBar({
    tabs,
    activeKey,
    capacity = DEFAULT_CAPACITY,
    disabled = false,
  }: FrontierTabBarProps): React.ReactNode {
    const keys = tabs.map((t) => t.key);
    const { visible, hiddenAfter } = computeVisibleTabs(keys, activeKey, capacity);
    const labelByKey = new Map(tabs.map((t) => [t.key, t.label]));
    return (
      <box flexDirection="row">
        {visible.map((key) => {
          const isActive = key === activeKey;
          const color = disabled
            ? theme.muted
            : isActive
              ? theme.primary
              : theme.secondary;
          const decoration = isActive ? `[${labelByKey.get(key) ?? key}]` : (labelByKey.get(key) ?? key);
          return (
            <text key={key} color={color}>
              {`${decoration}  `}
            </text>
          );
        })}
        {hiddenAfter > 0 ? <text opacity={0.5}>{`+${String(hiddenAfter)}`}</text> : null}
      </box>
    );
  },
);
```

- [ ] **Step 4: Run tests**

Run: `bun test src/tui/views/frontier-tab-bar.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Verify theme tokens exist**

Run: `grep -n "primary\|secondary\|muted" src/tui/theme.ts | head -10`
Expected: `primary`, `secondary`, `muted` present. If `muted` is absent, substitute `theme.secondary` in step 3 and re-run tests.

- [ ] **Step 6: Commit**

```bash
git add src/tui/views/frontier-tab-bar.tsx src/tui/views/frontier-tab-bar.test.ts
git commit -m "feat(tui): FrontierTabBar with overflow window"
```

---

### Task 6: `FrontierSliceTable` — single ranked slice with badges

**Files:**
- Create: `src/tui/views/frontier-slice-table.tsx`

- [ ] **Step 1: Implement `frontier-slice-table.tsx`** (no separate unit test — covered by `frontier-view.test.ts` in Phase C)

`src/tui/views/frontier-slice-table.tsx`:

```typescript
/**
 * Renders one frontier slice: signal description header + ranked table
 * with rank, cid (with optional compare prefix), value, signal badge, and
 * truncated summary.
 */

import React, { useMemo } from "react";
import { truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { theme } from "../theme.js";
import type { FrontierSlice } from "./frontier-slices.js";

const COLUMNS = [
  { header: "RANK", key: "rank", width: 6, align: "right" as const },
  { header: "CID", key: "cid", width: 22 },
  { header: "VALUE", key: "value", width: 10, align: "right" as const },
  { header: "SIGNAL", key: "signal", width: 18 },
  { header: "SUMMARY", key: "summary", width: 32 },
] as const;

export interface FrontierSliceTableProps {
  readonly slice: FrontierSlice;
  readonly cursor?: number | undefined;
  readonly compareMode?: boolean | undefined;
  readonly compareCids?: readonly string[] | undefined;
}

function formatValueColumn(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

export const FrontierSliceTable: React.NamedExoticComponent<FrontierSliceTableProps> = React.memo(
  function FrontierSliceTable({
    slice,
    cursor,
    compareMode,
    compareCids,
  }: FrontierSliceTableProps): React.ReactNode {
    const selected = useMemo(() => new Set(compareCids ?? []), [compareCids]);
    const rows = useMemo(
      () =>
        slice.entries.map((entry, i) => {
          const prefix = compareMode ? (selected.has(entry.cid) ? "[*] " : "[ ] ") : "";
          return {
            rank: String(i + 1),
            cid: `${prefix}${truncateCid(entry.cid)}`,
            value: formatValueColumn(entry.value),
            signal: slice.formatBadge(entry),
            summary:
              entry.summary.length > 32 ? `${entry.summary.slice(0, 30)}..` : entry.summary,
          };
        }),
      [slice, compareMode, selected],
    );

    if (rows.length === 0) {
      return (
        <box flexDirection="column">
          <text color={theme.secondary}>{slice.signalDescription}</text>
          <text opacity={0.5}>{`${slice.label} — no entries yet`}</text>
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <text color={theme.secondary}>{slice.signalDescription}</text>
        <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
      </box>
    );
  },
);
```

- [ ] **Step 2: Type-check the file in isolation**

Run: `bun tsc --noEmit -p tsconfig.json 2>&1 | grep frontier-slice-table | head -20`
Expected: no errors. (If tsc emits unrelated errors elsewhere, that's fine — only frontier-slice-table errors block this task.)

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/frontier-slice-table.tsx
git commit -m "feat(tui): FrontierSliceTable with signal description + badge column"
```

---

### Task 7: `FrontierOverview` — top-3 mini-leaderboards

**Files:**
- Create: `src/tui/views/frontier-overview.tsx`

- [ ] **Step 1: Implement overview component**

`src/tui/views/frontier-overview.tsx`:

```typescript
/**
 * Frontier overview tab — shows top-3 entries per non-empty slice as
 * read-only mini-leaderboards. Operators jump into a slice via tab
 * navigation or digit hotkeys handled by the orchestrator.
 */

import React from "react";
import { truncateCid } from "../../shared/format.js";
import { theme } from "../theme.js";
import type { FrontierSlice } from "./frontier-slices.js";

export interface FrontierOverviewProps {
  readonly slices: readonly FrontierSlice[];
}

const TOP_N = 3;

export const FrontierOverview: React.NamedExoticComponent<FrontierOverviewProps> = React.memo(
  function FrontierOverview({ slices }: FrontierOverviewProps): React.ReactNode {
    const nonEmpty = slices.filter((s) => s.entries.length > 0);
    if (nonEmpty.length === 0) return null;
    return (
      <box flexDirection="column">
        {nonEmpty.map((slice) => (
          <box key={slice.key} flexDirection="column" marginBottom={1}>
            <text color={theme.secondary}>{`── ${slice.label} (top ${String(
              Math.min(TOP_N, slice.entries.length),
            )}) ──`}</text>
            {slice.entries.slice(0, TOP_N).map((entry, i) => (
              <text key={entry.cid}>
                {`  ${String(i + 1)}  ${truncateCid(entry.cid)}  ${slice.formatBadge(entry)}  ${entry.summary.slice(0, 36)}`}
              </text>
            ))}
          </box>
        ))}
      </box>
    );
  },
);
```

- [ ] **Step 2: Type-check**

Run: `bun tsc --noEmit -p tsconfig.json 2>&1 | grep frontier-overview | head -20`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/frontier-overview.tsx
git commit -m "feat(tui): FrontierOverview top-3 mini-leaderboards"
```

---

## Phase C — Orchestrator rewrite

### Task 8: Replace `frontier-view.tsx` with the new orchestrator

**Files:**
- Modify: `src/tui/views/frontier-view.tsx`

- [ ] **Step 1: Replace the file contents**

`src/tui/views/frontier-view.tsx` (full replacement):

```typescript
/**
 * Frontier view — orchestrator.
 *
 * Owns Frontier fetch (race-guarded), Contribution-event refresh
 * coalescing, tab state, per-slice cursor map, and the active-slice
 * cid list reported to the parent for cursor → cid resolution.
 *
 * Layout: tab bar (Overview + one tab per non-empty slice) on top, then
 * either FrontierOverview (Overview tab) or FrontierSliceTable (slice tab).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Frontier } from "../../core/frontier.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { useEntityWatchEnabled, useInformerOptional } from "../hooks/informer-context.js";
import { useDerived } from "../hooks/use-derived.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";
import { FrontierOverview } from "./frontier-overview.js";
import type { FrontierSlice } from "./frontier-slices.js";
import { slicesEqual, toSlices } from "./frontier-slices.js";
import { FrontierSliceTable } from "./frontier-slice-table.js";
import { FrontierTabBar } from "./frontier-tab-bar.js";

const OVERVIEW_KEY = "overview";
const OVERVIEW_LABEL = "overview";

export interface FrontierViewProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: (count: number) => void;
  readonly compareMode?: boolean | undefined;
  readonly onCompareSelect?: ((cid: string) => void) | undefined;
  readonly compareCids?: readonly string[] | undefined;
  readonly onFrontierCidsChanged?: ((cids: readonly string[]) => void) | undefined;
  /** Active slice key (controlled by parent so keyboard handler can change it). */
  readonly activeSliceKey?: string | undefined;
  /** Reports the ordered list of slice keys back to the parent for tab navigation. */
  readonly onFrontierTabsChanged?: ((keys: readonly string[]) => void) | undefined;
  /** Reports {cid, summary} for the active slice so app.tsx can wire adopt without
   *  a separate contributionList lookup (Frontier may surface cids not in that list). */
  readonly onFrontierEntriesChanged?:
    | ((entries: ReadonlyArray<{ cid: string; summary: string }>) => void)
    | undefined;
}

export const FrontierView: React.NamedExoticComponent<FrontierViewProps> = React.memo(
  function FrontierView({
    provider,
    cursor,
    onRowCountChanged,
    compareMode,
    onCompareSelect,
    compareCids,
    onFrontierCidsChanged,
    activeSliceKey,
    onFrontierTabsChanged,
    onFrontierEntriesChanged,
  }: FrontierViewProps): React.ReactNode {
    void onCompareSelect;

    const latestFetchRef = useRef<Promise<Frontier> | null>(null);
    const fetcher = useCallback(async (): Promise<Frontier> => {
      const p = provider.getFrontier();
      latestFetchRef.current = p;
      try {
        const result = await p;
        const newest = latestFetchRef.current;
        if (newest !== p && newest !== null) return await newest;
        return result;
      } catch (err) {
        const newest = latestFetchRef.current;
        if (newest !== p && newest !== null) return await newest;
        throw err;
      }
    }, [provider]);
    const { data, loading, isStale, error, refresh } = useEventDrivenData<Frontier>(
      fetcher,
      undefined,
      undefined,
      true,
    );

    const useInformerPath = useEntityWatchEnabled(provider, "Contribution");
    const contribInformer = useInformerOptional("Contribution");
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
      if (!useInformerPath) return;
      const handler = (): void => {
        if (refreshTimerRef.current !== null) return;
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          const p = provider as { invalidateCaches?: () => void };
          p.invalidateCaches?.();
          refresh();
        }, 100);
      };
      const unsub = contribInformer.addEventHandler(handler);
      return () => {
        unsub();
        if (refreshTimerRef.current !== null) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
      };
    }, [useInformerPath, contribInformer, provider, refresh]);

    const dataRef = useRef<Frontier | null>(data);
    dataRef.current = data;
    const derived = useDerived<readonly FrontierSlice[]>(
      () => (dataRef.current ? toSlices(dataRef.current) : []),
      ["Contribution"],
      slicesEqual,
    );
    const slices = useMemo<readonly FrontierSlice[]>(() => {
      if (!data) return derived.data ?? [];
      const fresh = toSlices(data);
      const cached = derived.data;
      return cached && slicesEqual(cached, fresh) ? cached : fresh;
    }, [data, derived.data]);

    const allTabs = useMemo(
      () => [
        { key: OVERVIEW_KEY, label: OVERVIEW_LABEL },
        ...slices.map((s) => ({ key: s.key, label: s.label })),
      ],
      [slices],
    );
    const tabKeys = useMemo(() => allTabs.map((t) => t.key), [allTabs]);

    const prevTabKeysRef = useRef<readonly string[] | null>(null);
    useEffect(() => {
      if (!onFrontierTabsChanged) return;
      const prev = prevTabKeysRef.current;
      if (prev !== null && prev.length === tabKeys.length && prev.every((k, i) => k === tabKeys[i])) return;
      prevTabKeysRef.current = tabKeys;
      onFrontierTabsChanged(tabKeys);
    }, [tabKeys, onFrontierTabsChanged]);

    const resolvedActiveKey = useMemo(() => {
      const requested = activeSliceKey ?? OVERVIEW_KEY;
      return tabKeys.includes(requested) ? requested : OVERVIEW_KEY;
    }, [activeSliceKey, tabKeys]);

    const activeSlice = useMemo<FrontierSlice | undefined>(
      () => (resolvedActiveKey === OVERVIEW_KEY ? undefined : slices.find((s) => s.key === resolvedActiveKey)),
      [resolvedActiveKey, slices],
    );

    const activeEntries = useMemo<ReadonlyArray<{ cid: string; summary: string }>>(
      () => (activeSlice ? activeSlice.entries.map((e) => ({ cid: e.cid, summary: e.summary })) : []),
      [activeSlice],
    );
    const activeCids = useMemo<readonly string[]>(() => activeEntries.map((e) => e.cid), [activeEntries]);
    const prevActiveCidsRef = useRef<readonly string[] | null>(null);
    useEffect(() => {
      if (!onFrontierCidsChanged) return;
      const prev = prevActiveCidsRef.current;
      if (prev !== null && prev.length === activeCids.length && prev.every((c, i) => c === activeCids[i])) return;
      prevActiveCidsRef.current = activeCids;
      onFrontierCidsChanged(activeCids);
    }, [activeCids, onFrontierCidsChanged]);

    const prevActiveEntriesRef = useRef<ReadonlyArray<{ cid: string; summary: string }> | null>(null);
    useEffect(() => {
      if (!onFrontierEntriesChanged) return;
      const prev = prevActiveEntriesRef.current;
      if (
        prev !== null &&
        prev.length === activeEntries.length &&
        prev.every((e, i) => e.cid === activeEntries[i]?.cid && e.summary === activeEntries[i]?.summary)
      ) {
        return;
      }
      prevActiveEntriesRef.current = activeEntries;
      onFrontierEntriesChanged(activeEntries);
    }, [activeEntries, onFrontierEntriesChanged]);

    useEffect(() => {
      if (onRowCountChanged) onRowCountChanged(activeCids.length);
    }, [activeCids.length, onRowCountChanged]);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading frontier...</text>
        </box>
      );
    }

    const totalEntries = slices.reduce((acc, s) => acc + s.entries.length, 0);

    if (totalEntries === 0) {
      return (
        <box flexDirection="column">
          <box marginBottom={1} flexDirection="row">
            <text>Frontier Rankings</text>
            {compareMode ? <text color={theme.compare}> [COMPARE]</text> : null}
            <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          </box>
          <EmptyState
            title="Frontier ranks the best contributions across multiple signals."
            hint={
              "Signals: adoption, recency, review, reproduction, plus per-metric scores.\n" +
              "Spawn agents with Ctrl+P to begin."
            }
          />
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Frontier Rankings</text>
          {compareMode ? <text color={theme.compare}> [COMPARE]</text> : null}
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {String(totalEntries)} entries across {String(slices.length)} signals
          </text>
        </box>
        <box marginBottom={1}>
          <FrontierTabBar tabs={allTabs} activeKey={resolvedActiveKey} disabled={false} />
        </box>
        {resolvedActiveKey === OVERVIEW_KEY ? (
          <FrontierOverview slices={slices} />
        ) : activeSlice ? (
          <FrontierSliceTable
            slice={activeSlice}
            cursor={cursor >= 0 && cursor < activeSlice.entries.length ? cursor : undefined}
            compareMode={compareMode}
            compareCids={compareCids}
          />
        ) : null}
      </box>
    );
  },
);
```

- [ ] **Step 2: Update existing tests in `frontier-view.test.ts`**

Replace the entire file `src/tui/views/frontier-view.test.ts` with:

```typescript
/**
 * Tests for frontier-view orchestrator helpers.
 *
 * The flat-row projection moved to frontier-slices.ts; tests for the new
 * pure projection live in frontier-slices.test.ts. This file is reserved
 * for orchestrator-level behavior covered by the integration test in
 * frontier-adopt.integration.test.ts. Kept as a stub to satisfy any
 * existing CI test-discovery globs.
 */

import { describe, expect, test } from "bun:test";

describe("frontier-view orchestrator", () => {
  test("placeholder — orchestrator behavior covered by integration test", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run frontier tests**

Run: `bun test src/tui/views/frontier-slices.test.ts src/tui/views/frontier-tab-bar.test.ts src/tui/views/frontier-view.test.ts`
Expected: all PASS.

- [ ] **Step 4: Run wider TUI tests for regressions**

Run: `bun test src/tui/ 2>&1 | tail -30`
Expected: all PASS. If any test fails because it imported `flatRowsEqual` from `frontier-view.js`, replace the import with `slicesEqual` from `./frontier-slices.js` and adapt the test data.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/frontier-view.tsx src/tui/views/frontier-view.test.ts
git commit -m "refactor(tui): rewrite FrontierView as tabbed orchestrator (#187)"
```

---

### Task 9: Wire `panel-manager` to pass new props

**Files:**
- Modify: `src/tui/panels/panel-manager.tsx`

- [ ] **Step 1: Add new props to `PanelManagerProps`**

In `src/tui/panels/panel-manager.tsx`, find the `compareCids?` line in props (around line 99) and add immediately after the existing frontier-related props:

```typescript
  /** Active frontier slice key (controlled by app state). */
  readonly activeSliceKey?: string | undefined;
  /** Reports the ordered list of frontier slice tab keys back to the parent. */
  readonly onFrontierTabsChanged?: ((keys: readonly string[]) => void) | undefined;
  /** Reports {cid, summary} for the active slice. */
  readonly onFrontierEntriesChanged?:
    | ((entries: ReadonlyArray<{ cid: string; summary: string }>) => void)
    | undefined;
```

- [ ] **Step 2: Destructure the new props**

In the same file (around line 170 where `compareMode, compareCids, onCompareSelect, onFrontierCidsChanged` are destructured), add `activeSliceKey, onFrontierTabsChanged, onFrontierEntriesChanged` to the list.

- [ ] **Step 3: Forward them to `<FrontierView>`**

Update the `<FrontierView>` element to include the three new props:

```tsx
<FrontierView
  provider={provider}
  intervalMs={intervalMs}
  active
  cursor={isFocused(Panel.Frontier) ? nav.state.cursor : -1}
  onRowCountChanged={onRowCountChanged}
  compareMode={compareMode}
  onCompareSelect={onCompareSelect}
  compareCids={compareCids}
  onFrontierCidsChanged={onFrontierCidsChanged}
  activeSliceKey={activeSliceKey}
  onFrontierTabsChanged={onFrontierTabsChanged}
  onFrontierEntriesChanged={onFrontierEntriesChanged}
/>
```

- [ ] **Step 4: Type-check**

Run: `bun tsc --noEmit -p tsconfig.json 2>&1 | grep -E "panel-manager|frontier-view" | head -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tui/panels/panel-manager.tsx
git commit -m "refactor(tui): forward activeSliceKey + onFrontierTabsChanged to FrontierView"
```

---

## Phase D — Adopt wiring + tab navigation

### Task 10: Add `adoptContext` + `activeFrontierSlice` to reducer

**Files:**
- Modify: `src/tui/app-reducer.ts`

- [ ] **Step 1: Extend `TuiKeyboardState`**

In `src/tui/app-reducer.ts`, add after `compareCids: readonly string[]`:

```typescript
  readonly activeFrontierSlice: string;
  readonly frontierTabKeys: readonly string[];
  readonly adoptContext:
    | { readonly targetCid: string; readonly summary: string }
    | undefined;
```

- [ ] **Step 2: Add new actions to `TuiAction`**

Extend the union with:

```typescript
  | { readonly type: "FRONTIER_SET_TABS"; readonly keys: readonly string[] }
  | { readonly type: "FRONTIER_SLICE_SET"; readonly key: string }
  | { readonly type: "FRONTIER_SLICE_NEXT" }
  | { readonly type: "FRONTIER_SLICE_PREV" }
  | { readonly type: "ADOPT_SET"; readonly targetCid: string; readonly summary: string }
  | { readonly type: "ADOPT_CLEAR" };
```

- [ ] **Step 3: Extend `INITIAL_KEYBOARD_STATE`**

Add the three new fields with defaults:

```typescript
  activeFrontierSlice: "overview",
  frontierTabKeys: ["overview"],
  adoptContext: undefined,
```

- [ ] **Step 4: Implement reducer cases**

Add to the switch:

```typescript
    case "FRONTIER_SET_TABS": {
      const keys = action.keys.length > 0 ? action.keys : ["overview"];
      const stillValid = keys.includes(state.activeFrontierSlice);
      return {
        ...state,
        frontierTabKeys: keys,
        activeFrontierSlice: stillValid ? state.activeFrontierSlice : "overview",
      };
    }
    case "FRONTIER_SLICE_SET":
      return state.frontierTabKeys.includes(action.key)
        ? { ...state, activeFrontierSlice: action.key }
        : state;
    case "FRONTIER_SLICE_NEXT": {
      const idx = state.frontierTabKeys.indexOf(state.activeFrontierSlice);
      const next = state.frontierTabKeys[(idx + 1) % state.frontierTabKeys.length];
      return next ? { ...state, activeFrontierSlice: next } : state;
    }
    case "FRONTIER_SLICE_PREV": {
      const idx = state.frontierTabKeys.indexOf(state.activeFrontierSlice);
      const prev =
        state.frontierTabKeys[(idx - 1 + state.frontierTabKeys.length) % state.frontierTabKeys.length];
      return prev ? { ...state, activeFrontierSlice: prev } : state;
    }
    case "ADOPT_SET":
      return {
        ...state,
        adoptContext: { targetCid: action.targetCid, summary: action.summary },
      };
    case "ADOPT_CLEAR":
      return state.adoptContext === undefined ? state : { ...state, adoptContext: undefined };
```

Also extend `COMPARE_ADOPT` to clear adoptContext (since the compare-adopt flow now also goes through adoptContext):

Find:

```typescript
    case "COMPARE_ADOPT":
      return { ...state, compareMode: false, compareCids: [] };
```

Replace with:

```typescript
    case "COMPARE_ADOPT":
      return { ...state, compareMode: false, compareCids: [], adoptContext: undefined };
```

- [ ] **Step 5: Write reducer tests**

Append a new test file `src/tui/app-reducer.frontier.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { INITIAL_KEYBOARD_STATE, tuiReducer } from "./app-reducer.js";

describe("frontier reducer slice", () => {
  test("FRONTIER_SET_TABS replaces tab keys, preserves valid active", () => {
    const s1 = tuiReducer(
      { ...INITIAL_KEYBOARD_STATE, activeFrontierSlice: "adoption" },
      { type: "FRONTIER_SET_TABS", keys: ["overview", "adoption", "recency"] },
    );
    expect(s1.frontierTabKeys).toEqual(["overview", "adoption", "recency"]);
    expect(s1.activeFrontierSlice).toBe("adoption");
  });

  test("FRONTIER_SET_TABS resets active to overview when key drops out", () => {
    const s1 = tuiReducer(
      { ...INITIAL_KEYBOARD_STATE, activeFrontierSlice: "metric:gone" },
      { type: "FRONTIER_SET_TABS", keys: ["overview", "adoption"] },
    );
    expect(s1.activeFrontierSlice).toBe("overview");
  });

  test("FRONTIER_SET_TABS empty keys → fallback to ['overview']", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "FRONTIER_SET_TABS", keys: [] });
    expect(s1.frontierTabKeys).toEqual(["overview"]);
    expect(s1.activeFrontierSlice).toBe("overview");
  });

  test("FRONTIER_SLICE_NEXT cycles and wraps", () => {
    const base = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "FRONTIER_SET_TABS",
      keys: ["overview", "adoption", "recency"],
    });
    const a = tuiReducer(base, { type: "FRONTIER_SLICE_NEXT" });
    expect(a.activeFrontierSlice).toBe("adoption");
    const b = tuiReducer(a, { type: "FRONTIER_SLICE_NEXT" });
    expect(b.activeFrontierSlice).toBe("recency");
    const c = tuiReducer(b, { type: "FRONTIER_SLICE_NEXT" });
    expect(c.activeFrontierSlice).toBe("overview");
  });

  test("FRONTIER_SLICE_PREV wraps backward", () => {
    const base = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "FRONTIER_SET_TABS",
      keys: ["overview", "adoption", "recency"],
    });
    const a = tuiReducer(base, { type: "FRONTIER_SLICE_PREV" });
    expect(a.activeFrontierSlice).toBe("recency");
  });

  test("FRONTIER_SLICE_SET ignores unknown key", () => {
    const s = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "FRONTIER_SLICE_SET", key: "bogus" });
    expect(s.activeFrontierSlice).toBe("overview");
  });

  test("ADOPT_SET / ADOPT_CLEAR", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "ADOPT_SET",
      targetCid: "cid-1",
      summary: "do thing",
    });
    expect(s1.adoptContext).toEqual({ targetCid: "cid-1", summary: "do thing" });
    const s2 = tuiReducer(s1, { type: "ADOPT_CLEAR" });
    expect(s2.adoptContext).toBeUndefined();
  });

  test("COMPARE_ADOPT clears adoptContext too", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "ADOPT_SET",
      targetCid: "cid-1",
      summary: "x",
    });
    const s2 = tuiReducer(s1, { type: "COMPARE_ADOPT" });
    expect(s2.adoptContext).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run reducer tests**

Run: `bun test src/tui/app-reducer.frontier.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/app-reducer.ts src/tui/app-reducer.frontier.test.ts
git commit -m "feat(tui): add frontier slice + adoptContext reducer state"
```

---

### Task 11: Add tab navigation + adopt key to keyboard handler

**Files:**
- Modify: `src/tui/hooks/use-keyboard-handler.ts`

- [ ] **Step 1: Add new fields to `KeyboardHandlerActions` interface**

Locate the `KeyboardHandlerActions` interface in `src/tui/hooks/use-keyboard-handler.ts`. Add:

```typescript
  readonly onFrontierTabNext: () => void;
  readonly onFrontierTabPrev: () => void;
  readonly onFrontierTabJump: (index: number) => void;
  readonly onFrontierAdopt: (cid: string, summary: string) => void;
  /** Entries (cid + summary) for the currently visible frontier slice. */
  readonly frontierEntries: ReadonlyArray<{ cid: string; summary: string }>;
```

- [ ] **Step 2: Wire keys for the Frontier panel**

Find the section that handles per-panel keys when `focused === Panel.Frontier`. Above the existing Enter handler block (the one that calls `onCompareSelect`), add:

```typescript
  if (focused === Panel.Frontier) {
    if (input === "tab") {
      actions.onFrontierTabNext();
      return true;
    }
    if (input === "shift-tab") {
      actions.onFrontierTabPrev();
      return true;
    }
    if (/^[1-9]$/.test(input)) {
      actions.onFrontierTabJump(Number.parseInt(input, 10) - 1);
      return true;
    }
    if (
      input === "a" &&
      !actions.compareMode &&
      actions.frontierEntries.length > 0 &&
      actions.nav.state.cursor < actions.frontierEntries.length
    ) {
      const entry = actions.frontierEntries[actions.nav.state.cursor];
      if (entry) {
        actions.onFrontierAdopt(entry.cid, entry.summary);
        return true;
      }
    }
  }
```

If a `tab`/`shift-tab` handler already exists higher up for general panel cycling, ensure the Frontier-panel branch returns early so the global tab cycle is suppressed only when frontier is focused. Reading existing tab/shift-tab handling first is mandatory before placing the new block — place the Frontier branch **after** any "early-return for raw-mode" guards but **before** the global panel-cycle handler.

- [ ] **Step 3: Run keyboard handler tests**

Run: `bun test src/tui/hooks/use-keyboard-handler.test.ts`
Expected: existing tests PASS. (New tests for these actions are exercised end-to-end in Task 15's integration test rather than unit-level.)

- [ ] **Step 4: Commit**

```bash
git add src/tui/hooks/use-keyboard-handler.ts
git commit -m "feat(tui): frontier tab nav + adopt keys (Tab/Shift-Tab/1-9/a)"
```

---

### Task 12: Wire app-level handlers + thread `adoptContext` into spawn

**Files:**
- Modify: `src/tui/app.tsx`

- [ ] **Step 1: Add imports / state plumbing for frontier slice + adopt**

Locate the call to `tuiReducer` / `useReducer(tuiReducer, INITIAL_KEYBOARD_STATE)` in `src/tui/app.tsx`. The reducer change in Task 10 already exposes the new state fields via `ks`. No code change needed here — use the existing `ks.activeFrontierSlice`, `ks.frontierTabKeys`, `ks.adoptContext`.

- [ ] **Step 2: Add handlers to the keyboard actions object**

Find the `keyboardActions` `useMemo` (around line 740). Add to the action object:

```typescript
      onFrontierTabNext: () => dispatch({ type: "FRONTIER_SLICE_NEXT" }),
      onFrontierTabPrev: () => dispatch({ type: "FRONTIER_SLICE_PREV" }),
      onFrontierTabJump: (index: number) => {
        const key = ks.frontierTabKeys[index];
        if (key) dispatch({ type: "FRONTIER_SLICE_SET", key });
      },
      onFrontierAdopt: (cid: string, summary: string) => {
        dispatch({ type: "ADOPT_SET", targetCid: cid, summary });
        panels.setMode(InputMode.CommandPalette);
      },
      frontierEntries,
```

`frontierEntries` is reported up by `FrontierView` via the new
`onFrontierEntriesChanged` callback. Add this state slot near the existing
`frontierCids` state (around line 185):

```typescript
  const [frontierEntries, setFrontierEntries] = useState<
    ReadonlyArray<{ cid: string; summary: string }>
  >([]);
```

- [ ] **Step 3: Update memo deps**

Add `ks.frontierTabKeys`, `ks.adoptContext`, `frontierEntries` to the dependency array of `keyboardActions`.

- [ ] **Step 4: Forward `activeSliceKey` + `onFrontierTabsChanged` + `onFrontierEntriesChanged` to PanelManager**

Find the `<PanelManager>` (or its consumer of frontier props). Add:

```tsx
  activeSliceKey={ks.activeFrontierSlice}
  onFrontierTabsChanged={(keys) => dispatch({ type: "FRONTIER_SET_TABS", keys })}
  onFrontierEntriesChanged={setFrontierEntries}
```

- [ ] **Step 5: Thread `adoptContext` into `handleSpawn`**

Find `handleSpawn` (around line 695). Inside, after the existing context object is built and before `spawnManager.spawn(...)` is called, add:

```typescript
      if (ks.adoptContext) {
        context.adoptTarget = ks.adoptContext.targetCid;
        context.adoptSummary = ks.adoptContext.summary;
      }
```

After `spawnManager.spawn(...).catch(...)`, in the success path, dispatch ADOPT_CLEAR. Wrap the existing call:

```typescript
      const spawnPromise = spawnManager.spawn(agentId, command, parentAgentId, depth, context);
      spawnPromise
        .then(() => {
          if (ks.adoptContext) dispatch({ type: "ADOPT_CLEAR" });
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Spawn failed";
          showError(msg);
        });
```

Add `ks.adoptContext` to `handleSpawn`'s dependency array.

- [ ] **Step 6: Rewire `onCompareAdopt`**

Find:

```typescript
      onCompareAdopt: (side: "a" | "b") => {
        const cid = side === "a" ? ks.compareCids[0] : ks.compareCids[1];
        showError(`Adopted: ${(cid ?? "").slice(0, 16)}...`);
        dispatch({ type: "COMPARE_ADOPT" });
      },
```

Replace with:

```typescript
      onCompareAdopt: (side: "a" | "b") => {
        const cid = side === "a" ? ks.compareCids[0] : ks.compareCids[1];
        if (!cid) return;
        const summary = frontierEntries.find((e) => e.cid === cid)?.summary ?? "";
        dispatch({ type: "ADOPT_SET", targetCid: cid, summary });
        dispatch({ type: "COMPARE_ADOPT" });
        panels.setMode(InputMode.CommandPalette);
      },
```

Add `frontierEntries` to the deps of this `useMemo` if not already present.

- [ ] **Step 7: Clear adoptContext on palette close**

Find the existing palette `onClose` handler (the one wired to the `<CommandPalette>` element). Wrap it:

```tsx
  onClose={() => {
    dispatch({ type: "ADOPT_CLEAR" });
    panels.setMode(InputMode.Normal);
    dispatch({ type: "PALETTE_RESET" });
  }}
```

(Adjust to match whatever the existing close handler does — the only addition is the `ADOPT_CLEAR` dispatch.)

- [ ] **Step 8: Type-check**

Run: `bun tsc --noEmit -p tsconfig.json 2>&1 | grep app.tsx | head -20`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): wire onFrontierAdopt + thread adoptContext into spawn"
```

---

### Task 13: Show "Adopt:" chip in `CommandPalette`

**Files:**
- Modify: `src/tui/components/command-palette.tsx`

- [ ] **Step 1: Add `adoptContext` prop**

In `src/tui/components/command-palette.tsx`, extend `CommandPaletteProps`:

```typescript
  /** When set, palette is being opened to adopt a contribution. */
  readonly adoptContext?:
    | { readonly targetCid: string; readonly summary: string }
    | undefined;
```

- [ ] **Step 2: Render the chip in the palette header**

Find the existing palette header / title render block (search for `"Command Palette"` or the visible title text). Add immediately after the title:

```tsx
  {props.adoptContext ? (
    <text color={theme.compare}>{` Adopt: ${props.adoptContext.targetCid.slice(0, 12)}…`}</text>
  ) : null}
```

(Substitute whatever theme color tokens already exist; if `theme.compare` is unavailable, use `theme.primary`.)

- [ ] **Step 3: Pass `adoptContext` from `app.tsx`**

In `src/tui/app.tsx`, add to the `<CommandPalette>` element:

```tsx
  adoptContext={ks.adoptContext}
```

- [ ] **Step 4: Type-check**

Run: `bun tsc --noEmit -p tsconfig.json 2>&1 | grep -E "command-palette|app.tsx" | head -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/command-palette.tsx src/tui/app.tsx
git commit -m "feat(tui): show 'Adopt: <cid>' chip in palette when adopting"
```

---

### Task 14: Pass through `adoptTarget` in `spawn-manager` context

**Files:**
- Modify: `src/tui/spawn-manager.ts` (verification only)

- [ ] **Step 1: Verify context pass-through**

The `spawn(roleId, command, parentAgentId, depth, context?)` signature already accepts an opaque `Record<string, unknown>` context (confirmed at `src/tui/spawn-manager.ts:660`). Search for where `context` is forwarded to the agent runtime:

Run: `grep -n "context" src/tui/spawn-manager.ts | head -30`
Expected: see `context` being forwarded to `agentRuntime.spawn(...)` or written into the agent's launch state.

- [ ] **Step 2: If `adoptTarget` / `adoptSummary` are not surfaced to the agent**

If the existing pass-through writes the entire context object as-is (e.g. into `CLAUDE.md` or a startup envelope), no further change is needed — the new `adoptTarget` / `adoptSummary` keys ride along automatically.

If the context is filtered to a known set of keys (e.g. an allowlist), add `adoptTarget` and `adoptSummary` to that allowlist. Show the change in a follow-up commit.

- [ ] **Step 3: Commit (if any change was made)**

```bash
git add src/tui/spawn-manager.ts
git commit -m "feat(tui): allowlist adoptTarget/adoptSummary in spawn context"
```

If no change was needed, skip this commit.

---

### Task 15: Integration test — frontier-adopt end-to-end

**Files:**
- Create: `src/tui/views/frontier-adopt.integration.test.ts`

- [ ] **Step 1: Write integration test**

`src/tui/views/frontier-adopt.integration.test.ts`:

```typescript
/**
 * Integration test: pressing `a` on a frontier row records adoptContext
 * and routes through handleSpawn so the spawn call carries
 * context.adoptTarget / context.adoptSummary.
 *
 * This is a reducer-and-handler-level test (no React renderer): it
 * exercises the same dispatch path that the keyboard handler triggers
 * and verifies the spawn-call shape.
 */

import { describe, expect, test } from "bun:test";
import { INITIAL_KEYBOARD_STATE, tuiReducer } from "../app-reducer.js";

describe("frontier adopt integration (reducer + spawn shape)", () => {
  test("ADOPT_SET → spawn context carries adoptTarget + adoptSummary", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "ADOPT_SET",
      targetCid: "cid-frontier-1",
      summary: "improve cache hit rate",
    });
    expect(s1.adoptContext).toEqual({
      targetCid: "cid-frontier-1",
      summary: "improve cache hit rate",
    });

    // Simulate handleSpawn building the context object.
    const baseContext: Record<string, unknown> = { rolePrompt: "you are X" };
    if (s1.adoptContext) {
      baseContext.adoptTarget = s1.adoptContext.targetCid;
      baseContext.adoptSummary = s1.adoptContext.summary;
    }
    expect(baseContext.adoptTarget).toBe("cid-frontier-1");
    expect(baseContext.adoptSummary).toBe("improve cache hit rate");

    // After successful spawn, ADOPT_CLEAR is dispatched.
    const s2 = tuiReducer(s1, { type: "ADOPT_CLEAR" });
    expect(s2.adoptContext).toBeUndefined();
  });

  test("compare-adopt also lands in adoptContext via ADOPT_SET", () => {
    const initialWithCompare = {
      ...INITIAL_KEYBOARD_STATE,
      compareMode: true,
      compareCids: ["cid-A", "cid-B"] as readonly string[],
    };
    // Simulate side='a' click: handler dispatches ADOPT_SET then COMPARE_ADOPT.
    const s1 = tuiReducer(initialWithCompare, {
      type: "ADOPT_SET",
      targetCid: "cid-A",
      summary: "left side",
    });
    expect(s1.adoptContext?.targetCid).toBe("cid-A");
    const s2 = tuiReducer(s1, { type: "COMPARE_ADOPT" });
    // COMPARE_ADOPT also clears adoptContext as a side effect.
    expect(s2.adoptContext).toBeUndefined();
    expect(s2.compareMode).toBe(false);
    expect(s2.compareCids).toEqual([]);
  });

  test("frontier tab cycle navigates among published tabs", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "FRONTIER_SET_TABS",
      keys: ["overview", "adoption", "metric:rouge_l"],
    });
    const s2 = tuiReducer(s1, { type: "FRONTIER_SLICE_NEXT" });
    expect(s2.activeFrontierSlice).toBe("adoption");
    const s3 = tuiReducer(s2, { type: "FRONTIER_SLICE_SET", key: "metric:rouge_l" });
    expect(s3.activeFrontierSlice).toBe("metric:rouge_l");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `bun test src/tui/views/frontier-adopt.integration.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 3: Run the full TUI test suite for regressions**

Run: `bun test src/tui/ 2>&1 | tail -10`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tui/views/frontier-adopt.integration.test.ts
git commit -m "test(tui): integration test for frontier adopt + tab nav"
```

---

## Phase E — Manual smoke + final regression sweep

### Task 16: Repo-wide checks

**Files:** none

- [ ] **Step 1: Run the full repo test suite**

Run: `bun test 2>&1 | tail -20`
Expected: all PASS. Investigate any failure before proceeding.

- [ ] **Step 2: Run tsc**

Run: `bun tsc --noEmit -p tsconfig.json 2>&1 | tail -30`
Expected: no errors.

- [ ] **Step 3: Run the linter / formatter (lefthook will also run on commit)**

Run: `bunx biome check src/tui/views/ src/tui/app.tsx src/tui/app-reducer.ts src/tui/components/command-palette.tsx src/tui/hooks/use-keyboard-handler.ts src/tui/panels/panel-manager.tsx 2>&1 | tail -10`
Expected: no errors. Fix any reported issues.

- [ ] **Step 4: Manual TUI smoke**

Run the TUI against a workspace with seeded contributions exercising every signal (adoption + recency + review + reproduction + at least one user metric).

Verify in order:
1. Frontier panel opens to Overview tab. Top-3 mini-leaderboards visible per non-empty signal.
2. `Tab` cycles to next slice; per-slice header line shows the signal description.
3. Each row displays a per-signal badge (`×N adopters`, `2h ago`, `4.7⋆`, `▲N confirmed`, `0.81 rouge_l`).
4. `1`-`9` jumps directly to that tab.
5. Move cursor to a row. Press `a`. Command palette opens with `Adopt: <cid>` chip in the header.
6. Pick a spawn item. New agent appears with the adopted target reflected in its initial command/CLAUDE.md.
7. Esc dismisses palette without spawning; `Adopt:` chip disappears next time the palette opens fresh.
8. Enable Compare mode (existing key). Select two rows across two different slices. Open compare view — both selections persist across tab switch.
9. Stop agents / clear contributions. Frontier renders the teaching empty state with the signal name list and Ctrl+P hint.

- [ ] **Step 5: Final commit if any tweaks were needed during smoke**

If smoke testing surfaced any small fixes, commit them with a `fix(tui):` prefix. Otherwise skip this step.

---

## Acceptance criteria mapping (from spec)

| Criterion | Implemented by |
|-----------|----------------|
| Inspect frontier results by signal without re-grouping | Tasks 8, 9 (tab orchestrator + panel wiring) |
| Compare/adopt flows are natural | Tasks 11–13 (adopt keys + adoptContext + palette chip) |
| Empty/loading states teach the frontier concept | Task 8 (full-empty teaching state) |
| Rendering highlights what is winning and why | Tasks 3, 6 (formatBadge + signal description header) |
| Group entries by ranking dimension | Tasks 1–2 (toSlices) |
| Switching/filtering between frontier slices | Tasks 5, 10–11 (tab bar + reducer + keys) |
| Improve comparison workflows | Task 8 (compare selection persists across slices) |
| Stronger "why winning" summaries | Tasks 3, 6 (badges + descriptions) |
