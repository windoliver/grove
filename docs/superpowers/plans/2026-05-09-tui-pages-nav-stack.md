# TUI Pages Navigation Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed wizard state machine in `src/tui/screens/screen-manager.tsx` with a k9s-style pages navigation stack that supports `push` / `pop` / `replace`, fires push/popped/top events, derives breadcrumbs from depth, and pops with a confirm dialog when the top page is dirty.

**Architecture:** Pure `PagesStore` class in `src/tui/data/`, thin `useScreenStack` React hook over `useSyncExternalStore`, `<PagesRouter>` component that maps `top.kind` → screen component and owns the esc handler + confirm dialog. `screen-manager.tsx` becomes a backward-compat shim. Inside running-view, goto aliases push `panel` pages instead of mutating `expandedPanel` directly; an effect syncs `expandedPanel` from the top page.

**Tech Stack:** TypeScript (strict), Bun test runner, React (Ink/OpenTUI), Biome lint.

**Spec:** `docs/superpowers/specs/2026-05-09-tui-pages-nav-stack-design.md`

---

## Codebase Conventions (read before any test or component work)

This codebase **does not use `@testing-library/react`**. The plan code samples below show conceptual test shape; **translate them into the project's actual conventions** before committing:

1. **React tests use `react-test-renderer` + `bun:test`.**
   Reference: `src/tui/components/entity-view.test.tsx`. Pattern:

   ```tsx
   import TestRenderer, { act } from "react-test-renderer";
   (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

   let renderer!: TestRenderer.ReactTestRenderer;
   await act(async () => {
     renderer = TestRenderer.create(<MyComponent ... /> as React.ReactElement);
   });

   const flat = JSON.stringify(renderer.toJSON());
   expect(flat).toContain("expected text");
   renderer.unmount();
   ```

   Inspect rendered text with `JSON.stringify(renderer.toJSON())`. Drive component state changes via `act(async () => { /* mutate store, etc. */ })`.

2. **Keyboard handling uses `useKeyboard` from `@opentui/react`.**
   Reference: `src/tui/screens/running-view.tsx:889+`. The PagesRouter MUST register its esc handler via `useKeyboard` — **not** an `onKeyDown` JSX prop (OpenTUI does not surface DOM events).

   Pattern:
   ```tsx
   import { useKeyboard } from "@opentui/react";
   useKeyboard(useCallback((key) => {
     if (key.name === "escape") handleEscape();
     else if (dialogOpen && key.name === "y") confirmPop();
     else if (dialogOpen && key.name === "n") cancelDialog();
   }, [/* deps */]));
   ```

   To test keyboard logic, **factor the handler into a pure function** (e.g., `routerKeyReducer(state, key) → action`) and unit-test that function directly. The component test then only verifies that the handler is registered with `useKeyboard` and that the produced output (rendered JSON) reflects the resulting state.

3. **Existing render/imperative-state pattern for screens** — see `screen-manager.test.ts` for `act`-driven state advance, `running-view.c2.test.tsx` for keyboard injection via store/state mutation.

When the implementation steps below show `fireEvent.keyDown(...)` or `<element onKeyDown={...} />`, treat that as **pseudocode for the intent**, not literal code to write. Implement the behavior using `useKeyboard` + a pure key-reducer, and test the reducer directly.

---

## File Structure

| File | Purpose |
| --- | --- |
| `src/tui/data/pages-store.ts` | `PagesStore` class — push/pop/replace/top, listeners, dirty-check registry |
| `src/tui/data/pages-store.test.ts` | Unit tests for the store |
| `src/tui/hooks/use-screen-stack.ts` | React hook: subscribes to a `PagesStore` via `useSyncExternalStore` |
| `src/tui/hooks/use-screen-stack.test.tsx` | Hook tests with @testing-library/react |
| `src/tui/components/confirm-pop-dialog.tsx` | Modal overlay shown when a dirty page tries to pop |
| `src/tui/components/confirm-pop-dialog.test.tsx` | Dialog test |
| `src/tui/components/pages-router.tsx` | Maps `top.kind` → component, owns esc + dialog |
| `src/tui/components/pages-router.test.tsx` | Router tests |
| `src/tui/components/breadcrumb-bar.tsx` *(modify)* | Add `stack` prop; render depth chain |
| `src/tui/components/breadcrumb-bar.test.tsx` *(create)* | Tests for new prop + width breakpoints |
| `src/tui/screens/screen-manager.tsx` *(modify)* | Becomes shim: build initial stack from props, delegate to `<PagesRouter>` |
| `src/tui/screens/goal-input.tsx` *(modify)* | Stop rendering own breadcrumb; register dirty-check |
| `src/tui/screens/agent-detect.tsx` *(modify)* | Stop rendering own breadcrumb |
| `src/tui/screens/spawn-progress.tsx` *(modify)* | Stop rendering own breadcrumb |
| `src/tui/screens/running-view.tsx` *(modify)* | `gotoDispatch` pushes panel pages; effect syncs `expandedPanel`; prompt-mode dirty-check |
| `tests/tui/pages-nav-acceptance.test.tsx` *(create)* | End-to-end: `:a` → `:s` → esc returns to agents |

---

## Task 1: PagesStore data class

**Files:**
- Create: `src/tui/data/pages-store.ts`
- Create: `src/tui/data/pages-store.test.ts`

**Reference patterns:**
- Listener-error swallowing pattern: see `src/tui/data/acp-session-store.ts:280-290` (`for…catch` log + continue)
- Pure-data store (no React) shape: see `src/tui/data/aliases.ts`

- [ ] **Step 1.1: Write the failing test scaffold**

Create `src/tui/data/pages-store.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { PagesStore, type Page, type StackEvent } from "./pages-store.js";

describe("PagesStore basics", () => {
  test("starts empty; depth=0; top=undefined", () => {
    const s = new PagesStore();
    expect(s.depth()).toBe(0);
    expect(s.top()).toBeUndefined();
    expect(s.snapshot()).toEqual([]);
  });

  test("push appends page and bumps depth", () => {
    const s = new PagesStore();
    s.push({ kind: "preset-select" });
    expect(s.depth()).toBe(1);
    expect(s.top()).toEqual({ kind: "preset-select" });
  });

  test("snapshot returns a frozen, copy-stable array", () => {
    const s = new PagesStore();
    s.push({ kind: "running" });
    const snap1 = s.snapshot();
    s.push({ kind: "panel", params: { panel: "agents" } });
    expect(snap1).toEqual([{ kind: "running" }]); // unchanged
    expect(Object.isFrozen(snap1)).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run test, watch it fail**

Run: `bun test src/tui/data/pages-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement minimal store skeleton**

Create `src/tui/data/pages-store.ts`:

```ts
/**
 * PagesStore — k9s-style navigation stack (issue #303).
 *
 * Pure data class: no React, no IO. Owns an ordered stack of pages,
 * exposes push/pop/replace/top, fires three event channels (pushed,
 * popped, top), and lets pages register dirty-check callbacks consulted
 * by the router before pop.
 *
 * Listener exceptions are caught and logged; they never kill the store.
 */

import { debugLog } from "../debug-log.js";

export type PageKind =
  | "preset-select"
  | "goal-input"
  | "agent-detect"
  | "launch-preview"
  | "spawning"
  | "running"
  | "complete"
  | "advanced"
  | "panel"
  | "entity-detail";

export interface Page {
  readonly kind: PageKind;
  readonly params?: Readonly<Record<string, string>>;
}

export type StackEvent =
  | { type: "pushed"; page: Page; depth: number }
  | { type: "popped"; page: Page; depth: number }
  | { type: "top"; page: Page; depth: number };

export type DirtyCheck = () => boolean;

type EventType = StackEvent["type"];
type Listener = (e: StackEvent) => void;

export class PagesStore {
  private stack: Page[] = [];
  private subs: Record<EventType, Set<Listener>> = {
    pushed: new Set(),
    popped: new Set(),
    top: new Set(),
  };
  private dirtyChecks = new Map<PageKind, DirtyCheck>();
  private snapshotCache: readonly Page[] | null = null;

  push(page: Page): void {
    const cur = this.top();
    if (cur && samePage(cur, page)) return; // no-op for duplicate-top
    this.stack.push(page);
    this.snapshotCache = null;
    this.fire("pushed", page);
    this.fire("top", page);
  }

  pop(): Page | undefined {
    if (this.stack.length <= 1) return undefined; // bottom guard
    const popped = this.stack.pop()!;
    this.snapshotCache = null;
    this.fire("popped", popped);
    const next = this.top();
    if (next) this.fire("top", next);
    return popped;
  }

  replace(page: Page): void {
    const cur = this.top();
    if (cur && samePage(cur, page)) return;
    if (this.stack.length === 0) {
      this.push(page);
      return;
    }
    this.stack[this.stack.length - 1] = page;
    this.snapshotCache = null;
    this.fire("pushed", page);
    this.fire("top", page);
  }

  top(): Page | undefined {
    return this.stack[this.stack.length - 1];
  }

  depth(): number {
    return this.stack.length;
  }

  snapshot(): readonly Page[] {
    if (this.snapshotCache !== null) return this.snapshotCache;
    this.snapshotCache = Object.freeze([...this.stack]);
    return this.snapshotCache;
  }

  subscribe(type: EventType, fn: Listener): () => void {
    this.subs[type].add(fn);
    return () => {
      this.subs[type].delete(fn);
    };
  }

  registerDirtyCheck(kind: PageKind, fn: DirtyCheck): () => void {
    this.dirtyChecks.set(kind, fn);
    return () => {
      if (this.dirtyChecks.get(kind) === fn) this.dirtyChecks.delete(kind);
    };
  }

  hasDirtyTop(): boolean {
    const t = this.top();
    if (!t) return false;
    const check = this.dirtyChecks.get(t.kind);
    if (!check) return false;
    try {
      return check();
    } catch (err) {
      debugLog("PagesStore dirty-check threw, treating as dirty", err);
      return true;
    }
  }

  private fire(type: EventType, page: Page): void {
    const event: StackEvent = { type, page, depth: this.stack.length };
    for (const fn of this.subs[type]) {
      try {
        fn(event);
      } catch (err) {
        debugLog(`PagesStore listener (${type}) threw`, err);
      }
    }
  }
}

function samePage(a: Page, b: Page): boolean {
  if (a.kind !== b.kind) return false;
  const aP = a.params ?? {};
  const bP = b.params ?? {};
  const aKeys = Object.keys(aP);
  const bKeys = Object.keys(bP);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) if (aP[k] !== bP[k]) return false;
  return true;
}
```

- [ ] **Step 1.4: Re-run, expect first 3 tests pass**

Run: `bun test src/tui/data/pages-store.test.ts`
Expected: 3 passed.

- [ ] **Step 1.5: Add pop/replace/dup tests**

Append to `pages-store.test.ts`:

```ts
describe("PagesStore mutations", () => {
  test("pop at depth=1 is a no-op", () => {
    const s = new PagesStore();
    s.push({ kind: "running" });
    expect(s.pop()).toBeUndefined();
    expect(s.depth()).toBe(1);
  });

  test("pop at depth>1 returns popped page and exposes new top", () => {
    const s = new PagesStore();
    s.push({ kind: "running" });
    s.push({ kind: "panel", params: { panel: "agents" } });
    const out = s.pop();
    expect(out).toEqual({ kind: "panel", params: { panel: "agents" } });
    expect(s.top()).toEqual({ kind: "running" });
  });

  test("duplicate-top push is a no-op", () => {
    const s = new PagesStore();
    s.push({ kind: "panel", params: { panel: "agents" } });
    s.push({ kind: "panel", params: { panel: "agents" } });
    expect(s.depth()).toBe(1);
  });

  test("replace swaps top, does not change depth", () => {
    const s = new PagesStore();
    s.push({ kind: "preset-select" });
    s.replace({ kind: "goal-input" });
    expect(s.depth()).toBe(1);
    expect(s.top()).toEqual({ kind: "goal-input" });
  });

  test("replace on empty pushes", () => {
    const s = new PagesStore();
    s.replace({ kind: "running" });
    expect(s.depth()).toBe(1);
    expect(s.top()).toEqual({ kind: "running" });
  });
});
```

- [ ] **Step 1.6: Run, expect all pass**

Run: `bun test src/tui/data/pages-store.test.ts`
Expected: 8 passed.

- [ ] **Step 1.7: Add listener tests**

Append:

```ts
describe("PagesStore listeners", () => {
  test("pushed + top fire on push, popped + top on pop", () => {
    const s = new PagesStore();
    const events: StackEvent[] = [];
    s.subscribe("pushed", (e) => events.push(e));
    s.subscribe("popped", (e) => events.push(e));
    s.subscribe("top", (e) => events.push(e));

    s.push({ kind: "running" });
    s.push({ kind: "panel", params: { panel: "agents" } });
    s.pop();

    expect(events.map((e) => e.type)).toEqual([
      "pushed", "top",
      "pushed", "top",
      "popped", "top",
    ]);
    expect(events[5]?.page).toEqual({ kind: "running" });
    expect(events[5]?.depth).toBe(1);
  });

  test("listener throw is caught; subsequent listeners still fire", () => {
    const s = new PagesStore();
    const seen: string[] = [];
    s.subscribe("top", () => {
      throw new Error("boom");
    });
    s.subscribe("top", () => seen.push("ok"));
    s.push({ kind: "running" });
    expect(seen).toEqual(["ok"]);
  });

  test("unsubscribe stops further calls", () => {
    const s = new PagesStore();
    const fn = mock(() => {});
    const off = s.subscribe("top", fn);
    s.push({ kind: "running" });
    off();
    s.push({ kind: "panel", params: { panel: "agents" } });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("PagesStore dirty checks", () => {
  test("hasDirtyTop is false when no check registered", () => {
    const s = new PagesStore();
    s.push({ kind: "goal-input" });
    expect(s.hasDirtyTop()).toBe(false);
  });

  test("hasDirtyTop reflects registered check", () => {
    const s = new PagesStore();
    s.push({ kind: "goal-input" });
    let dirty = false;
    s.registerDirtyCheck("goal-input", () => dirty);
    expect(s.hasDirtyTop()).toBe(false);
    dirty = true;
    expect(s.hasDirtyTop()).toBe(true);
  });

  test("dirty check throw → treated as dirty", () => {
    const s = new PagesStore();
    s.push({ kind: "goal-input" });
    s.registerDirtyCheck("goal-input", () => {
      throw new Error("oops");
    });
    expect(s.hasDirtyTop()).toBe(true);
  });

  test("registerDirtyCheck unsubscribe removes the check", () => {
    const s = new PagesStore();
    s.push({ kind: "goal-input" });
    const off = s.registerDirtyCheck("goal-input", () => true);
    expect(s.hasDirtyTop()).toBe(true);
    off();
    expect(s.hasDirtyTop()).toBe(false);
  });
});
```

- [ ] **Step 1.8: Run, expect all pass**

Run: `bun test src/tui/data/pages-store.test.ts`
Expected: 15 passed.

- [ ] **Step 1.9: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/data/pages-store.ts src/tui/data/pages-store.test.ts`
Expected: 0 errors.

- [ ] **Step 1.10: Commit**

```bash
git add src/tui/data/pages-store.ts src/tui/data/pages-store.test.ts
git commit -m "feat(tui): add PagesStore for navigation stack (#303)"
```

---

## Task 2: useScreenStack hook

**Files:**
- Create: `src/tui/hooks/use-screen-stack.ts`
- Create: `src/tui/hooks/use-screen-stack.test.tsx`

**Reference patterns:**
- React hook over external store: see `src/tui/hooks/use-entities.ts` (uses `useSyncExternalStore`).
- Existing context shape: see `src/tui/hooks/entity-store-context.tsx`.

- [ ] **Step 2.1: Write failing hook tests**

Create `src/tui/hooks/use-screen-stack.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import React from "react";
import { PagesStore } from "../data/pages-store.js";
import { useScreenStack } from "./use-screen-stack.js";

function Probe({ store, onRender }: { store: PagesStore; onRender: (top: ReturnType<typeof useScreenStack>) => void }) {
  const value = useScreenStack(store);
  onRender(value);
  return null;
}

describe("useScreenStack", () => {
  test("returns initial top + depth, re-renders on push/pop", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    const renders: Array<{ top: unknown; depth: number }> = [];
    render(
      <Probe
        store={store}
        onRender={(v) => renders.push({ top: v.top, depth: v.depth })}
      />,
    );
    expect(renders.at(-1)).toEqual({ top: { kind: "running" }, depth: 1 });

    store.push({ kind: "panel", params: { panel: "agents" } });
    expect(renders.at(-1)?.depth).toBe(2);

    store.pop();
    expect(renders.at(-1)).toEqual({ top: { kind: "running" }, depth: 1 });
  });

  test("exposes push/pop/replace bound to the same store", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    let api: ReturnType<typeof useScreenStack> | null = null;
    render(<Probe store={store} onRender={(v) => (api = v)} />);
    api?.push({ kind: "panel", params: { panel: "dag" } });
    expect(store.top()).toEqual({ kind: "panel", params: { panel: "dag" } });
  });

  test("unsubscribes on unmount", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    const renders: number[] = [];
    const { unmount } = render(
      <Probe store={store} onRender={(v) => renders.push(v.depth)} />,
    );
    const before = renders.length;
    unmount();
    store.push({ kind: "panel", params: { panel: "agents" } });
    expect(renders.length).toBe(before);
  });
});
```

- [ ] **Step 2.2: Run, expect failure**

Run: `bun test src/tui/hooks/use-screen-stack.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement the hook**

Create `src/tui/hooks/use-screen-stack.ts`:

```ts
/**
 * useScreenStack — React subscription to a PagesStore (#303).
 *
 * Subscribes to the `top` event channel and re-renders whenever
 * top changes. Returns the current top, depth, snapshot, and bound
 * push/pop/replace actions.
 */

import { useCallback, useSyncExternalStore } from "react";
import type { Page, PagesStore } from "../data/pages-store.js";

export interface ScreenStackValue {
  readonly top: Page | undefined;
  readonly depth: number;
  readonly snapshot: readonly Page[];
  readonly push: (page: Page) => void;
  readonly pop: () => Page | undefined;
  readonly replace: (page: Page) => void;
}

export function useScreenStack(store: PagesStore): ScreenStackValue {
  const subscribe = useCallback(
    (cb: () => void) => store.subscribe("top", cb),
    [store],
  );
  const getSnapshot = useCallback(() => store.snapshot(), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    top: snapshot[snapshot.length - 1],
    depth: snapshot.length,
    snapshot,
    push: useCallback((p) => store.push(p), [store]),
    pop: useCallback(() => store.pop(), [store]),
    replace: useCallback((p) => store.replace(p), [store]),
  };
}
```

- [ ] **Step 2.4: Run, expect pass**

Run: `bun test src/tui/hooks/use-screen-stack.test.tsx`
Expected: 3 passed.

- [ ] **Step 2.5: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/hooks/use-screen-stack.ts src/tui/hooks/use-screen-stack.test.tsx`
Expected: 0 errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/tui/hooks/use-screen-stack.ts src/tui/hooks/use-screen-stack.test.tsx
git commit -m "feat(tui): add useScreenStack hook (#303)"
```

---

## Task 3: ConfirmPopDialog component

**Files:**
- Create: `src/tui/components/confirm-pop-dialog.tsx`
- Create: `src/tui/components/confirm-pop-dialog.test.tsx`

**Reference patterns:**
- Modal overlay shape and theming: see `src/tui/components/help-overlay.tsx`.

- [ ] **Step 3.1: Write failing component tests**

Create `src/tui/components/confirm-pop-dialog.test.tsx`:

```tsx
import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import React from "react";
import { ConfirmPopDialog } from "./confirm-pop-dialog.js";

describe("ConfirmPopDialog", () => {
  test("returns null when not visible", () => {
    const { container } = render(
      <ConfirmPopDialog visible={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  test("renders prompt text when visible", () => {
    const { container } = render(
      <ConfirmPopDialog visible onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.textContent).toContain("Discard unsaved changes?");
  });
});
```

- [ ] **Step 3.2: Run, expect failure**

Run: `bun test src/tui/components/confirm-pop-dialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement minimal component**

Create `src/tui/components/confirm-pop-dialog.tsx`:

```tsx
/**
 * <ConfirmPopDialog> — modal shown when a dirty page tries to pop (#303).
 *
 * Presentational only. The router decides when to show it and routes
 * keystrokes (y/n/enter/esc) to onConfirm / onCancel. Mounting it does
 * not subscribe to keys; the router intercepts.
 */

import React from "react";
import { theme } from "../theme.js";

export interface ConfirmPopDialogProps {
  readonly visible: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export const ConfirmPopDialog: React.NamedExoticComponent<ConfirmPopDialogProps> =
  React.memo(function ConfirmPopDialog({ visible }: ConfirmPopDialogProps) {
    if (!visible) return null;
    return (
      <box
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        borderColor={theme.focus}
      >
        <text bold color={theme.focus}>
          Discard unsaved changes?
        </text>
        <text color={theme.secondary}>
          [y] discard and go back   [n] stay
        </text>
      </box>
    );
  });
```

- [ ] **Step 3.4: Run tests, expect pass**

Run: `bun test src/tui/components/confirm-pop-dialog.test.tsx`
Expected: 2 passed.

- [ ] **Step 3.5: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/components/confirm-pop-dialog.tsx src/tui/components/confirm-pop-dialog.test.tsx`
Expected: 0 errors.

- [ ] **Step 3.6: Commit**

```bash
git add src/tui/components/confirm-pop-dialog.tsx src/tui/components/confirm-pop-dialog.test.tsx
git commit -m "feat(tui): add ConfirmPopDialog overlay (#303)"
```

---

## Task 4: BreadcrumbBar refactor — accept stack prop

**Files:**
- Modify: `src/tui/components/breadcrumb-bar.tsx`
- Create: `src/tui/components/breadcrumb-bar.test.tsx`

The existing `screen` prop must continue to work — three call sites (agent-detect, goal-input, spawn-progress) still pass it. We add an optional `stack` prop; when present, it takes precedence and renders a depth chain. We delete the old `screen` prop usages in Task 6 once the router renders the breadcrumb centrally.

- [ ] **Step 4.1: Write failing tests for stack mode**

Create `src/tui/components/breadcrumb-bar.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import React from "react";
import type { Page } from "../data/pages-store.js";
import { BreadcrumbBar } from "./breadcrumb-bar.js";

describe("BreadcrumbBar with stack prop", () => {
  test("renders single-page stack as the page label", () => {
    const stack: readonly Page[] = [{ kind: "preset-select" }];
    const { container } = render(<BreadcrumbBar stack={stack} width={120} />);
    expect(container.textContent).toContain("Preset Select");
  });

  test("renders depth chain joined by chevron", () => {
    const stack: readonly Page[] = [
      { kind: "running" },
      { kind: "panel", params: { panel: "agents" } },
      { kind: "panel", params: { panel: "sessions" } },
    ];
    const { container } = render(<BreadcrumbBar stack={stack} width={120} />);
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("Sessions");
    expect(container.textContent).toContain("›"); // chevron
  });

  test("collapses to current page label only when width<70", () => {
    const stack: readonly Page[] = [
      { kind: "running" },
      { kind: "panel", params: { panel: "agents" } },
    ];
    const { container } = render(<BreadcrumbBar stack={stack} width={50} />);
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).not.toContain("Running");
  });
});

describe("BreadcrumbBar with legacy screen prop", () => {
  test("still renders Screen label when stack absent", () => {
    const { container } = render(<BreadcrumbBar screen="goal-input" width={120} />);
    expect(container.textContent).toContain("Goal");
  });
});
```

- [ ] **Step 4.2: Run, expect stack tests fail (legacy passes)**

Run: `bun test src/tui/components/breadcrumb-bar.test.tsx`
Expected: 3 stack tests FAIL, 1 legacy passes.

- [ ] **Step 4.3: Add stack support to component**

Modify `src/tui/components/breadcrumb-bar.tsx` — replace the entire file content:

```tsx
/**
 * Responsive breadcrumb bar (#303).
 *
 * Two prop modes:
 *   - `stack`  — render depth chain from a PagesStore snapshot (preferred)
 *   - `screen` — legacy single-screen label (kept for shim screens that
 *                still self-render their own breadcrumb)
 *
 * Width breakpoints (apply to both modes):
 *   >= 100 cols: Full chain with "Grove" prefix
 *   70-99 cols:  Truncated chain (no "Grove" prefix)
 *   < 70 cols:   Current page label only
 *   < 40 cols:   Minimal — current page label, no hint
 */

import React from "react";
import type { Page, PageKind } from "../data/pages-store.js";
import type { Screen } from "../screens/screen-manager.js";
import { theme } from "../theme.js";

const PAGE_LABELS: Record<PageKind, string> = {
  "preset-select": "Preset Select",
  "goal-input": "Goal",
  "agent-detect": "Launch Preview",
  "launch-preview": "Launch Preview",
  spawning: "Spawning",
  running: "Running",
  complete: "Complete",
  advanced: "Advanced",
  panel: "Panel",
  "entity-detail": "Detail",
};

const PANEL_LABELS: Record<string, string> = {
  agents: "Agents",
  sessions: "Sessions",
  dag: "DAG",
  tasks: "Tasks",
  reviews: "Reviews",
  feed: "Feed",
};

const SCREEN_LABELS: Record<Screen, string> = {
  "preset-select": "Preset Select",
  "agent-detect": "Launch Preview",
  "launch-preview": "Launch Preview",
  "goal-input": "Goal",
  spawning: "Spawning",
  running: "Running",
  advanced: "Advanced",
  complete: "Complete",
};

function pageLabel(p: Page): string {
  if (p.kind === "panel") {
    const panel = p.params?.panel ?? "";
    return PANEL_LABELS[panel] ?? "Panel";
  }
  return PAGE_LABELS[p.kind];
}

export interface BreadcrumbBarProps {
  readonly stack?: readonly Page[] | undefined;
  readonly screen?: Screen | undefined;
  readonly presetName?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly width: number;
}

export const BreadcrumbBar: React.NamedExoticComponent<BreadcrumbBarProps> =
  React.memo(function BreadcrumbBar({
    stack,
    screen,
    presetName,
    sessionId,
    width,
  }: BreadcrumbBarProps): React.ReactNode {
    const labels = stack && stack.length > 0
      ? stack.map(pageLabel)
      : screen
        ? [SCREEN_LABELS[screen] ?? screen]
        : [];

    if (labels.length === 0) return null;
    const current = labels[labels.length - 1] ?? "";
    const shortSession = sessionId?.slice(0, 8);

    if (width < 40) {
      return (
        <box paddingX={1}>
          <text color={theme.focus} bold>
            {current}
          </text>
        </box>
      );
    }

    if (width < 70) {
      return (
        <box paddingX={1} flexDirection="row">
          <text color={theme.focus} bold>
            {current}
          </text>
        </box>
      );
    }

    const parts: React.ReactNode[] = [];
    if (width >= 100) {
      parts.push(
        <text key="grove" color={theme.text} bold>
          Grove
        </text>,
        <text key="grove-sep" color={theme.secondary}>
          {" › "}
        </text>,
      );
    }
    if (presetName) {
      parts.push(
        <text key="preset" color={theme.secondary}>
          {presetName}
        </text>,
        <text key="preset-sep" color={theme.secondary}>
          {" › "}
        </text>,
      );
    }
    labels.forEach((label, i) => {
      const isLast = i === labels.length - 1;
      parts.push(
        <text
          key={`label-${i}`}
          color={isLast ? theme.focus : theme.secondary}
          bold={isLast}
        >
          {label}
        </text>,
      );
      if (!isLast) {
        parts.push(
          <text key={`sep-${i}`} color={theme.secondary}>
            {" › "}
          </text>,
        );
      }
    });
    if (shortSession) {
      parts.push(
        <text key="sess-sep" color={theme.secondary}>
          {" › "}
        </text>,
        <text key="sess" color={theme.secondary}>
          {shortSession}
        </text>,
      );
    }

    return (
      <box paddingX={1} flexDirection="row">
        {parts}
      </box>
    );
  });
```

- [ ] **Step 4.4: Run tests, expect pass**

Run: `bun test src/tui/components/breadcrumb-bar.test.tsx`
Expected: 4 passed.

- [ ] **Step 4.5: Typecheck — expect failure b/c PagesStore not yet imported elsewhere is fine**

Run: `bun run typecheck`
Expected: 0 errors. (Existing screen-prop call sites still compile.)

- [ ] **Step 4.6: Lint**

Run: `bun run lint src/tui/components/breadcrumb-bar.tsx src/tui/components/breadcrumb-bar.test.tsx`
Expected: 0 errors.

- [ ] **Step 4.7: Commit**

```bash
git add src/tui/components/breadcrumb-bar.tsx src/tui/components/breadcrumb-bar.test.tsx
git commit -m "feat(tui): BreadcrumbBar accepts stack prop (#303)"
```

---

## Task 5: PagesStore React context

**Files:**
- Modify: `src/tui/hooks/use-screen-stack.ts` (add provider/context)

A `<PagesStoreProvider>` lets nested screens (`goal-input`, `running-view`, etc.) reach the store without prop-drilling. Add to the same module to keep the surface in one place.

- [ ] **Step 5.1: Write failing test**

Append to `src/tui/hooks/use-screen-stack.test.tsx`:

```tsx
import { PagesStoreProvider, usePagesStoreFromContext } from "./use-screen-stack.js";

function ContextProbe({ onValue }: { onValue: (s: unknown) => void }) {
  const s = usePagesStoreFromContext();
  onValue(s);
  return null;
}

describe("PagesStoreProvider", () => {
  test("exposes the same store instance to descendants", () => {
    const store = new PagesStore();
    let captured: unknown = null;
    render(
      <PagesStoreProvider store={store}>
        <ContextProbe onValue={(s) => (captured = s)} />
      </PagesStoreProvider>,
    );
    expect(captured).toBe(store);
  });

  test("usePagesStoreFromContext throws when no provider", () => {
    let err: unknown = null;
    try {
      render(<ContextProbe onValue={() => {}} />);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain("PagesStoreProvider");
  });
});
```

- [ ] **Step 5.2: Run, expect fail**

Run: `bun test src/tui/hooks/use-screen-stack.test.tsx`
Expected: FAIL — `PagesStoreProvider` not exported.

- [ ] **Step 5.3: Add provider + context hook**

Append to `src/tui/hooks/use-screen-stack.ts`:

```ts
import { createContext, useContext } from "react";

const PagesStoreContext = createContext<PagesStore | null>(null);

export interface PagesStoreProviderProps {
  readonly store: PagesStore;
  readonly children: React.ReactNode;
}

export function PagesStoreProvider({
  store,
  children,
}: PagesStoreProviderProps): React.ReactElement {
  return (
    <PagesStoreContext.Provider value={store}>
      {children}
    </PagesStoreContext.Provider>
  );
}

export function usePagesStoreFromContext(): PagesStore {
  const s = useContext(PagesStoreContext);
  if (!s) {
    throw new Error("usePagesStoreFromContext: no <PagesStoreProvider> in tree");
  }
  return s;
}
```

Then rename `use-screen-stack.ts` to `use-screen-stack.tsx` (JSX in file).

- [ ] **Step 5.4: Run, expect all hook tests pass**

Run: `bun test src/tui/hooks/use-screen-stack.test.tsx`
Expected: 5 passed.

- [ ] **Step 5.5: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/hooks/use-screen-stack.tsx`
Expected: 0 errors.

- [ ] **Step 5.6: Commit**

```bash
git add src/tui/hooks/use-screen-stack.ts src/tui/hooks/use-screen-stack.tsx src/tui/hooks/use-screen-stack.test.tsx
git commit -m "feat(tui): add PagesStoreProvider context (#303)"
```

---

## Task 6: PagesRouter

**Files:**
- Create: `src/tui/components/pages-router.tsx`
- Create: `src/tui/components/pages-router.test.tsx`

The router is the integration point. It owns:
- Component map keyed by `PageKind`
- Esc handler: dirty? show dialog. Depth=1? quit-confirm. Else pop.
- The single rendered `<BreadcrumbBar stack={...} />`

For Task 6 we test only the swap + esc-handler logic. We mount stub component placeholders since the real screens have heavy deps; full integration lands in Task 8.

- [ ] **Step 6.1: Write failing tests**

Create `src/tui/components/pages-router.test.tsx`:

```tsx
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import React from "react";
import { PagesStore } from "../data/pages-store.js";
import { PagesRouter, type PagesRouterComponentMap } from "./pages-router.js";

function makeStubs(): PagesRouterComponentMap {
  const stub = (name: string) =>
    function Stub() {
      return <text>{name}</text>;
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

describe("PagesRouter", () => {
  test("renders component for current top kind", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    const { container } = render(
      <PagesRouter store={store} components={makeStubs()} onQuit={() => {}} />,
    );
    expect(container.textContent).toContain("running");
  });

  test("re-renders on push", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    const { container } = render(
      <PagesRouter store={store} components={makeStubs()} onQuit={() => {}} />,
    );
    store.push({ kind: "panel", params: { panel: "agents" } });
    expect(container.textContent).toContain("panel");
  });

  test("esc on non-dirty top calls pop()", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    store.push({ kind: "panel", params: { panel: "agents" } });
    const { container } = render(
      <PagesRouter store={store} components={makeStubs()} onQuit={() => {}} />,
    );
    fireEvent.keyDown(container, { key: "Escape" });
    expect(store.top()).toEqual({ kind: "running" });
  });

  test("esc at depth=1 calls onQuit", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    const onQuit = mock(() => {});
    const { container } = render(
      <PagesRouter store={store} components={makeStubs()} onQuit={onQuit} />,
    );
    fireEvent.keyDown(container, { key: "Escape" });
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  test("esc on dirty top opens dialog; n cancels; y pops", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    store.push({ kind: "goal-input" });
    store.registerDirtyCheck("goal-input", () => true);

    const { container } = render(
      <PagesRouter store={store} components={makeStubs()} onQuit={() => {}} />,
    );
    fireEvent.keyDown(container, { key: "Escape" });
    expect(container.textContent).toContain("Discard unsaved changes?");

    fireEvent.keyDown(container, { key: "n" });
    expect(store.top()).toEqual({ kind: "goal-input" });
    expect(container.textContent).not.toContain("Discard unsaved changes?");

    fireEvent.keyDown(container, { key: "Escape" });
    fireEvent.keyDown(container, { key: "y" });
    expect(store.top()).toEqual({ kind: "running" });
  });
});
```

- [ ] **Step 6.2: Run, expect fail**

Run: `bun test src/tui/components/pages-router.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement router**

Create `src/tui/components/pages-router.tsx`:

```tsx
/**
 * <PagesRouter> — renders the current top page and owns navigation
 * keyboard handling (#303).
 *
 * Subscribes to the supplied PagesStore via useScreenStack. Maps top
 * page kind to a React component supplied by the caller. Handles esc:
 *   - dirty top → opens ConfirmPopDialog (y discards + pops, n cancels)
 *   - depth=1   → onQuit()
 *   - otherwise → pop()
 *
 * Listens for keys on a wrapping <box tabIndex={-1}> so unit tests can
 * dispatch keydown events deterministically. Production runtime relies
 * on OpenTUI's global keyboard hook surface — see useKeyboard usage in
 * running-view.tsx — which we wire in once router lands in screen-manager.
 */

import React, { useCallback, useState } from "react";
import { useScreenStack } from "../hooks/use-screen-stack.js";
import type { Page, PageKind, PagesStore } from "../data/pages-store.js";
import { ConfirmPopDialog } from "./confirm-pop-dialog.js";

export type PagesRouterComponentMap = Record<
  PageKind,
  React.ComponentType<{ page: Page }>
>;

export interface PagesRouterProps {
  readonly store: PagesStore;
  readonly components: PagesRouterComponentMap;
  readonly onQuit: () => void;
}

export const PagesRouter: React.NamedExoticComponent<PagesRouterProps> =
  React.memo(function PagesRouter({
    store,
    components,
    onQuit,
  }: PagesRouterProps) {
    const { top, depth } = useScreenStack(store);
    const [dialogOpen, setDialogOpen] = useState(false);

    const handleEscape = useCallback(() => {
      if (dialogOpen) return; // dialog handles its own keys
      if (store.hasDirtyTop()) {
        setDialogOpen(true);
        return;
      }
      if (depth <= 1) {
        onQuit();
        return;
      }
      store.pop();
    }, [store, depth, dialogOpen, onQuit]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (dialogOpen) {
          if (e.key === "y") {
            setDialogOpen(false);
            store.pop();
          } else if (e.key === "n" || e.key === "Escape") {
            setDialogOpen(false);
          }
          return;
        }
        if (e.key === "Escape") handleEscape();
      },
      [dialogOpen, store, handleEscape],
    );

    if (!top) return null;
    const Component = components[top.kind];
    return (
      <box
        flexDirection="column"
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <Component page={top} />
        <ConfirmPopDialog
          visible={dialogOpen}
          onConfirm={() => {
            setDialogOpen(false);
            store.pop();
          }}
          onCancel={() => setDialogOpen(false)}
        />
      </box>
    );
  });
```

- [ ] **Step 6.4: Run, expect pass**

Run: `bun test src/tui/components/pages-router.test.tsx`
Expected: 5 passed.

- [ ] **Step 6.5: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/components/pages-router.tsx src/tui/components/pages-router.test.tsx`
Expected: 0 errors.

- [ ] **Step 6.6: Commit**

```bash
git add src/tui/components/pages-router.tsx src/tui/components/pages-router.test.tsx
git commit -m "feat(tui): add PagesRouter with esc-pop + confirm dialog (#303)"
```

---

## Task 7: screen-manager shim — delegate to PagesRouter

**Files:**
- Modify: `src/tui/screens/screen-manager.tsx`
- Modify: `src/tui/screens/goal-input.tsx` (remove self-rendered breadcrumb; register dirty-check)
- Modify: `src/tui/screens/agent-detect.tsx` (remove self-rendered breadcrumb)
- Modify: `src/tui/screens/spawn-progress.tsx` (remove self-rendered breadcrumb)
- Modify: `src/tui/screens/screen-manager.test.ts`

Wizard transitions become `pages.push` (forward navigation) or `pages.replace` (collapsing one phase into another, e.g. spawning → running). The `ScreenState` interface stays — it's still the durable data slot for preset name, goal text, role mapping etc.

- [ ] **Step 7.1: Read existing screen-manager transitions**

Re-read `src/tui/screens/screen-manager.tsx`:
- Lines 41-49 — `Screen` type definition (KEEP this export — `BreadcrumbBar` still references it for the legacy `screen` prop path).
- Lines 51-72 — `ScreenState` (KEEP — durable data slot).
- Lines 109-135 — initial state + topology resolution.
- Lines 380-720 — every state transition. Each `setState(s => ({ ...s, screen: "X", ... }))` becomes `pages.push({ kind: "X" })` or `pages.replace({ kind: "X" })` — the data fields (`selectedPreset`, `goal`, `roleMapping`, `sessionId`, `sessionWarning`, `sessionStartedAt`, `spawnStates`, `completeSnapshot`) keep flowing through `setState`.

Mapping:
| Transition | New action |
| --- | --- |
| Initial mount, presets present | Initial stack: `[preset-select]` |
| Initial mount, startOnRunning | Initial stack: `[running]` |
| preset selected → goal-input | `push({ kind: "goal-input" })` |
| goal entered → launch-preview | `push({ kind: "launch-preview" })` |
| launch-preview → spawning | `push({ kind: "spawning" })` |
| spawning → running | `replace({ kind: "running" })` (collapses wizard) |
| running → complete | `replace({ kind: "complete" })` |
| running → advanced | `push({ kind: "advanced" })` |
| advanced → running | `pop()` |
| complete → fresh start | New stack: `[preset-select]` (replace + pop loop or expose `resetTo`) |

For "complete → fresh start", add a `resetTo(page: Page): void` method to `PagesStore` that empties the stack and pushes the given page. Update tests in Task 1 — actually fold this into Task 7 since we discovered the need late.

- [ ] **Step 7.2: Add `resetTo` to PagesStore**

Modify `src/tui/data/pages-store.ts`, append before the closing `}`:

```ts
  /** Empty the stack and push `page`. Fires popped+top for any prior pages. */
  resetTo(page: Page): void {
    while (this.stack.length > 0) {
      const popped = this.stack.pop()!;
      this.fire("popped", popped);
    }
    this.snapshotCache = null;
    this.push(page);
  }
```

Append test in `src/tui/data/pages-store.test.ts`:

```ts
test("resetTo empties stack and pushes the given page", () => {
  const s = new PagesStore();
  s.push({ kind: "preset-select" });
  s.push({ kind: "goal-input" });
  s.resetTo({ kind: "running" });
  expect(s.depth()).toBe(1);
  expect(s.top()).toEqual({ kind: "running" });
});
```

Run: `bun test src/tui/data/pages-store.test.ts` — expect 16 passed.

- [ ] **Step 7.3: Define component map and rewrite screen-manager**

Modify `src/tui/screens/screen-manager.tsx`. Strategy:

1. Inside `ScreenManager`, instantiate a `PagesStore` once via `useState`.
2. Build initial stack from `initialState.screen` / `startOnRunning` / `presets`.
3. Replace every `setState({ screen: ... })` call with the matching `pages.push`/`pages.replace`/`pages.resetTo` action — keep the rest of `ScreenState` setters (preset, goal, sessionId, etc.) unchanged.
4. Wrap the rendered tree in `<PagesStoreProvider store={pages}>` and replace the per-screen `switch` with `<PagesRouter store={pages} components={COMPONENTS} onQuit={onQuit} />`.

Skeleton:

```tsx
import { PagesStore, type Page } from "../data/pages-store.js";
import { PagesStoreProvider } from "../hooks/use-screen-stack.js";
import { PagesRouter, type PagesRouterComponentMap } from "../components/pages-router.js";

// at top of ScreenManager body:
const [pages] = useState(() => {
  const store = new PagesStore();
  const initialPage: Page = startOnRunning
    ? { kind: "running" }
    : initialState?.screen
      ? { kind: initialState.screen as Page["kind"] }
      : presets && presets.length > 0
        ? { kind: "preset-select" }
        : { kind: "goal-input" };
  store.push(initialPage);
  return store;
});

// component map: maps each PageKind → existing screen component, ignoring `page` prop
const COMPONENTS: PagesRouterComponentMap = useMemo(() => ({
  "preset-select": () => <PresetSelect ... />,
  "goal-input":    () => <GoalInput ... />,
  "agent-detect":  () => <AgentDetect ... />,
  "launch-preview":() => <AgentDetect ... />,
  spawning:        () => <SpawnProgress ... />,
  running:         () => <RunningView ... />,
  complete:        () => <CompleteView ... />,
  advanced:        () => <App {...appProps} />,
  panel:           () => <RunningView ... />,           // running view reads top via context
  "entity-detail": () => <RunningView ... />,           // placeholder until C5 lands
}), [/* deps from existing screen rendering */]);

return (
  <PagesStoreProvider store={pages}>
    <BreadcrumbBar stack={pages.snapshot()} width={...} />
    <PagesRouter store={pages} components={COMPONENTS} onQuit={onQuit} />
  </PagesStoreProvider>
);
```

Where the existing code does `setState({ screen: "goal-input", ... })`, replace `screen` updates with `pages.push({ kind: "goal-input" })` and keep the rest of the `ScreenState` mutation. After the rewrite, every `state.screen` read site uses `pages.top()?.kind` instead.

- [ ] **Step 7.4: Remove self-rendered breadcrumbs from goal-input, agent-detect, spawn-progress**

For each of `src/tui/screens/goal-input.tsx`, `agent-detect.tsx`, `spawn-progress.tsx`:

Find the line `import { BreadcrumbBar } from "../components/breadcrumb-bar.js";` and remove it.
Find `<BreadcrumbBar screen=... />` JSX and remove it.

(The router renders one centralized breadcrumb in Step 7.3.)

- [ ] **Step 7.5: Update screen-manager test**

In `src/tui/screens/screen-manager.test.ts`, every assertion that reads `state.screen` or sets `initialState: { screen: "..." }` must keep working — `ScreenState.screen` is still a recognized hint. Where the test asserts a transition produced `screen: "goal-input"`, change to:

```ts
const harness = mountScreenManager({ ... });
// previously: expect(harness.state().screen).toBe("goal-input");
expect(harness.pages().top()?.kind).toBe("goal-input");
```

Expose `pages()` from your test harness (the harness already wraps `useState`-driven state — add a passthrough).

- [ ] **Step 7.6: Run all tests**

Run: `bun test src/tui/screens/screen-manager.test.ts`
Expected: all existing test cases pass.

Run: `bun test src/tui/`
Expected: 0 regressions.

- [ ] **Step 7.7: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/`
Expected: 0 errors.

- [ ] **Step 7.8: Commit**

```bash
git add src/tui/data/pages-store.ts src/tui/data/pages-store.test.ts \
        src/tui/screens/screen-manager.tsx src/tui/screens/screen-manager.test.ts \
        src/tui/screens/goal-input.tsx src/tui/screens/agent-detect.tsx \
        src/tui/screens/spawn-progress.tsx
git commit -m "refactor(tui): screen-manager delegates to PagesRouter (#303)"
```

---

## Task 8: running-view goto integration

**Files:**
- Modify: `src/tui/screens/running-view.tsx`

`gotoDispatch` currently mutates `expandedPanel`. Rewrite so each goto pushes a `panel` page; an effect listens to top changes and updates `expandedPanel` from `top.params.panel`. This preserves all the downstream `expandedPanel` consumers without rewriting them.

- [ ] **Step 8.1: Add hook + effect at top of RunningView**

In `src/tui/screens/running-view.tsx`, add the import:

```ts
import { usePagesStoreFromContext } from "../hooks/use-screen-stack.js";
import { useScreenStack } from "../hooks/use-screen-stack.js";
import type { Page } from "../data/pages-store.js";
```

Inside the component body, after the `expandedPanel` state declaration around line 188:

```ts
const pagesStore = usePagesStoreFromContext();
const { top } = useScreenStack(pagesStore);

useEffect(() => {
  if (top?.kind !== "panel") return;
  const panel = top.params?.panel;
  const map: Record<string, RunningPanel> = {
    agents: RunningPanel.Agents,
    sessions: RunningPanel.Sessions,
    dag: RunningPanel.Dag,
    tasks: RunningPanel.Tasks,
    reviews: RunningPanel.Reviews,
    feed: RunningPanel.Feed,
  };
  const target = panel ? map[panel] : undefined;
  if (target !== undefined) {
    const next = expandPanelTransition(expandedPanel, zoomLevel, target);
    setExpandedPanel(next.expandedPanel);
    setZoomLevel(next.zoomLevel);
  }
}, [top, expandedPanel, zoomLevel]);
```

- [ ] **Step 8.2: Rewrite gotoDispatch to push panel pages**

Replace the existing `gotoDispatch` (around line 631) with:

```ts
const gotoDispatch = useMemo<Record<string, () => void>>(
  () => ({
    agents:   () => pagesStore.push({ kind: "panel", params: { panel: "agents" } }),
    dag:      () => pagesStore.push({ kind: "panel", params: { panel: "dag" } }),
    sessions: () => pagesStore.push({ kind: "panel", params: { panel: "sessions" } }),
    tasks:    () => pagesStore.push({ kind: "panel", params: { panel: "tasks" } }),
    reviews:  () => pagesStore.push({ kind: "panel", params: { panel: "reviews" } }),
    quit:     () => onQuit(),
  }),
  [pagesStore, onQuit],
);
```

- [ ] **Step 8.3: Run existing running-view tests**

Run: `bun test src/tui/screens/running-view.c2.test.tsx`
Expected: pass — the c2 test asserts the prompt routing works; with the rewrite it should still work because it tests via the alias-resolved label.

If a test previously asserted `expandedPanel === RunningPanel.Agents` after `:a`, it now asserts via the store.

- [ ] **Step 8.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/screens/running-view.tsx`
Expected: 0 errors.

- [ ] **Step 8.5: Commit**

```bash
git add src/tui/screens/running-view.tsx
git commit -m "refactor(tui): running-view goto pushes panel pages (#303)"
```

---

## Task 9: Dirty-check registrations

**Files:**
- Modify: `src/tui/screens/goal-input.tsx`
- Modify: `src/tui/screens/running-view.tsx`

- [ ] **Step 9.1: Register goal-input dirty check**

In `src/tui/screens/goal-input.tsx`, add inside the component body (after the existing state for goal text, e.g. `const [goalText, ...]`):

```ts
import { useEffect } from "react";
import { usePagesStoreFromContext } from "../hooks/use-screen-stack.js";

const pages = usePagesStoreFromContext();
useEffect(() => {
  return pages.registerDirtyCheck("goal-input", () => goalText.trim().length > 0);
}, [pages, goalText]);
```

(The dependency array includes `goalText` so the closure always sees the latest text — registerDirtyCheck unsubscribes the prior one.)

- [ ] **Step 9.2: Register prompt-mode dirty check in running-view**

In `src/tui/screens/running-view.tsx`, locate the `promptMode` / `promptText` state (search for `setPromptMode(true)` — it's around the `enterPromptMode` action defined inside `keyboardActions`, near line 691 in the pre-refactor file). Below those state declarations, add:

```ts
useEffect(() => {
  if (!promptMode) return;
  return pagesStore.registerDirtyCheck("running", () => promptText.trim().length > 0);
}, [pagesStore, promptMode, promptText]);
```

- [ ] **Step 9.3: Run all TUI tests**

Run: `bun test src/tui/`
Expected: pass.

- [ ] **Step 9.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint src/tui/`
Expected: 0 errors.

- [ ] **Step 9.5: Commit**

```bash
git add src/tui/screens/goal-input.tsx src/tui/screens/running-view.tsx
git commit -m "feat(tui): register dirty checks for goal-input + prompt-mode (#303)"
```

---

## Task 10: Acceptance test — `:a` → `:s` → esc → agents

**Files:**
- Create: `tests/tui/pages-nav-acceptance.test.tsx`

This is the literal acceptance criterion from issue #303.

- [ ] **Step 10.1: Write acceptance test**

Create `tests/tui/pages-nav-acceptance.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import React from "react";
import { PagesStore } from "../../src/tui/data/pages-store.js";
import { PagesRouter, type PagesRouterComponentMap } from "../../src/tui/components/pages-router.js";

function stubMap(): PagesRouterComponentMap {
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
    running: stub("running-feed"),
    complete: stub("complete"),
    advanced: stub("advanced"),
    panel: function Panel({ page }) {
      return <text>{`panel:${page.params?.panel ?? ""}`}</text>;
    },
    "entity-detail": stub("detail"),
  };
}

describe("issue #303 acceptance — :a → :s → esc returns to agents", () => {
  test("two pushes + one pop leaves user on agents", () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    const { container } = render(
      <PagesRouter store={store} components={stubMap()} onQuit={() => {}} />,
    );

    // simulate :a alias resolving to push panel:agents
    store.push({ kind: "panel", params: { panel: "agents" } });
    expect(container.textContent).toContain("panel:agents");

    // simulate :s alias resolving to push panel:sessions
    store.push({ kind: "panel", params: { panel: "sessions" } });
    expect(container.textContent).toContain("panel:sessions");

    // esc pops
    fireEvent.keyDown(container, { key: "Escape" });
    expect(container.textContent).toContain("panel:agents");
    expect(store.depth()).toBe(2);
    expect(store.top()).toEqual({ kind: "panel", params: { panel: "agents" } });
  });
});
```

- [ ] **Step 10.2: Run, expect pass**

Run: `bun test tests/tui/pages-nav-acceptance.test.tsx`
Expected: 1 passed.

- [ ] **Step 10.3: Run full test suite**

Run: `bun test`
Expected: 0 regressions.

- [ ] **Step 10.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors.

- [ ] **Step 10.5: Commit**

```bash
git add tests/tui/pages-nav-acceptance.test.tsx
git commit -m "test(tui): add #303 acceptance test for pages stack"
```

---

## Acceptance verification (issue #303)

- [ ] `esc` pops to previous view — verified in Task 6 (`pages-router.test.tsx`) and Task 10 (acceptance).
- [ ] Breadcrumbs reflect current depth — verified in Task 4 (`breadcrumb-bar.test.tsx`).
- [ ] `:a` → `:s` → `esc` returns to agents, not initial route — verified in Task 10.

## Out of scope (per spec)

- Hint-bar refresh on stack-top change → issue #309.
- Real `<EntityDetailView>` content → issue #311.
- `confirmAndMutate` / 428 enforcement → issue #304.
- Persistent stack across restarts.
