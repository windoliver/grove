# TUI Context-Aware Hint Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue [#309](https://github.com/windoliver/grove/issues/309) — context-aware hint bar driven by the topmost view of the `PagesStore` from #303. View modules declare hints as module-level constants; a central `hint-map` assembles them; a `useHints` hook subscribes to stack changes; `<HintBar>` renders width-aware truncated key-action chain; `<PagesRouter>` wires it.

**Architecture:** Pure data class lookup (`hint-map.ts`) + thin React hook (`useHints` via `useSyncExternalStore`) + presentational component (`<HintBar>`). No global registry, no runtime hint registration. Per-view `KeyAction[]` constants exported alongside view modules. The DAG panel's hints match the issue acceptance literal verbatim.

**Tech Stack:** TypeScript (strict), Bun test runner, React (OpenTUI), Biome lint. Tests use `react-test-renderer` + `bun:test` per existing convention (NOT `@testing-library/react`).

**Spec:** `docs/superpowers/specs/2026-05-11-tui-hint-bar-design.md`

---

## Codebase Conventions (read before any test or component work)

1. **React tests use `react-test-renderer` + `bun:test`.** NOT `@testing-library/react`.
   Reference: `src/tui/components/entity-view.test.tsx`. Pattern:

   ```tsx
   import type React from "react";
   import TestRenderer, { act } from "react-test-renderer";
   (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

   let renderer!: TestRenderer.ReactTestRenderer;
   await act(async () => {
     renderer = TestRenderer.create((<MyComponent ... />) as React.ReactElement);
   });
   const flat = JSON.stringify(renderer.toJSON());
   expect(flat).toContain("expected text");
   renderer.unmount();
   ```

   **Always cast the JSX to `React.ReactElement`** at the `TestRenderer.create` site — main branch enforces this via TypeScript strict mode and CI fails without it.

2. **OpenTUI components use `<box>` and `<text>` (lowercase JSX intrinsic).** No `<div>`, no `<span>`. Theme colors come from `src/tui/theme.ts` (`theme.focus`, `theme.text`, `theme.secondary`).

3. **Subscribe to `PagesStore` via `useSyncExternalStore`.** Subscribe handler signature is `(cb: () => void) => () => void`. `PagesStore.subscribe("top", fn)` returns the unsubscribe — wrap to drop the event arg: `(cb) => store.subscribe("top", () => cb())`.

4. **Frozen arrays.** All `KeyAction[]` exported from view modules and stored in `STATIC` map are `Object.freeze`'d so consumers can't mutate, and the freeze is asserted in tests.

5. **Linter.** Biome rejects `noEmptyBlockStatements`. Use `// noop for test` inside arrow functions when needed.

---

## File Structure

| File | Purpose |
| --- | --- |
| `src/tui/data/hint-map.ts` | `KeyAction` type, `hintsForPage(page)`, central STATIC map. Imports per-view constants. |
| `src/tui/data/hint-map.test.ts` | Lookup tests + acceptance literal + exhaustive PageKind coverage. |
| `src/tui/hooks/use-hints.ts` | `useHints(store)` via `useSyncExternalStore`. |
| `src/tui/hooks/use-hints.test.tsx` | Hook re-renders on stack mutation. |
| `src/tui/components/hint-bar.tsx` | `<HintBar hints width />` — width-aware truncation. |
| `src/tui/components/hint-bar.test.tsx` | Render + truncation tests. |
| `src/tui/views/panel-hints.ts` | `PANEL_HINTS` record keyed by panel name (agents/dag/sessions/tasks/reviews/feed). |
| `src/tui/screens/preset-select.tsx` *(modify)* | Append `export const PRESET_SELECT_HINTS`. |
| `src/tui/screens/goal-input.tsx` *(modify)* | Append `export const GOAL_INPUT_HINTS`. |
| `src/tui/screens/agent-detect.tsx` *(modify)* | Append `export const LAUNCH_PREVIEW_HINTS`. |
| `src/tui/screens/spawn-progress.tsx` *(modify)* | Append `export const SPAWNING_HINTS`. |
| `src/tui/screens/running-view.tsx` *(modify)* | Append `export const RUNNING_VIEW_HINTS`. |
| `src/tui/screens/complete-view.tsx` *(modify)* | Append `export const COMPLETE_HINTS`. |
| `src/tui/app.tsx` *(modify)* | Append `export const ADVANCED_HINTS`. |
| `src/tui/components/pages-router.tsx` *(modify)* | Render `<HintBar hints={useHints(store)} width={width} />` after the page component. |
| `tests/tui/hint-bar-acceptance.test.tsx` *(create)* | End-to-end: push panel:dag → tree contains literal acceptance hint chain. |

---

## Task 1: KeyAction type + central hint-map module

**Files:**
- Create: `src/tui/data/hint-map.ts`
- Create: `src/tui/data/hint-map.test.ts`

**Goal:** Pure data module. Exports `KeyAction` type, `DEFAULT_HINTS`, and `hintsForPage(page)`. Inline literal constants for the seven page-kind hints + six panel sub-hints — Task 4+ will move them to their respective view modules and replace the inline copies with imports. Keeping them inline now lets Task 1 ship a self-contained, fully tested unit.

- [ ] **Step 1.1: Write the failing test scaffold**

Create `src/tui/data/hint-map.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Page, PageKind } from "./pages-store.js";
import { DEFAULT_HINTS, hintsForPage, type KeyAction } from "./hint-map.js";

const ALL_PAGE_KINDS: readonly PageKind[] = [
  "preset-select",
  "goal-input",
  "agent-detect",
  "launch-preview",
  "spawning",
  "running",
  "complete",
  "advanced",
  "panel",
  "entity-detail",
];

describe("hintsForPage — basics", () => {
  test("running page returns non-empty KeyAction chain", () => {
    const hints = hintsForPage({ kind: "running" });
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toMatchObject({ key: expect.any(String), label: expect.any(String) });
  });

  test("each non-panel PageKind resolves to a frozen, non-empty array", () => {
    for (const kind of ALL_PAGE_KINDS) {
      if (kind === "panel" || kind === "entity-detail") continue;
      const hints = hintsForPage({ kind });
      expect(hints.length).toBeGreaterThan(0);
      expect(Object.isFrozen(hints)).toBe(true);
    }
  });

  test("DEFAULT_HINTS is frozen and non-empty", () => {
    expect(Object.isFrozen(DEFAULT_HINTS)).toBe(true);
    expect(DEFAULT_HINTS.length).toBeGreaterThan(0);
  });
});

describe("hintsForPage — panel routing", () => {
  test("panel:dag matches issue #309 acceptance literal", () => {
    const hints = hintsForPage({ kind: "panel", params: { panel: "dag" } });
    expect(hints).toEqual([
      { key: "Enter", label: "Focus" },
      { key: "Space", label: "Expand" },
      { key: "R", label: "Review" },
      { key: "M", label: "Merge" },
      { key: "L", label: "Logs" },
    ]);
  });

  test("all 6 known panel names resolve to non-empty KeyAction arrays", () => {
    const panels = ["agents", "dag", "sessions", "tasks", "reviews", "feed"];
    for (const panel of panels) {
      const hints = hintsForPage({ kind: "panel", params: { panel } });
      expect(hints.length).toBeGreaterThan(0);
    }
  });

  test("unknown panel name falls back to DEFAULT_HINTS", () => {
    const hints = hintsForPage({ kind: "panel", params: { panel: "bogus" } });
    expect(hints).toBe(DEFAULT_HINTS);
  });

  test("panel page without params falls back to DEFAULT_HINTS", () => {
    const hints = hintsForPage({ kind: "panel" });
    expect(hints).toBe(DEFAULT_HINTS);
  });
});

describe("hintsForPage — entity-detail routing", () => {
  test("entity-detail without params falls back to DEFAULT_HINTS", () => {
    const hints = hintsForPage({ kind: "entity-detail" });
    expect(hints).toBe(DEFAULT_HINTS);
  });

  test("entity-detail with unknown kind falls back to DEFAULT_HINTS", () => {
    const hints = hintsForPage({ kind: "entity-detail", params: { kind: "bogus" } });
    expect(hints).toBe(DEFAULT_HINTS);
  });
});

describe("KeyAction shape", () => {
  test("KeyAction has exactly { key, label } and no extras", () => {
    const action: KeyAction = { key: "Enter", label: "Focus" };
    const keys = Object.keys(action).sort();
    expect(keys).toEqual(["key", "label"]);
  });
});
```

- [ ] **Step 1.2: Run tests, expect module-not-found**

Run: `bun test src/tui/data/hint-map.test.ts`
Expected: FAIL — `Cannot find module './hint-map.js'`.

- [ ] **Step 1.3: Implement `hint-map.ts`**

Create `src/tui/data/hint-map.ts`:

```ts
/**
 * Central hint-map for the context-aware hint bar (#309).
 *
 * Maps each PageKind (and panel sub-kind) to a frozen KeyAction[].
 * useHints() reads via hintsForPage(top). No runtime registration —
 * all entries are module-level constants assembled here.
 *
 * Per-view constants live alongside their view modules and are
 * imported here. While Task 1 ships an inline copy for testability,
 * Tasks 4-10 move each constant to its view module and replace the
 * inline copy with an import.
 */

import type { Page, PageKind } from "./pages-store.js";

export interface KeyAction {
  readonly key: string;
  readonly label: string;
}

export type HintKey = PageKind | `panel:${string}` | `entity-detail:${string}`;

export const DEFAULT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const PRESET_SELECT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Select" },
  { key: "?", label: "Details" },
  { key: "q", label: "Quit" },
]);

const GOAL_INPUT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Continue" },
  { key: "Esc", label: "Back" },
  { key: "Ctrl+U", label: "Clear" },
]);

const LAUNCH_PREVIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Launch" },
  { key: "c", label: "CLI" },
  { key: "e", label: "Edit" },
  { key: "Esc", label: "Back" },
]);

const SPAWNING_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Esc", label: "Cancel" },
]);

const RUNNING_VIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: ":", label: "Goto" },
  { key: "/", label: "Filter" },
  { key: "1-5", label: "Panel" },
  { key: "Esc", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const COMPLETE_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "NewSession" },
  { key: "q", label: "Quit" },
]);

const ADVANCED_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Ctrl+B", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const PANEL_GENERIC: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Detail" },
  { key: "Esc", label: "Close" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const DAG_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Focus" },
  { key: "Space", label: "Expand" },
  { key: "R", label: "Review" },
  { key: "M", label: "Merge" },
  { key: "L", label: "Logs" },
]);

const STATIC: Partial<Record<HintKey, readonly KeyAction[]>> = {
  "preset-select": PRESET_SELECT_HINTS,
  "goal-input": GOAL_INPUT_HINTS,
  "agent-detect": LAUNCH_PREVIEW_HINTS,
  "launch-preview": LAUNCH_PREVIEW_HINTS,
  spawning: SPAWNING_HINTS,
  running: RUNNING_VIEW_HINTS,
  complete: COMPLETE_HINTS,
  advanced: ADVANCED_HINTS,
  "panel:agents": PANEL_GENERIC,
  "panel:dag": DAG_HINTS,
  "panel:sessions": PANEL_GENERIC,
  "panel:tasks": PANEL_GENERIC,
  "panel:reviews": PANEL_GENERIC,
  "panel:feed": PANEL_GENERIC,
};

export function hintsForPage(page: Page): readonly KeyAction[] {
  if (page.kind === "panel") {
    const panel = page.params?.panel ?? "";
    return STATIC[`panel:${panel}` as HintKey] ?? DEFAULT_HINTS;
  }
  if (page.kind === "entity-detail") {
    const kind = page.params?.kind ?? "";
    return STATIC[`entity-detail:${kind}` as HintKey] ?? DEFAULT_HINTS;
  }
  return STATIC[page.kind] ?? DEFAULT_HINTS;
}
```

- [ ] **Step 1.4: Run tests, expect pass**

Run: `bun test src/tui/data/hint-map.test.ts`
Expected: all tests pass (≥ 8 tests).

- [ ] **Step 1.5: Typecheck + lint**

Run: `bun run typecheck`
Expected: 0 new errors.

Run: `bun run lint src/tui/data/hint-map.ts src/tui/data/hint-map.test.ts`
Expected: 0 errors.

- [ ] **Step 1.6: Commit**

```bash
git add src/tui/data/hint-map.ts src/tui/data/hint-map.test.ts
git commit -m "feat(tui): central hint-map module + KeyAction type (#309)"
```

---

## Task 2: useHints React hook

**Files:**
- Create: `src/tui/hooks/use-hints.ts`
- Create: `src/tui/hooks/use-hints.test.tsx`

**Pattern reference:** `src/tui/hooks/use-screen-stack.tsx` (Task 2 of #303) — same `useSyncExternalStore` subscription wrapping.

- [ ] **Step 2.1: Write failing hook tests**

Create `src/tui/hooks/use-hints.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { hintsForPage, type KeyAction } from "../data/hint-map.js";
import { PagesStore } from "../data/pages-store.js";
import { useHints } from "./use-hints.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  store,
  onValue,
}: {
  store: PagesStore;
  onValue: (v: readonly KeyAction[]) => void;
}): null {
  const hints = useHints(store);
  onValue(hints);
  return null;
}

describe("useHints", () => {
  test("returns hints matching the top page on initial render", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    let captured: readonly KeyAction[] | undefined;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={(v) => {
              captured = v;
            }}
          />
        ) as React.ReactElement,
      );
    });

    expect(captured).toEqual(hintsForPage({ kind: "running" }));
    renderer.unmount();
  });

  test("returns updated hints after push", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    const renders: (readonly KeyAction[])[] = [];

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={(v) => {
              renders.push(v);
            }}
          />
        ) as React.ReactElement,
      );
    });

    await act(async () => {
      store.push({ kind: "panel", params: { panel: "dag" } });
    });

    expect(renders.at(-1)).toEqual(
      hintsForPage({ kind: "panel", params: { panel: "dag" } }),
    );
    renderer.unmount();
  });

  test("returns prior hints after pop", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    store.push({ kind: "panel", params: { panel: "dag" } });

    const renders: (readonly KeyAction[])[] = [];

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={(v) => {
              renders.push(v);
            }}
          />
        ) as React.ReactElement,
      );
    });

    await act(async () => {
      store.pop();
    });

    expect(renders.at(-1)).toEqual(hintsForPage({ kind: "running" }));
    renderer.unmount();
  });

  test("returns [] when stack is empty", async () => {
    const store = new PagesStore();

    let captured: readonly KeyAction[] | undefined;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={(v) => {
              captured = v;
            }}
          />
        ) as React.ReactElement,
      );
    });

    expect(captured).toEqual([]);
    renderer.unmount();
  });

  test("store mutations after unmount do not trigger renders", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    let renderCount = 0;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={() => {
              renderCount += 1;
            }}
          />
        ) as React.ReactElement,
      );
    });

    const countAtUnmount = renderCount;
    await act(async () => {
      renderer.unmount();
    });

    store.push({ kind: "panel", params: { panel: "dag" } });

    await act(async () => {
      await Promise.resolve();
    });

    expect(renderCount).toBe(countAtUnmount);
  });
});
```

- [ ] **Step 2.2: Run tests, expect module-not-found**

Run: `bun test src/tui/hooks/use-hints.test.tsx`
Expected: FAIL — `Cannot find module './use-hints.js'`.

- [ ] **Step 2.3: Implement the hook**

Create `src/tui/hooks/use-hints.ts`:

```ts
/**
 * useHints — React subscription to a PagesStore (#309).
 *
 * Subscribes to the `top` event channel via useSyncExternalStore and
 * returns a frozen KeyAction[] derived from the current top page via
 * hintsForPage(). Returns [] when the stack is empty.
 */

import { useSyncExternalStore } from "react";
import { hintsForPage, type KeyAction } from "../data/hint-map.js";
import type { PagesStore } from "../data/pages-store.js";

export function useHints(store: PagesStore): readonly KeyAction[] {
  const snapshot = useSyncExternalStore(
    (cb) => store.subscribe("top", () => cb()),
    () => store.snapshot(),
  );
  const top = snapshot[snapshot.length - 1];
  return top ? hintsForPage(top) : [];
}
```

- [ ] **Step 2.4: Run tests, expect pass**

Run: `bun test src/tui/hooks/use-hints.test.tsx`
Expected: 5 passed.

- [ ] **Step 2.5: Typecheck + lint**

Run: `bun run typecheck`
Expected: 0 new errors.

Run: `bun run lint src/tui/hooks/use-hints.ts src/tui/hooks/use-hints.test.tsx`
Expected: 0 errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/tui/hooks/use-hints.ts src/tui/hooks/use-hints.test.tsx
git commit -m "feat(tui): add useHints hook for context-aware hint bar (#309)"
```

---

## Task 3: HintBar component

**Files:**
- Create: `src/tui/components/hint-bar.tsx`
- Create: `src/tui/components/hint-bar.test.tsx`

**Pattern reference:** `src/tui/components/breadcrumb-bar.tsx` (renders with `<box>` + `<text>`, theme colors, width-aware tiers).

- [ ] **Step 3.1: Write failing component tests**

Create `src/tui/components/hint-bar.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { KeyAction } from "../data/hint-map.js";
import { HintBar, truncateForWidth } from "./hint-bar.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAMPLE: readonly KeyAction[] = [
  { key: "Enter", label: "Focus" },
  { key: "Space", label: "Expand" },
  { key: "R", label: "Review" },
  { key: "M", label: "Merge" },
  { key: "L", label: "Logs" },
];

describe("HintBar rendering", () => {
  test("renders all KeyAction labels at width=120", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        (<HintBar hints={SAMPLE} width={120} />) as React.ReactElement,
      );
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("Focus");
    expect(flat).toContain("Expand");
    expect(flat).toContain("Review");
    expect(flat).toContain("Merge");
    expect(flat).toContain("Logs");

    renderer.unmount();
  });

  test("renders brackets around each key", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        (<HintBar hints={SAMPLE} width={120} />) as React.ReactElement,
      );
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("[Enter]");
    expect(flat).toContain("[Space]");

    renderer.unmount();
  });

  test("returns null at width < 40", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        (<HintBar hints={SAMPLE} width={30} />) as React.ReactElement,
      );
    });

    expect(renderer.toJSON()).toBe(null);
    renderer.unmount();
  });

  test("returns null when hints is empty", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        (<HintBar hints={[]} width={120} />) as React.ReactElement,
      );
    });

    expect(renderer.toJSON()).toBe(null);
    renderer.unmount();
  });

  test("appends ellipsis when truncated", () => {
    // SAMPLE full text: "[Enter]Focus  [Space]Expand  [R]Review  [M]Merge  [L]Logs"
    //   widths:           12          14           11        11        10  (incl. separator)
    // At width=40, only first 2-3 fit.
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        (<HintBar hints={SAMPLE} width={40} />) as React.ReactElement,
      );
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("…");
    expect(flat).toContain("Focus");
    // Last items should be missing.
    expect(flat).not.toContain("Logs");

    renderer.unmount();
  });
});

describe("truncateForWidth — pure", () => {
  test("returns all actions when width is generous", () => {
    const out = truncateForWidth(SAMPLE, 120);
    expect(out.actions).toEqual(SAMPLE);
    expect(out.truncated).toBe(false);
  });

  test("greedy: includes from start, never splits an action", () => {
    const out = truncateForWidth(SAMPLE, 40);
    // 40 - 4 (paddingX + ellipsis budget) = 36 chars available.
    // "[Enter]Focus" = 12, "  [Space]Expand" = 15 → 27, "  [R]Review" = 11 → 38 (too big).
    // So expect first 2 actions.
    expect(out.actions).toEqual(SAMPLE.slice(0, 2));
    expect(out.truncated).toBe(true);
  });

  test("returns empty + truncated=true when no action fits", () => {
    const out = truncateForWidth(SAMPLE, 10);
    expect(out.actions).toEqual([]);
    expect(out.truncated).toBe(true);
  });

  test("handles empty input", () => {
    const out = truncateForWidth([], 120);
    expect(out.actions).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run tests, expect module-not-found**

Run: `bun test src/tui/components/hint-bar.test.tsx`
Expected: FAIL — `Cannot find module './hint-bar.js'`.

- [ ] **Step 3.3: Implement the component**

Create `src/tui/components/hint-bar.tsx`:

```tsx
/**
 * <HintBar> — context-aware key-action chain rendered at the bottom of
 * the TUI (#309). Presentational only: takes `hints` + `width`, applies
 * width-aware truncation, returns null when nothing fits.
 *
 * Layout:
 *   "[Enter]Focus  [Space]Expand  [R]Review  [M]Merge  [L]Logs"
 *
 * Width tiers:
 *   >= 40 cols: greedy include + ellipsis if needed
 *   <  40 cols: render nothing (don't fight the breadcrumb for space)
 */

import React from "react";
import type { KeyAction } from "../data/hint-map.js";
import { theme } from "../theme.js";

const PADDING_X = 2; // 1 char on each side of the box
const ELLIPSIS_BUDGET = 2; // " …" suffix when truncated
const SEPARATOR = "  ";

export interface HintBarProps {
  readonly hints: readonly KeyAction[];
  readonly width: number;
}

export function truncateForWidth(
  hints: readonly KeyAction[],
  width: number,
): { actions: readonly KeyAction[]; truncated: boolean } {
  if (hints.length === 0) return { actions: [], truncated: false };
  const budget = width - PADDING_X - ELLIPSIS_BUDGET;
  if (budget <= 0) return { actions: [], truncated: true };

  const actions: KeyAction[] = [];
  let used = 0;
  for (let i = 0; i < hints.length; i++) {
    const a = hints[i];
    if (!a) continue;
    const cost = `[${a.key}]${a.label}`.length + (i === 0 ? 0 : SEPARATOR.length);
    if (used + cost > budget) {
      return { actions, truncated: true };
    }
    used += cost;
    actions.push(a);
  }
  return { actions, truncated: false };
}

export const HintBar: React.NamedExoticComponent<HintBarProps> = React.memo(function HintBar({
  hints,
  width,
}: HintBarProps): React.ReactNode {
  if (width < 40 || hints.length === 0) return null;
  const { actions, truncated } = truncateForWidth(hints, width);
  if (actions.length === 0) return null;

  const nodes: React.ReactNode[] = [];
  actions.forEach((a, i) => {
    if (i > 0) {
      nodes.push(
        <text key={`s${i}`} color={theme.secondary}>
          {SEPARATOR}
        </text>,
      );
    }
    nodes.push(
      <text key={`k${i}`} color={theme.focus}>
        {`[${a.key}]`}
      </text>,
      <text key={`l${i}`} color={theme.text}>
        {a.label}
      </text>,
    );
  });
  if (truncated) {
    nodes.push(
      <text key="ellipsis" color={theme.secondary}>
        {" …"}
      </text>,
    );
  }

  return (
    <box flexDirection="row" paddingX={1}>
      {nodes}
    </box>
  );
});
```

- [ ] **Step 3.4: Run tests, expect pass**

Run: `bun test src/tui/components/hint-bar.test.tsx`
Expected: 9 passed.

- [ ] **Step 3.5: Typecheck + lint**

Run: `bun run typecheck`
Expected: 0 new errors.

Run: `bun run lint src/tui/components/hint-bar.tsx src/tui/components/hint-bar.test.tsx`
Expected: 0 errors.

- [ ] **Step 3.6: Commit**

```bash
git add src/tui/components/hint-bar.tsx src/tui/components/hint-bar.test.tsx
git commit -m "feat(tui): add HintBar with width-aware truncation (#309)"
```

---

## Task 4: Extract panel hints to dedicated module

**Files:**
- Create: `src/tui/views/panel-hints.ts`
- Modify: `src/tui/data/hint-map.ts`

**Goal:** Move `PANEL_GENERIC` and `DAG_HINTS` from `hint-map.ts` into a dedicated `panel-hints.ts` module. `hint-map.ts` imports + assembles. No behavior change — `hint-map.test.ts` should still pass without modification.

- [ ] **Step 4.1: Create the panel-hints module**

Create `src/tui/views/panel-hints.ts`:

```ts
/**
 * Per-panel KeyAction[] constants for the running view's panel zoom
 * pages (#309). Keyed by the `panel` param of `Page` with kind="panel".
 *
 * DAG's chain is the issue #309 acceptance literal.
 */

import type { KeyAction } from "../data/hint-map.js";

const GENERIC: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Detail" },
  { key: "Esc", label: "Close" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const DAG: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Focus" },
  { key: "Space", label: "Expand" },
  { key: "R", label: "Review" },
  { key: "M", label: "Merge" },
  { key: "L", label: "Logs" },
]);

export const PANEL_HINTS = Object.freeze({
  agents: GENERIC,
  dag: DAG,
  sessions: GENERIC,
  tasks: GENERIC,
  reviews: GENERIC,
  feed: GENERIC,
}) satisfies Readonly<Record<string, readonly KeyAction[]>>;
```

- [ ] **Step 4.2: Update hint-map.ts to import**

Modify `src/tui/data/hint-map.ts`:
- Delete the local `PANEL_GENERIC` and `DAG_HINTS` constants.
- Add at top: `import { PANEL_HINTS } from "../views/panel-hints.js";`
- Replace the panel entries in the `STATIC` map:

```ts
const STATIC: Partial<Record<HintKey, readonly KeyAction[]>> = {
  "preset-select": PRESET_SELECT_HINTS,
  "goal-input": GOAL_INPUT_HINTS,
  "agent-detect": LAUNCH_PREVIEW_HINTS,
  "launch-preview": LAUNCH_PREVIEW_HINTS,
  spawning: SPAWNING_HINTS,
  running: RUNNING_VIEW_HINTS,
  complete: COMPLETE_HINTS,
  advanced: ADVANCED_HINTS,
  "panel:agents": PANEL_HINTS.agents,
  "panel:dag": PANEL_HINTS.dag,
  "panel:sessions": PANEL_HINTS.sessions,
  "panel:tasks": PANEL_HINTS.tasks,
  "panel:reviews": PANEL_HINTS.reviews,
  "panel:feed": PANEL_HINTS.feed,
};
```

- [ ] **Step 4.3: Run all hint tests**

Run: `bun test src/tui/data/hint-map.test.ts src/tui/components/hint-bar.test.tsx src/tui/hooks/use-hints.test.tsx`
Expected: all pass.

- [ ] **Step 4.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/views/panel-hints.ts src/tui/data/hint-map.ts`
Expected: 0 errors.

- [ ] **Step 4.5: Commit**

```bash
git add src/tui/views/panel-hints.ts src/tui/data/hint-map.ts
git commit -m "refactor(tui): extract PANEL_HINTS to views/panel-hints.ts (#309)"
```

---

## Task 5: Move running-view hints to view module

**Files:**
- Modify: `src/tui/screens/running-view.tsx`
- Modify: `src/tui/data/hint-map.ts`

- [ ] **Step 5.1: Append constant to running-view.tsx**

Add at the bottom of `src/tui/screens/running-view.tsx`, after the existing exports:

```ts
import type { KeyAction } from "../data/hint-map.js";

/** Hints shown when the pages stack top is `running` (#309). */
export const RUNNING_VIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: ":", label: "Goto" },
  { key: "/", label: "Filter" },
  { key: "1-5", label: "Panel" },
  { key: "Esc", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);
```

If `import type { KeyAction }` is already imported elsewhere in the file, don't duplicate it — just add the const.

- [ ] **Step 5.2: Update hint-map.ts to import**

Modify `src/tui/data/hint-map.ts`:
- Delete the local `RUNNING_VIEW_HINTS` constant.
- Add: `import { RUNNING_VIEW_HINTS } from "../screens/running-view.js";`
- The `STATIC` map entry `running: RUNNING_VIEW_HINTS` already references it by name; no change.

- [ ] **Step 5.3: Run all hint tests**

Run: `bun test src/tui/data/hint-map.test.ts src/tui/hooks/use-hints.test.tsx`
Expected: all pass.

- [ ] **Step 5.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/screens/running-view.tsx src/tui/data/hint-map.ts`
Expected: 0 errors.

- [ ] **Step 5.5: Commit**

```bash
git add src/tui/screens/running-view.tsx src/tui/data/hint-map.ts
git commit -m "refactor(tui): move RUNNING_VIEW_HINTS to running-view.tsx (#309)"
```

---

## Task 6: Move wizard screen hints to view modules

**Files:**
- Modify: `src/tui/screens/preset-select.tsx`
- Modify: `src/tui/screens/goal-input.tsx`
- Modify: `src/tui/screens/agent-detect.tsx`
- Modify: `src/tui/screens/spawn-progress.tsx`
- Modify: `src/tui/screens/complete-view.tsx`
- Modify: `src/tui/data/hint-map.ts`

**Pattern:** For each screen, append a `KeyAction[]` const at the bottom of the file and replace the inline copy in `hint-map.ts` with an import. Same shape as Task 5.

- [ ] **Step 6.1: preset-select**

Append to `src/tui/screens/preset-select.tsx`:

```ts
import type { KeyAction } from "../data/hint-map.js";

/** Hints for the preset-select screen (#309). */
export const PRESET_SELECT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Select" },
  { key: "?", label: "Details" },
  { key: "q", label: "Quit" },
]);
```

(Skip the `import type` line if `KeyAction` is already imported in that file.)

- [ ] **Step 6.2: goal-input**

Append to `src/tui/screens/goal-input.tsx`:

```ts
import type { KeyAction } from "../data/hint-map.js";

/** Hints for the goal-input screen (#309). */
export const GOAL_INPUT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Continue" },
  { key: "Esc", label: "Back" },
  { key: "Ctrl+U", label: "Clear" },
]);
```

- [ ] **Step 6.3: agent-detect (covers both `agent-detect` and `launch-preview` kinds)**

Append to `src/tui/screens/agent-detect.tsx`:

```ts
import type { KeyAction } from "../data/hint-map.js";

/** Hints for the launch-preview screen (#309). Used for both `agent-detect` and `launch-preview` PageKinds. */
export const LAUNCH_PREVIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Launch" },
  { key: "c", label: "CLI" },
  { key: "e", label: "Edit" },
  { key: "Esc", label: "Back" },
]);
```

- [ ] **Step 6.4: spawn-progress**

Append to `src/tui/screens/spawn-progress.tsx`:

```ts
import type { KeyAction } from "../data/hint-map.js";

/** Hints for the spawning screen (#309). */
export const SPAWNING_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Esc", label: "Cancel" },
]);
```

- [ ] **Step 6.5: complete-view**

Append to `src/tui/screens/complete-view.tsx`:

```ts
import type { KeyAction } from "../data/hint-map.js";

/** Hints for the complete screen (#309). */
export const COMPLETE_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "NewSession" },
  { key: "q", label: "Quit" },
]);
```

- [ ] **Step 6.6: Update hint-map.ts imports**

Modify `src/tui/data/hint-map.ts`:
- Delete inline `PRESET_SELECT_HINTS`, `GOAL_INPUT_HINTS`, `LAUNCH_PREVIEW_HINTS`, `SPAWNING_HINTS`, `COMPLETE_HINTS`.
- Add imports near the top (group alphabetically with existing):

```ts
import { LAUNCH_PREVIEW_HINTS } from "../screens/agent-detect.js";
import { COMPLETE_HINTS } from "../screens/complete-view.js";
import { GOAL_INPUT_HINTS } from "../screens/goal-input.js";
import { PRESET_SELECT_HINTS } from "../screens/preset-select.js";
import { SPAWNING_HINTS } from "../screens/spawn-progress.js";
```

- [ ] **Step 6.7: Run all hint tests**

Run: `bun test src/tui/data/hint-map.test.ts src/tui/hooks/use-hints.test.tsx`
Expected: all pass — no behavior change.

- [ ] **Step 6.8: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/screens src/tui/data/hint-map.ts`
Expected: 0 errors.

- [ ] **Step 6.9: Commit**

```bash
git add src/tui/screens/preset-select.tsx src/tui/screens/goal-input.tsx \
        src/tui/screens/agent-detect.tsx src/tui/screens/spawn-progress.tsx \
        src/tui/screens/complete-view.tsx src/tui/data/hint-map.ts
git commit -m "refactor(tui): move wizard screen hints to view modules (#309)"
```

---

## Task 7: Move advanced-mode hints

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/data/hint-map.ts`

- [ ] **Step 7.1: Append constant to app.tsx**

Append at the bottom of `src/tui/app.tsx` (after existing exports):

```ts
import type { KeyAction } from "./data/hint-map.js";

/** Hints for advanced (boardroom) mode (#309). */
export const ADVANCED_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Ctrl+B", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);
```

(Skip the `import type` line if `KeyAction` is already imported. Note the path is `./data/hint-map.js` because `app.tsx` lives one level above `screens/`.)

- [ ] **Step 7.2: Update hint-map.ts**

Modify `src/tui/data/hint-map.ts`:
- Delete inline `ADVANCED_HINTS`.
- Add: `import { ADVANCED_HINTS } from "../app.js";`

- [ ] **Step 7.3: Run hint tests**

Run: `bun test src/tui/data/hint-map.test.ts`
Expected: all pass.

- [ ] **Step 7.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/app.tsx src/tui/data/hint-map.ts`
Expected: 0 errors.

- [ ] **Step 7.5: Commit**

```bash
git add src/tui/app.tsx src/tui/data/hint-map.ts
git commit -m "refactor(tui): move ADVANCED_HINTS to app.tsx (#309)"
```

---

## Task 8: Wire HintBar into PagesRouter

**Files:**
- Modify: `src/tui/components/pages-router.tsx`
- Modify: `src/tui/components/pages-router.test.tsx`

- [ ] **Step 8.1: Read existing PagesRouter**

Read `src/tui/components/pages-router.tsx` lines 60-130 to confirm the render block layout.

- [ ] **Step 8.2: Add HintBar import + render**

Modify `src/tui/components/pages-router.tsx`:

Add imports:

```ts
import { useHints } from "../hooks/use-hints.js";
import { HintBar } from "./hint-bar.js";
```

In the component body, after `const { top, snapshot } = useScreenStack(store);` add:

```ts
const hints = useHints(store);
```

In the JSX `return`, insert `<HintBar>` between the page component and the dialog:

```tsx
return (
  <>
    <BreadcrumbBar
      stack={snapshot}
      presetName={presetName}
      sessionId={sessionId}
      width={width}
    />
    {React.createElement(Component, { page: top })}
    <HintBar hints={hints} width={width} />
    <ConfirmPopDialog visible={dialogOpen} onConfirm={handleConfirm} onCancel={handleCancel} />
  </>
);
```

- [ ] **Step 8.3: Update existing pages-router tests**

Read `src/tui/components/pages-router.test.tsx` to see how stub component map is built. The router now renders one extra `<HintBar>`; existing assertions that grep the JSON tree for component-stub text will still pass.

Add a new test case at the end of the file (before the closing `});` of the last describe):

```tsx
test("HintBar reflects current top page (#309 wiring)", async () => {
  const store = new PagesStore();
  store.push({ kind: "running" });

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      (
        <PagesRouter store={store} components={makeStubs()} width={120} />
      ) as React.ReactElement,
    );
  });

  // Running-view hint chain renders.
  expect(JSON.stringify(renderer.toJSON())).toContain("[Goto]");
  expect(JSON.stringify(renderer.toJSON())).toContain("[Filter]");

  // Push panel:dag → DAG hints appear in next render cycle.
  await act(async () => {
    store.push({ kind: "panel", params: { panel: "dag" } });
  });
  const dagFlat = JSON.stringify(renderer.toJSON());
  expect(dagFlat).toContain("[Enter]");
  expect(dagFlat).toContain("Focus");
  expect(dagFlat).toContain("[Space]");
  expect(dagFlat).toContain("Expand");
  expect(dagFlat).toContain("[R]");
  expect(dagFlat).toContain("Review");
  expect(dagFlat).toContain("[M]");
  expect(dagFlat).toContain("Merge");
  expect(dagFlat).toContain("[L]");
  expect(dagFlat).toContain("Logs");

  // Pop → running hints again.
  await act(async () => {
    store.pop();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("[Goto]");

  renderer.unmount();
});
```

If `makeStubs` and `PagesStore` aren't already imported in the test file, leave them as-is — they should be present from prior #303 tests. Verify by inspection.

- [ ] **Step 8.4: Run router tests**

Run: `bun test src/tui/components/pages-router.test.tsx`
Expected: existing tests still pass, plus 1 new test passes.

- [ ] **Step 8.5: Run full TUI tests**

Run: `bun test src/tui/`
Expected: no regressions (≥ 1230 tests pass).

- [ ] **Step 8.6: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/components/pages-router.tsx src/tui/components/pages-router.test.tsx`
Expected: 0 errors.

- [ ] **Step 8.7: Commit**

```bash
git add src/tui/components/pages-router.tsx src/tui/components/pages-router.test.tsx
git commit -m "feat(tui): PagesRouter renders HintBar driven by useHints (#309)"
```

---

## Task 9: Acceptance test

**Files:**
- Create: `tests/tui/hint-bar-acceptance.test.tsx`

- [ ] **Step 9.1: Write the acceptance test**

Create `tests/tui/hint-bar-acceptance.test.tsx`:

```tsx
/**
 * Acceptance test for issue #309 — DAG view shows the literal hint chain
 * documented in the issue acceptance criteria.
 *
 * Uses react-test-renderer + bun:test per codebase convention. Mocks
 * @opentui/react's useKeyboard so PagesRouter mounts cleanly without
 * a real terminal.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import type React from "react";

beforeAll(() => {
  mock.module("@opentui/react", () => ({
    useKeyboard: (_handler: unknown): void => {
      // noop for test
    },
    useRenderer: () => ({}),
    useTerminalDimensions: () => ({ width: 120, height: 40 }),
  }));
});

const TestRenderer = (await import("react-test-renderer")).default;
const { act } = await import("react-test-renderer");
const { PagesStore } = await import("../../src/tui/data/pages-store.js");
const { PagesRouter, type PagesRouterComponentMap } = await import(
  "../../src/tui/components/pages-router.js"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeStubs(): PagesRouterComponentMap {
  const stub = (label: string) =>
    function Stub() {
      return <text>{label}</text>;
    };
  return {
    "preset-select": stub("preset"),
    "goal-input": stub("goal"),
    "agent-detect": stub("detect"),
    "launch-preview": stub("preview"),
    spawning: stub("spawning"),
    running: stub("running"),
    complete: stub("complete"),
    advanced: stub("advanced"),
    panel: stub("panel"),
    "entity-detail": stub("detail"),
  };
}

describe("issue #309 acceptance", () => {
  test("DAG view shows [Enter]Focus [Space]Expand [R]Review [M]Merge [L]Logs", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <PagesRouter store={store} components={makeStubs()} width={120} />
        ) as React.ReactElement,
      );
    });

    await act(async () => {
      store.push({ kind: "panel", params: { panel: "dag" } });
    });

    const flat = JSON.stringify(renderer.toJSON());
    // Each [key]label pair must appear in order.
    expect(flat).toMatch(/\[Enter\][\s\S]*Focus[\s\S]*\[Space\][\s\S]*Expand[\s\S]*\[R\][\s\S]*Review[\s\S]*\[M\][\s\S]*Merge[\s\S]*\[L\][\s\S]*Logs/);

    renderer.unmount();
  });

  test("switching from running to panel:dag updates hint bar in one render cycle", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    const trees: string[] = [];
    function Recorder({ children }: { children: React.ReactNode }): React.ReactElement {
      // Capture render output by re-stringifying the renderer's JSON each render
      // via parent-controlled side effect. We do this by sampling after each act.
      return <>{children}</>;
    }

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Recorder>
            <PagesRouter store={store} components={makeStubs()} width={120} />
          </Recorder>
        ) as React.ReactElement,
      );
    });
    trees.push(JSON.stringify(renderer.toJSON()));

    await act(async () => {
      store.push({ kind: "panel", params: { panel: "dag" } });
    });
    trees.push(JSON.stringify(renderer.toJSON()));

    // Before push: contains running hints, NOT DAG hints.
    expect(trees[0]).toContain("[Goto]");
    expect(trees[0]).not.toContain("Focus");
    // After single push (one render cycle): contains DAG hints.
    expect(trees[1]).toContain("Focus");
    expect(trees[1]).toContain("Expand");

    renderer.unmount();
  });

  test("no global hint registry: no source file imports a useRegisterHints or hintRegistry symbol", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const SRC = path.join(import.meta.dir, "..", "..", "src", "tui");

    async function* walk(dir: string): AsyncGenerator<string> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walk(p);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
        ) {
          yield p;
        }
      }
    }

    const FORBIDDEN = [/useRegisterHints/, /hintRegistry/];
    const offenders: string[] = [];
    for await (const file of walk(SRC)) {
      const text = await fs.readFile(file, "utf-8");
      if (FORBIDDEN.some((rx) => rx.test(text))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 9.2: Run the acceptance test**

Run: `bun test tests/tui/hint-bar-acceptance.test.tsx`
Expected: 3 passed.

- [ ] **Step 9.3: Run full test suite for regressions**

Run: `bun test`
Expected: no new failures.

- [ ] **Step 9.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint tests/tui/hint-bar-acceptance.test.tsx`
Expected: 0 errors.

- [ ] **Step 9.5: Commit**

```bash
git add tests/tui/hint-bar-acceptance.test.tsx
git commit -m "test(tui): add #309 acceptance test for hint bar"
```

---

## Acceptance verification (issue #309)

- [ ] Switching views updates hint bar within one render cycle — Task 8 (`pages-router.test.tsx` new test) + Task 9 (`hint-bar-acceptance.test.tsx` second test).
- [ ] No global hint registry — STATIC map is module-level const; per-view consts imported by name. Verified by Task 9 grep test.
- [ ] DAG view shows `[Enter]Focus [Space]Expand [R]Review [M]Merge [L]Logs` — Tasks 1, 4, 8, 9 all exercise this exact string.

## Out of scope (per spec)

- `<StatusBar>` migration to `useHints` — follow-up issue.
- Conditional/dynamic hints (`when?` predicate) — rejected in brainstorming.
- Hint label i18n.
- Hint conflict detection across PageKinds.
