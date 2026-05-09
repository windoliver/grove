# TUI Pages Navigation Stack — Design

**Date:** 2026-05-09
**Issue:** [#303](https://github.com/windoliver/grove/issues/303) (Epic [#284](https://github.com/windoliver/grove/issues/284))
**Status:** Design ready for implementation
**Reference:** k9s `internal/ui/pages.go`

## Problem

The TUI navigation model is a fixed forward-only state machine in `screen-manager.tsx` (preset-select → goal-input → launch-preview → running → complete). Inside `running-view.tsx`, the goto aliases `:a` `:s` `:d` `:t` `:r` mutate `expandedPanel` directly with no history — `:a` then `:s` then `esc` collapses the panel instead of returning to agents.

The roadmap calls for a k9s-style pages stack with push/pop/top + listeners, breadcrumb derivation, and esc-pop with confirm-on-dirty so users can drill into views, navigate freely, and back out predictably.

## Goals

- Replace the wizard state machine with a uniform navigation stack covering wizard screens, panel zooms, and future entity-detail views.
- Provide `push` / `pop` / `replace` / `top` with three event channels (`stackPushed`, `stackPopped`, `stackTop`).
- Derive breadcrumbs from stack depth.
- Esc pops; pages can register an `isDirty` check that triggers a confirm dialog before pop.
- Acceptance from issue: `:a` → `:s` → esc returns to agents.

## Non-goals

- Hint-bar refresh on stack change (deferred to #309).
- Live DAG view (#311).
- `confirmAndMutate` / 428 enforcement (#304).
- Persistent stack across process restarts.

## Architecture

A pure data class `PagesStore` owns the stack. React subscribes via a thin hook. `PagesRouter` consumes the top page and renders the matching screen component.

### Module layout

| File | Purpose |
| --- | --- |
| `src/tui/data/pages-store.ts` | `PagesStore` class — push/pop/replace/top, listeners, dirty-check registry |
| `src/tui/data/pages-store.test.ts` | Unit tests for the store |
| `src/tui/hooks/use-pages-store.ts` | React hook (`useSyncExternalStore`-style) |
| `src/tui/hooks/use-pages-store.test.ts` | Hook tests |
| `src/tui/components/pages-router.tsx` | Maps `top.kind` → component, owns esc handler + confirm dialog |
| `src/tui/components/pages-router.test.tsx` | Router tests |
| `src/tui/components/confirm-pop-dialog.tsx` | Modal overlay shown when dirty page tries to pop |

### Modified files

| File | Change |
| --- | --- |
| `src/tui/screens/screen-manager.tsx` | Becomes a shim: builds initial stack from `initialState`/`startOnRunning`/`presets`, delegates to `<PagesRouter>`. Wizard transitions rewritten to use `pages.push` / `pages.replace`. `ScreenState` interface preserved as durable data slot. |
| `src/tui/components/breadcrumb-bar.tsx` | Adds `stack: readonly Page[]` prop. Renders depth-1 chevron chain. Old `screen` prop removed. |
| `src/tui/screens/agent-detect.tsx`, `goal-input.tsx`, `spawn-progress.tsx` | Stop rendering their own `<BreadcrumbBar>`. The router renders one breadcrumb at the top of the screen, sourced from the stack. Removes 3 redundant `screen=...` call sites. |
| `src/tui/screens/running-view.tsx` | `gotoDispatch` calls `pages.push({ kind: "panel", params: { panel: "..." } })` instead of mutating `expandedPanel`. `expandedPanel` becomes a selector over top page when `top.kind === "panel"`. |
| `src/tui/screens/goal-input.tsx` | Registers dirty-check returning `text.trim().length > 0`. |
| `src/tui/screens/running-view.tsx` (prompt-mode) | Registers dirty-check while prompt-mode active and prompt text non-empty. |

## Types and API

```ts
export type PageKind =
  | "preset-select" | "goal-input" | "agent-detect"
  | "launch-preview" | "spawning" | "running"
  | "complete" | "advanced"
  | "panel"          // zoom inside running (params.panel = "agents"|"sessions"|"dag"|"tasks"|"reviews")
  | "entity-detail"; // future drill-in target

export interface Page {
  readonly kind: PageKind;
  readonly params?: Readonly<Record<string, string>>;
}

export type StackEvent =
  | { type: "pushed"; page: Page; depth: number }
  | { type: "popped"; page: Page; depth: number }
  | { type: "top";    page: Page; depth: number };

export type DirtyCheck = () => boolean;

export class PagesStore {
  push(page: Page): void;
  pop(): Page | undefined;
  replace(page: Page): void;
  top(): Page | undefined;
  depth(): number;
  snapshot(): readonly Page[];
  subscribe(type: StackEvent["type"], fn: (e: StackEvent) => void): () => void;
  registerDirtyCheck(kind: PageKind, fn: DirtyCheck): () => void;
  hasDirtyTop(): boolean;
}
```

### Invariants

- Stack always has ≥1 entry. `pop()` on depth=1 is a no-op and returns `undefined`.
- Duplicate-top push (same kind + same params) is a no-op — guards rapid `:a:a:a`.
- `replace()` swaps top in place (no event for `popped`; emits `pushed` + `top`).
- Page state lives outside the stack: in central store, refs, or `ScreenState`. The stack stores only routes (kind + params).
- Listener exceptions are caught and logged via `debugLog`, never kill the store (mirrors `acp-session-store.ts:284`).
- Dirty-check exceptions are treated as dirty (safe default).

## Data flow

### Goto from running view (`:a` then `:s`)

1. User types `:a`; existing prompt resolves alias; `gotoDispatch.agents` called.
2. `gotoDispatch.agents` → `pages.push({ kind: "panel", params: { panel: "agents" } })`.
3. Store appends to `stack`, fires `pushed` then `top`.
4. `<PagesRouter>` re-renders, mounts `<PanelZoomView panel="agents">`. `<BreadcrumbBar>` re-renders.
5. Subsequent `:s` pushes `panel:sessions`. Stack: `[running, panel:agents, panel:sessions]`.
6. Esc → `hasDirtyTop()` is false → `pop()` → top is `panel:agents` → user back on agents (acceptance criterion).

### Wizard navigation

- Wizard forward steps use `push`. Stack inside wizard: `[preset-select, goal-input, launch-preview]`. Esc pops back through prior steps.
- Successful spawn → transition to running calls `pages.replace({ kind: "running" })`, collapsing all wizard frames so post-launch esc never re-enters the wizard.

### Esc handling (router)

```
onKey(esc):
  if confirm-dialog open:           dialog handles key
  else if hasDirtyTop():            open confirm dialog
  else if depth() === 1:            existing quit-confirm flow
  else:                             pages.pop()
```

### Replace vs push

- `push` — drilling deeper (panel zoom, entity-detail, wizard forward).
- `replace` — collapsing one phase into another (wizard → running, running → complete) so esc doesn't backtrack into a defunct phase.

## Component map (router)

```ts
const COMPONENTS: Record<PageKind, React.FC<{page: Page}>> = {
  "preset-select":  PresetSelect,
  "goal-input":     GoalInput,
  "agent-detect":   AgentDetect,
  "launch-preview": AgentDetect,   // alias of above per current code
  "spawning":       SpawnProgress,
  "running":        RunningView,
  "complete":       CompleteView,
  "advanced":       App,
  "panel":          PanelZoomView,    // thin wrapper around RunningView with expanded panel
  "entity-detail":  EntityDetailView, // stub; populated by later Epic C work
};
```

## Error handling

| Condition | Behavior |
| --- | --- |
| `pop()` at depth=1 | No-op, returns `undefined`; router routes to quit-confirm. |
| `push` of identical top | No-op. |
| Listener throws | Caught, logged, store continues. |
| Dirty-check throws | Treated as dirty; confirm dialog shown. |
| Confirm dialog open + key input | Routed to dialog only (modal). |

## Testing

**`pages-store.test.ts`:**
- push/pop/replace invariants: depth, top, snapshot immutability.
- `pop()` at depth=1 returns undefined, stack unchanged.
- Duplicate-top push is no-op.
- Listeners fire in order with correct payload + depth.
- Listener throw caught, store keeps working.
- Unsubscribe removes listener.
- `registerDirtyCheck` + `hasDirtyTop` lookup by current top kind.
- Dirty-check throws → `hasDirtyTop` returns true.

**`use-pages-store.test.ts`:**
- Subscribes on mount, unsubscribes on unmount.
- Top change triggers re-render.
- Multiple subscribers on same store see same snapshot.

**`pages-router.test.tsx`:**
- `top.kind` change swaps mounted component.
- Esc on non-dirty top calls `pop()`.
- Esc on dirty top renders confirm dialog; cancel keeps stack; confirm pops.
- Esc at depth=1 routes to quit-confirm (existing path).

**Integration (extend existing tests):**
- `:a` → `:s` → esc lands back on agents (acceptance criterion verbatim).
- Breadcrumb depth chain renders correctly at each width breakpoint.
- Wizard forward push: preset-select → goal-input typing → esc with dirty → confirm shown → cancel keeps text.
- Post-launch `replace` collapses wizard frames.

**Performance:** push/pop O(1); listener fanout O(subscribers). No regression in `entity-view.perf.test.tsx`.

## Acceptance (from issue #303)

- [x] `esc` pops to previous view — covered by router esc handler + integration test.
- [x] Breadcrumbs reflect current depth — `BreadcrumbBar` consumes stack snapshot.
- [x] `:a` → `:s` → `esc` returns to agents — covered by integration test.

## Out of scope

- `<HintBar>` auto-refresh on stack-top change — handled in #309.
- `<EntityDetailView>` real implementation — handled in #311 (DAG view) and future Epic C work.
- `confirmAndMutate` server-side 428 enforcement — handled in #304.
- Persistent stack across restarts — not requested.
