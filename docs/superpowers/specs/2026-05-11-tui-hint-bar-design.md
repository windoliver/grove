# TUI Context-Aware Hint Bar — Design

**Date:** 2026-05-11
**Issue:** [#309](https://github.com/windoliver/grove/issues/309) (Epic [#284](https://github.com/windoliver/grove/issues/284))
**Status:** Design ready for implementation
**Reference:** k9s `internal/ui/menu.go`, `internal/ui/action.go`

## Problem

The TUI's bottom keybinding hints live in `src/tui/components/status-bar.tsx`'s `panelHints()` function — a hardcoded switch over `Panel` enum values that knows nothing about the page navigation stack landed in #303. After `:a` pushes `panel:agents`, the hint chain doesn't change to match the new view. Issue #309 calls for a context-aware hint bar driven by the topmost view of the pages stack, with hints declared statically alongside each view (no global registry).

## Goals

- `useHints(store)` React hook returns `KeyAction[]` for the topmost page of a `PagesStore`.
- Each view declares hints as a module-level `const` exported alongside the view's component.
- A central `hint-map.ts` module assembles the per-view constants into a `PageKind` lookup.
- `<HintBar>` renders the chain, truncates by width, re-renders on stack change.
- `<PagesRouter>` wires `useHints` → `<HintBar>` automatically — no per-screen plumbing.

## Non-goals

- Migrating the existing `<StatusBar>`'s `panelHints()` to `useHints`. Tracked as a follow-up after #309.
- Conditional / dynamic hints (e.g. `[M]Merge` hidden when no active claim). Out of scope; `when?` predicate rejected in brainstorming.
- i18n of hint labels.
- Discovering hint conflicts (two pages both claiming `[R]`). Not addressed.

## Architecture

A pure data module `hint-map.ts` owns the lookup. Per-view modules export their `KeyAction[]` const next to the view component (no separate "hints" folder). A thin React hook `useHints` subscribes to `PagesStore` via `useSyncExternalStore`. `<HintBar>` is presentational: prop-driven, width-aware truncation.

### Type contract

```ts
export interface KeyAction {
  readonly key: string;    // display label: "Enter", "Esc", "Ctrl+P", "1-5"
  readonly label: string;  // verb: "Focus", "Quit", "Spawn"
}

export type HintKey = PageKind | `panel:${string}` | `entity-detail:${string}`;
```

`KeyAction` is intentionally minimal (no `handler?`, no `when?`). Issue scope is hint display only — handlers stay in each view's existing keyboard router. Brainstorming Q3 picked this shape.

### Module layout

| File | Purpose |
| --- | --- |
| `src/tui/data/hint-map.ts` | `KeyAction` type, `hintsForPage(page)`, central STATIC map |
| `src/tui/data/hint-map.test.ts` | Lookup tests, acceptance literal, exhaustiveness |
| `src/tui/hooks/use-hints.ts` | React subscription to PagesStore.top → `KeyAction[]` |
| `src/tui/hooks/use-hints.test.tsx` | Hook re-renders on stack mutation |
| `src/tui/components/hint-bar.tsx` | Presentational; renders KeyAction chain with width-aware truncation |
| `src/tui/components/hint-bar.test.tsx` | Render + truncation tests |
| `src/tui/views/panel-hints.ts` | Per-panel `KeyAction[]` constants (agents/dag/sessions/tasks/reviews/feed) |
| `src/tui/components/pages-router.tsx` *(modify)* | Render `<HintBar hints={useHints(store)} width={width} />` at bottom |
| `src/tui/screens/preset-select.tsx` *(modify)* | Export `PRESET_SELECT_HINTS` |
| `src/tui/screens/goal-input.tsx` *(modify)* | Export `GOAL_INPUT_HINTS` |
| `src/tui/screens/agent-detect.tsx` *(modify)* | Export `LAUNCH_PREVIEW_HINTS` |
| `src/tui/screens/spawn-progress.tsx` *(modify)* | Export `SPAWNING_HINTS` |
| `src/tui/screens/running-view.tsx` *(modify)* | Export `RUNNING_VIEW_HINTS` |
| `src/tui/screens/complete-view.tsx` *(modify)* | Export `COMPLETE_HINTS` |
| `src/tui/app.tsx` *(modify)* | Export `ADVANCED_HINTS` (advanced/boardroom mode) |

### Hint content

Per-page hint constants — exact strings:

```ts
// running-view.tsx
export const RUNNING_VIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: ":", label: "Goto" },
  { key: "/", label: "Filter" },
  { key: "1-5", label: "Panel" },
  { key: "Esc", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

// views/panel-hints.ts — DAG matches issue #309 acceptance verbatim
export const PANEL_HINTS = {
  agents: Object.freeze([
    { key: "Enter", label: "Detail" }, { key: "Esc", label: "Close" },
    { key: "?", label: "Help" }, { key: "q", label: "Quit" },
  ]),
  dag: Object.freeze([
    { key: "Enter", label: "Focus" }, { key: "Space", label: "Expand" },
    { key: "R", label: "Review" }, { key: "M", label: "Merge" },
    { key: "L", label: "Logs" },
  ]),
  sessions: Object.freeze([
    { key: "Enter", label: "Detail" }, { key: "Esc", label: "Close" },
    { key: "?", label: "Help" }, { key: "q", label: "Quit" },
  ]),
  tasks: Object.freeze([
    { key: "Enter", label: "Detail" }, { key: "Esc", label: "Close" },
    { key: "?", label: "Help" }, { key: "q", label: "Quit" },
  ]),
  reviews: Object.freeze([
    { key: "Enter", label: "Detail" }, { key: "Esc", label: "Close" },
    { key: "?", label: "Help" }, { key: "q", label: "Quit" },
  ]),
  feed: Object.freeze([
    { key: "Enter", label: "Detail" }, { key: "Esc", label: "Close" },
    { key: "?", label: "Help" }, { key: "q", label: "Quit" },
  ]),
} as const;
```

Wizard screens get analogous constants (preset-select: `Enter:select ?:details q:quit`; goal-input: `Enter:continue Esc:back Ctrl+U:clear`; etc.) matching what those screens already render in their own UI.

### Central lookup

```ts
// hint-map.ts
const STATIC: Partial<Record<HintKey, readonly KeyAction[]>> = {
  "preset-select":  PRESET_SELECT_HINTS,
  "goal-input":     GOAL_INPUT_HINTS,
  "agent-detect":   LAUNCH_PREVIEW_HINTS,
  "launch-preview": LAUNCH_PREVIEW_HINTS,
  spawning:         SPAWNING_HINTS,
  running:          RUNNING_VIEW_HINTS,
  complete:         COMPLETE_HINTS,
  advanced:         ADVANCED_HINTS,
  "panel:agents":   PANEL_HINTS.agents,
  "panel:dag":      PANEL_HINTS.dag,
  "panel:sessions": PANEL_HINTS.sessions,
  "panel:tasks":    PANEL_HINTS.tasks,
  "panel:reviews":  PANEL_HINTS.reviews,
  "panel:feed":     PANEL_HINTS.feed,
};

const DEFAULT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

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

### Hook

```ts
// use-hints.ts
import { useSyncExternalStore } from "react";
import type { PagesStore } from "../data/pages-store.js";
import { hintsForPage, type KeyAction } from "../data/hint-map.js";

export function useHints(store: PagesStore): readonly KeyAction[] {
  const snapshot = useSyncExternalStore(
    (cb) => store.subscribe("top", cb),
    () => store.snapshot(),
  );
  const top = snapshot[snapshot.length - 1];
  return top ? hintsForPage(top) : [];
}
```

### Component

```tsx
// hint-bar.tsx
export interface HintBarProps {
  readonly hints: readonly KeyAction[];
  readonly width: number;
}

export const HintBar = React.memo(function HintBar({ hints, width }: HintBarProps) {
  if (width < 40 || hints.length === 0) return null;
  const trimmed = truncateForWidth(hints, width);
  return (
    <box flexDirection="row" paddingX={1}>
      {trimmed.actions.flatMap((a, i) => [
        <text key={`k${i}`} color={theme.focus}>{`[${a.key}]`}</text>,
        <text key={`l${i}`} color={theme.text}>{a.label}</text>,
        i < trimmed.actions.length - 1 ? (
          <text key={`s${i}`} color={theme.secondary}>{"  "}</text>
        ) : null,
      ])}
      {trimmed.truncated ? <text color={theme.secondary}> …</text> : null}
    </box>
  );
});

function truncateForWidth(
  hints: readonly KeyAction[],
  width: number,
): { actions: readonly KeyAction[]; truncated: boolean } {
  // Greedy: include actions from start until cumulative `[key]label` + 2-space
  // separators would exceed `width - 4` (leave room for "…" suffix + paddingX).
  // Never split a single action.
}
```

### Router integration

```tsx
// pages-router.tsx — add to JSX after <Component>:
import { HintBar } from "./hint-bar.js";
import { useHints } from "../hooks/use-hints.js";

const hints = useHints(store);

return (
  <>
    <BreadcrumbBar stack={snapshot} presetName={presetName} sessionId={sessionId} width={width} />
    {React.createElement(Component, { page: top })}
    <HintBar hints={hints} width={width} />
    <ConfirmPopDialog visible={dialogOpen} onConfirm={handleConfirm} onCancel={handleCancel} />
  </>
);
```

`<StatusBar>` is untouched. Its `panelHints()` continues to render inside running-view's existing render path. A follow-up will migrate StatusBar's hint chain to `useHints`; for now they coexist (StatusBar's hints reflect the focused panel within running-view; HintBar reflects the pages-stack top).

## Data flow

### Acceptance flow: switching views updates hint bar within one render cycle

1. User types `:a` in running view; existing `gotoDispatch.agents` calls `pagesStore.push({kind:"panel", params:{panel:"agents"}})`.
2. `PagesStore` mutates stack, fires `pushed` then `top` events. Snapshot cache invalidates.
3. `useHints(store)` and `useScreenStack(store)` both subscribe to the `top` channel; each gets the new snapshot reference.
4. React schedules one re-render (events batch). `useHints` re-evaluates `hintsForPage(top)` → `PANEL_HINTS.agents`. `<PagesRouter>` swaps the page component.
5. `<HintBar>` re-renders with the new `KeyAction[]`. Same render cycle as page swap.

### Pop flow

`pages.pop()` from `panel:agents` → new top is `running` → next render shows `RUNNING_VIEW_HINTS`. Stable: no state retained between pushes.

## Error handling

| Condition | Behavior |
| --- | --- |
| `top === undefined` (empty stack) | `useHints` returns `[]`; `<HintBar>` returns `null`. |
| `top.kind === "panel"` + missing/unknown `params.panel` | Falls back to `DEFAULT_HINTS` (`[?]Help [q]Quit`). |
| New `PageKind` added without STATIC entry | Falls back to `DEFAULT_HINTS`. No crash. |
| `STATIC` entry exists but is empty `[]` | `<HintBar>` returns `null` (zero-height row would shift layout). |
| `width < 40` | `<HintBar>` returns `null`. Don't compete with breadcrumb for vertical space on narrow terminals. |

## Performance

- `hintsForPage` is O(1) map lookup. STATIC map is frozen module-singleton, allocated once at import.
- `KeyAction[]` references are stable across renders for the same page kind (`Object.freeze` per array). React reconciles `<HintBar>` children efficiently.
- `truncateForWidth` runs per render but is O(hints.length); typical chain is 5-7 actions.
- `useSyncExternalStore` snapshot identity stable across non-mutating reads (PagesStore caches snapshots; Task 1 / #303 contract).

## Testing

**`hint-map.test.ts`:**
- `hintsForPage({kind:"running"})` deep-equals `RUNNING_VIEW_HINTS`.
- `hintsForPage({kind:"panel", params:{panel:"dag"}})` matches issue #309 acceptance literal (Enter/Focus, Space/Expand, R/Review, M/Merge, L/Logs).
- All 6 panel sub-kinds resolve to non-empty `KeyAction[]`.
- Unknown panel → `DEFAULT_HINTS`.
- Missing `params` on `panel` kind → `DEFAULT_HINTS`.
- Every `PageKind` literal has either a STATIC entry or `DEFAULT_HINTS` fallback (exhaustive check via `for (const kind of ALL_PAGE_KINDS)`).
- Returned arrays are frozen (`Object.isFrozen`).

**`use-hints.test.tsx`** (react-test-renderer + bun:test):
- Pre-populated store: hook returns matching hints on initial render.
- After `store.push(panel:dag)`: probe captures new hints array on next render.
- After `store.pop()`: reverts.
- Empty store: returns `[]`.
- Post-unmount: store mutations do not trigger renders.

**`hint-bar.test.tsx`:**
- Renders all KeyAction labels at width=120.
- Truncates at width=80: includes ellipsis, fewer actions than full chain.
- Returns `null` at width=30.
- Empty `hints` prop: returns `null`.
- Theme colors verified via `theme.focus` / `theme.text` strings in JSON snapshot.

**Integration — extend `pages-router.test.tsx` OR new `pages-router-hint-bar.test.tsx`:**
- Mount router with stub component map. Initial top=`running` → tree contains `[Goto]`, `[Filter]` labels.
- `store.push(panel:dag)` → tree now contains `[Enter]Focus`, `[Space]Expand`, `[R]Review`, `[M]Merge`, `[L]Logs`. Verifies one-render-cycle update (acceptance #1).
- Pop → reverts to running hints.

**Acceptance — `tests/tui/hint-bar-acceptance.test.tsx`:**
- Stack `[running]` → push `panel:dag` → rendered tree contains the literal acceptance hint chain verbatim.
- Grep invariant: no source file under `src/tui/` imports a `useRegisterHints`/`hintRegistry` symbol (statically verifies "no global hint registry").

**Performance — `hint-map.perf.test.ts` (lightweight):**
- 10k `hintsForPage(...)` calls complete under 10ms.

## Acceptance (from issue #309)

- [x] Switching views updates hint bar within one render cycle — covered by integration test using a real `PagesStore` + `<PagesRouter>` mount.
- [x] No global hint registry — STATIC map is a module-level const; per-view constants are imported by name. Grep test enforces absence of a registry pattern.
- [x] DAG view shows `[Enter]Focus [Space]Expand [R]Review [M]Merge [L]Logs` — covered by `hint-map.test.ts` acceptance literal test and `hint-bar-acceptance.test.tsx` end-to-end.

## Out of scope

- StatusBar migration to useHints. Follow-up issue.
- Conditional/dynamic hints (`when?` predicate). Rejected in brainstorming.
- Hint label i18n.
- Hint conflict detection across PageKinds.
- Cross-OS modifier-key rendering (Ctrl vs Cmd) — labels are stored verbatim; existing `theme` handles display.
