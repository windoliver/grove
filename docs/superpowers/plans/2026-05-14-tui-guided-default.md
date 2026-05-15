# TUI Guided Session Default + Inspect Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the TUI's guided 5-screen flow as the primary "Session View" and the boardroom `App` as an on-demand "Inspect Overlay" — rename internal symbols, rebind `Ctrl+A` → `Ctrl+I`, audit copy, and publish a permanent information-architecture doc. No structural refactor.

**Architecture:** Component hierarchy is unchanged. `TuiApp` boots into the Session View (`ScreenManager`), which already pushes the boardroom (`App`) onto its `PagesStore` when the operator presses the inspect key. The plan only touches names, keybindings, copy, and adds a status-bar `[INSPECT]` chip plus an `Esc` exit on the overlay.

**Tech Stack:** TypeScript, React, `@opentui/react`, OpenTUI `useKeyboard`, Vitest.

**Spec:** [`docs/superpowers/specs/2026-05-14-tui-guided-default-design.md`](../specs/2026-05-14-tui-guided-default-design.md)

**Working directory:** `/Users/tafeng/grove/.claude/worktrees/swirling-sparking-sketch` (run all commands from here; this is a git worktree).

---

## Pre-flight context (read once)

These are the call sites a fresh engineer needs to know. Verify with `grep` before editing.

| Concept | File | Notes |
| --- | --- | --- |
| Lifecycle mode flag | `src/tui/tui-app.tsx:35` | `TuiMode` union; current value `"boardroom"` is the misleading post-init mode that mounts `ScreenManager`. |
| Page kind enum | `src/tui/data/pages-store.ts:15-25` | `PageKind` includes `"advanced"`. Pages are in-memory only — `PagesStore` does **not** persist, so no migration is needed. |
| Screen state machine | `src/tui/screens/screen-manager.tsx:50-58` | `Screen` union includes `"advanced"`. |
| Inspect entry handler | `src/tui/screens/screen-manager.tsx:780-783` | `handleToggleAdvanced` pushes `{ kind: "advanced" }`. |
| Inspect exit handler | `src/tui/screens/screen-manager.tsx:874-877` | `handleAdvancedBack` pops the stack and sets `screen: "running"`. |
| Inspect wrapper | `src/tui/screens/screen-manager.tsx:1068-1083` | `AdvancedModeWrapper`. Intercepts `Ctrl+B` to call `onBack`. |
| Inspect hints | `src/tui/views/advanced-hints.ts` | Exports `ADVANCED_HINTS`. |
| `Ctrl+A` binding (keyboard) | `src/tui/screens/running-keyboard.ts:292-294` | `if (isCtrl && input === "a") actions.toggleAdvanced();` |
| `toggleAdvanced` action prop | `src/tui/screens/running-keyboard.ts:123` and `src/tui/screens/running-view.tsx:130,200,847,848` | Threaded as `onToggleAdvanced` from `screen-manager.tsx:959`. |
| Footer chip text | `src/tui/screens/running-view.tsx:1857` | Currently `Ctrl+A Advanced boardroom`. |
| Status-bar `ScreenContext` | `src/tui/components/status-bar.tsx:13, 76` | Already supports a `[BOARDROOM]` chip; rename + actually wire the value. |
| `screenContext` consumer wiring | none yet — `StatusBar` accepts the prop but no caller passes it for `"boardroom"`. |

**Out of scope (do not edit):**

- `src/tui/app.tsx:579,595,601` — `/api/boardroom/message` references (server API contract).
- `src/tui/remote-provider.ts:585-682` — `/api/boardroom/summary` / `/api/boardroom/answer` API paths.
- `src/tui/app.tsx` panel labels, `PanelBar`, `panels/panel-manager.ts` — boardroom-internal vocabulary.

---

## Conventions

- **One commit per task.** Each task ends with a `git commit` step.
- **TDD for new behavior, find-replace for pure renames.** Behavior steps (Tasks 7, 9, 11, 13) start with a failing test. Rename steps update tests *and* implementation in the same commit because the rename is the behavior.
- **Working directory** for all commands is the worktree root.
- **Verify before editing.** Each rename task begins with a `grep` to confirm hit count, then a `grep` after to confirm zero remaining hits of the old name.

---

## Task 1: Rename `PageKind` value `"advanced"` → `"inspect"` in PagesStore

**Files:**
- Modify: `src/tui/data/pages-store.ts:15-25`

PagesStore is the data layer; renaming here first means every downstream consumer fails the TypeScript compiler, giving us a complete callsite list.

- [ ] **Step 1: Verify current state**

```bash
grep -n '"advanced"' src/tui/data/pages-store.ts
```
Expected: line 23 contains `| "advanced"`.

- [ ] **Step 2: Edit `src/tui/data/pages-store.ts`**

Replace line 23:

```ts
  | "advanced"
```

with:

```ts
  | "inspect"
```

- [ ] **Step 3: Compile to harvest callsite errors**

```bash
npx tsc --noEmit 2>&1 | grep -E '"advanced"|advanced' | head -40
```
Expected: TypeScript errors at every callsite that still uses `"advanced"` as a `PageKind`. Note the file list — Tasks 2 and 3 will fix them.

- [ ] **Step 4: Commit**

```bash
git add src/tui/data/pages-store.ts
git commit -m "tui: rename PageKind advanced -> inspect (#191)"
```

---

## Task 2: Update PagesStore callsites in `screen-manager.tsx` to use `"inspect"`

**Files:**
- Modify: `src/tui/screens/screen-manager.tsx:781-782, 1001`
- Modify: `src/tui/screens/screen-manager.test.ts` (rename references only — assertions on the new value)
- Test: `src/tui/screens/screen-manager.test.ts`

- [ ] **Step 1: Verify current state**

```bash
grep -n '"advanced"\|kind: "advanced"' src/tui/screens/screen-manager.tsx
```
Expected: matches at lines ~781 (`pages.push({ kind: "advanced" })`) and ~1001 (`advanced: AdvancedPage`).

- [ ] **Step 2: Edit `src/tui/screens/screen-manager.tsx`**

At line ~781 (inside `handleToggleAdvanced`):

```ts
      pages.push({ kind: "advanced" });
```
becomes
```ts
      pages.push({ kind: "inspect" });
```

At line ~1001 (in the `components` map literal):

```ts
        advanced: AdvancedPage,
```
becomes
```ts
        inspect: AdvancedPage,
```

(We rename `AdvancedPage` itself in Task 4. For now keep the variable name; only the map key changes.)

- [ ] **Step 3: Update test references**

```bash
grep -n '"advanced"\|kind: "advanced"' src/tui/screens/screen-manager.test.ts
```

For every match, replace `"advanced"` with `"inspect"` in test assertions and fixtures. The test file currently asserts on the page kind that gets pushed on Ctrl+A — those assertions must continue to match production.

- [ ] **Step 4: Run the screen-manager test suite**

```bash
npx vitest run src/tui/screens/screen-manager.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/screen-manager.tsx src/tui/screens/screen-manager.test.ts
git commit -m "tui: switch screen-manager push/route to inspect kind (#191)"
```

---

## Task 3: Update PagesStore callsite in `screens/running-view.tsx` (PagesRouter check)

**Files:**
- Modify: `src/tui/screens/running-view.tsx`
- Modify: `src/tui/components/pages-router.tsx`

`pages-router.tsx:119` carries a comment referencing `"advanced/boardroom"`. There may also be a typeguard or switch on the page kind inside `running-view.tsx` — confirm and update.

- [ ] **Step 1: Find remaining `"advanced"` PageKind references**

```bash
grep -rn '"advanced"' src/tui/ --include="*.ts" --include="*.tsx"
```
Expected: zero hits in code (only docs/specs). If hits remain in production source, replace each with `"inspect"`.

- [ ] **Step 2: Edit `src/tui/components/pages-router.tsx:119`**

Old:
```ts
// that renders `height="100%"` (RunningView, advanced/boardroom) can't
```
New:
```ts
// that renders `height="100%"` (RunningView, inspect overlay) can't
```

- [ ] **Step 3: Compile**

```bash
npx tsc --noEmit 2>&1 | grep -E 'advanced|TS2' | head -20
```
Expected: no errors mentioning `"advanced"`.

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/pages-router.tsx
git commit -m "tui: drop residual advanced PageKind references (#191)"
```

---

## Task 4: Rename `Screen` value `"advanced"` → `"inspect"` and helpers

**Files:**
- Modify: `src/tui/screens/screen-manager.tsx` (Screen union, handler names, wrapper name, AdvancedPage variable)
- Modify: `src/tui/screens/screen-manager.test.ts`

- [ ] **Step 1: Verify current state**

```bash
grep -n '"advanced"\|AdvancedModeWrapper\|AdvancedPage\|handleToggleAdvanced\|handleAdvancedBack' src/tui/screens/screen-manager.tsx
```
Expected matches: `Screen` union line ~58, `handleToggleAdvanced` (line ~780), `handleAdvancedBack` (line ~874), `AdvancedPage` declaration (search nearby in component map), `AdvancedModeWrapper` (lines ~1068, 1082).

- [ ] **Step 2: Apply renames in `src/tui/screens/screen-manager.tsx`**

| Old | New |
| --- | --- |
| `Screen` union member `\| "advanced"` | `\| "inspect"` |
| `handleToggleAdvanced` (all occurrences) | `handleEnterInspect` |
| `handleAdvancedBack` (all occurrences) | `handleExitInspect` |
| `AdvancedPage` (component variable) | `InspectPage` |
| `AdvancedModeWrapper` (component) | `InspectModeWrapper` |
| `AdvancedModeWrapperProps` interface | `InspectModeWrapperProps` |

Use a single multi-edit pass. The renames are mechanical, but `handleToggleAdvanced` also appears in the `components` `useMemo` deps array (line ~1024) — make sure that list updates too.

- [ ] **Step 3: Update `screen-manager.tsx` JSDoc and header comment**

Replace the file-top comment block (line 10) and the JSDoc on `ScreenManagerProps.appProps` (line ~85) and on `AdvancedModeWrapper` (line ~1064):

```ts
 *   Ctrl+A: toggle to App (advanced mode) / Ctrl+B back to RunningView
```
becomes
```ts
 *   Ctrl+I: open inspect overlay (full panel workspace) / Ctrl+I or Esc to return
```

```ts
/** AppProps for the advanced boardroom mode. */
```
becomes
```ts
/** AppProps passed through to the inspect overlay. */
```

```ts
/**
 * Wraps the full App (boardroom) and intercepts Tab key to switch back
 * to the simple RunningView.
 */
```
becomes
```ts
/**
 * Wraps the full App as an inspect overlay above the session view.
 * Intercepts Ctrl+I and Esc to return to the session view.
 */
```

(The Esc binding is added in Task 9; the JSDoc just states intent now.)

- [ ] **Step 4: Apply matching renames in `screen-manager.test.ts`**

```bash
grep -n '"advanced"\|AdvancedModeWrapper\|handleToggleAdvanced\|handleAdvancedBack\|onToggleAdvanced\|toggleAdvanced' src/tui/screens/screen-manager.test.ts
```

For each hit, mechanically rename per the table above. `onToggleAdvanced` becomes `onEnterInspect`; we update that prop name in Task 5.

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/tui/screens/screen-manager.test.ts
```
Expected: all pass. If a test fails, the rename missed a reference — search and fix.

- [ ] **Step 6: Compile**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/tui/screens/screen-manager.tsx src/tui/screens/screen-manager.test.ts
git commit -m "tui: rename Screen advanced -> inspect + handler/wrapper names (#191)"
```

---

## Task 5: Rename prop `onToggleAdvanced` → `onEnterInspect` and action `toggleAdvanced` → `enterInspect`

**Files:**
- Modify: `src/tui/screens/running-view.tsx:130, 200, 847, 848, 971`
- Modify: `src/tui/screens/running-keyboard.ts:123, 293`
- Modify: `src/tui/screens/running-keyboard.test.ts` (mechanical)
- Modify: `src/tui/screens/screen-manager.tsx:959` (prop pass-through site)

- [ ] **Step 1: Verify hit count**

```bash
grep -rn "toggleAdvanced\|onToggleAdvanced" src/tui/ --include="*.ts" --include="*.tsx"
```
Note the file list. Should include the files above plus their test files.

- [ ] **Step 2: Apply renames**

In every file from Step 1:

| Old | New |
| --- | --- |
| `onToggleAdvanced` | `onEnterInspect` |
| `toggleAdvanced` (action interface field, callsite) | `enterInspect` |

In `src/tui/screens/running-view.tsx:847-848`, both `openDetail` and `toggleAdvanced` call the same handler; preserve that. `openDetail` keeps its name (it is overloaded for the Frontier panel; we are not renaming it).

```ts
        openDetail: () => onToggleAdvanced(),
        toggleAdvanced: () => onToggleAdvanced(),
```
becomes
```ts
        openDetail: () => onEnterInspect(),
        enterInspect: () => onEnterInspect(),
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/tui/screens/running-keyboard.test.ts src/tui/screens/screen-manager.test.ts
```
Expected: all pass.

- [ ] **Step 4: Compile**

```bash
npx tsc --noEmit 2>&1 | head -10
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/running-view.tsx src/tui/screens/running-keyboard.ts \
        src/tui/screens/running-keyboard.test.ts src/tui/screens/screen-manager.tsx
git commit -m "tui: rename toggleAdvanced prop/action to enterInspect (#191)"
```

---

## Task 6: Rename hints file and constant — `advanced-hints.ts` → `inspect-hints.ts`

**Files:**
- Delete: `src/tui/views/advanced-hints.ts`
- Create: `src/tui/views/inspect-hints.ts`
- Modify: every importer of `ADVANCED_HINTS`

- [ ] **Step 1: Find importers**

```bash
grep -rn "advanced-hints\|ADVANCED_HINTS" src/tui/ --include="*.ts" --include="*.tsx"
```
Note the file list.

- [ ] **Step 2: Create new file `src/tui/views/inspect-hints.ts`**

```ts
/**
 * Hints for the inspect overlay opened from RunningView (#191).
 *
 * Lives in views/ rather than app.tsx so the hint-map module doesn't
 * need to depend on the root orchestration component.
 */

import { defineHints, type KeyAction } from "../data/hint-map.js";

export const INSPECT_HINTS: readonly KeyAction[] = defineHints([
  { key: "Ctrl+I", label: "Back" },
  { key: "Esc", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);
```

- [ ] **Step 3: Update every importer**

For each file from Step 1, change:

```ts
import { ADVANCED_HINTS } from "<relative path>/views/advanced-hints.js";
```
to:
```ts
import { INSPECT_HINTS } from "<relative path>/views/inspect-hints.js";
```

Then within the file, replace `ADVANCED_HINTS` references with `INSPECT_HINTS`.

- [ ] **Step 4: Delete the old file**

```bash
git rm src/tui/views/advanced-hints.ts
```

- [ ] **Step 5: Compile**

```bash
npx tsc --noEmit 2>&1 | head -10
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tui/views/inspect-hints.ts
git add -u
git commit -m "tui: rename advanced-hints -> inspect-hints, add Esc/Ctrl+I (#191)"
```

---

## Task 7: TDD — `Ctrl+I` enters inspect (replaces `Ctrl+A`)

**Files:**
- Modify: `src/tui/screens/running-keyboard.test.ts` (new failing case)
- Modify: `src/tui/screens/running-keyboard.ts:292`

- [ ] **Step 1: Write the failing test**

Add a new test case to `src/tui/screens/running-keyboard.test.ts`. Find an existing test that drives `Ctrl+A` and copy its structure. The shape of the existing pattern (skim the file to confirm exact helper names; the helper that creates a fake key event and the call into `handleRunningKey` is what to reuse):

```ts
it("Ctrl+I calls enterInspect", () => {
  const actions = makeActionStub();
  const key = makeKey({ ctrl: true, sequence: "i", name: "i" });
  handleRunningKey(key, actions, defaultState());
  expect(actions.enterInspect).toHaveBeenCalledTimes(1);
});

it("Ctrl+A no longer calls enterInspect", () => {
  const actions = makeActionStub();
  const key = makeKey({ ctrl: true, sequence: "a", name: "a" });
  handleRunningKey(key, actions, defaultState());
  expect(actions.enterInspect).not.toHaveBeenCalled();
});
```

If `makeActionStub` / `makeKey` / `handleRunningKey` are not the actual helper names, replace with the file's existing helpers — `grep -n "describe\|^const \|function " src/tui/screens/running-keyboard.test.ts` will show them.

- [ ] **Step 2: Run the new tests — expect failure**

```bash
npx vitest run src/tui/screens/running-keyboard.test.ts -t "Ctrl+I calls enterInspect"
```
Expected: FAIL — `Ctrl+I` is not bound yet.

- [ ] **Step 3: Edit `src/tui/screens/running-keyboard.ts:292-294`**

Current:
```ts
    if (isCtrl && input === "a") {
      actions.enterInspect();
      return true;
    }
```
becomes:
```ts
    if (isCtrl && input === "i") {
      actions.enterInspect();
      return true;
    }
```

(`Ctrl+A` is no longer bound to anything; it returns false and bubbles up.)

- [ ] **Step 4: Run the new tests — expect pass**

```bash
npx vitest run src/tui/screens/running-keyboard.test.ts
```
Expected: all pass, including the two new cases.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/running-keyboard.ts src/tui/screens/running-keyboard.test.ts
git commit -m "tui: rebind inspect entry from Ctrl+A to Ctrl+I (#191)"
```

---

## Task 8: Update `RunningView` footer chip text

**Files:**
- Modify: `src/tui/screens/running-view.tsx:1857`
- Modify: `src/tui/screens/running-view.tsx:12` (file header comment)

- [ ] **Step 1: Verify current state**

```bash
grep -n "Ctrl+A Advanced boardroom\|Ctrl+A: toggle to advanced boardroom" src/tui/screens/running-view.tsx
```
Expected: matches at lines 12 and 1857.

- [ ] **Step 2: Edit line 12 (file header)**

```ts
 * Ctrl+A: toggle to advanced boardroom
```
becomes
```ts
 * Ctrl+I: open inspect overlay
```

- [ ] **Step 3: Edit line 1857 (footer chip)**

```tsx
      <text color={theme.text}> Ctrl+A Advanced boardroom</text>
```
becomes
```tsx
      <text color={theme.text}> Ctrl+I Inspect</text>
```

- [ ] **Step 4: Update any test that asserts on the chip text**

```bash
grep -rn "Advanced boardroom\|Ctrl\\+A Advanced" src/tui/ --include="*.ts" --include="*.tsx"
```
For each hit, update to the new text.

- [ ] **Step 5: Compile + test**

```bash
npx tsc --noEmit && npx vitest run src/tui/screens/running-view.c2.test.tsx
```
Expected: clean, tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tui/screens/running-view.tsx
git add -u
git commit -m "tui: footer chip Ctrl+A Advanced -> Ctrl+I Inspect (#191)"
```

---

## Task 9: TDD — `Esc` from inspect overlay calls `onBack`

**Files:**
- Modify: `src/tui/screens/screen-manager.test.ts` (new failing case)
- Modify: `src/tui/screens/screen-manager.tsx:1072-1083` (`InspectModeWrapper` body)

- [ ] **Step 1: Write the failing test**

Add a new case to the suite that already covers `Ctrl+B` exit. Search:

```bash
grep -n "Ctrl+B\|ctrl: true.*b\|InspectModeWrapper\|AdvancedModeWrapper" src/tui/screens/screen-manager.test.ts
```

Locate the existing exit-on-Ctrl+B test and add directly after it:

```ts
it("Esc inside inspect overlay calls onBack", () => {
  const onBack = vi.fn();
  // Render or invoke the same way the existing Ctrl+B test does:
  // mountInspectModeWrapper({ appProps: fixtureAppProps(), onBack });
  // simulateKey({ name: "escape" });
  // (Replace the two pseudocode lines above with the helpers your suite
  //  already uses — `mountInspectModeWrapper` and `simulateKey` are
  //  placeholders for whatever the neighbouring test invokes.)
  expect(onBack).toHaveBeenCalledTimes(1);
});

it("Ctrl+I inside inspect overlay calls onBack", () => {
  const onBack = vi.fn();
  // Same shape as above, with key { ctrl: true, name: "i" }
  expect(onBack).toHaveBeenCalledTimes(1);
});
```

If the existing test uses a different helper or harness, model the new tests on it exactly. Do **not** invent a new mounting helper.

- [ ] **Step 2: Run — expect failure**

```bash
npx vitest run src/tui/screens/screen-manager.test.ts -t "Esc inside inspect"
```
Expected: FAIL — `Esc` and `Ctrl+I` are not handled by `InspectModeWrapper` yet.

- [ ] **Step 3: Extend `InspectModeWrapper` in `src/tui/screens/screen-manager.tsx`**

Current useKeyboard body (around line 1072):
```ts
        (key) => {
          if (key.ctrl && key.name === "b") {
            onBack();
          }
        },
```
becomes:
```ts
        (key) => {
          if (key.name === "escape") {
            onBack();
            return;
          }
          if (key.ctrl && key.name === "i") {
            onBack();
            return;
          }
          if (key.ctrl && key.name === "b") {
            // Backwards-compat alias (#191). Footer no longer documents it.
            onBack();
          }
        },
```

- [ ] **Step 4: Run — expect pass**

```bash
npx vitest run src/tui/screens/screen-manager.test.ts
```
Expected: all pass, including the two new cases and the existing Ctrl+B case.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/screen-manager.tsx src/tui/screens/screen-manager.test.ts
git commit -m "tui: Esc and Ctrl+I exit inspect overlay (#191)"
```

---

## Task 10: Rename `TuiMode` value `"boardroom"` → `"session"`

**Files:**
- Modify: `src/tui/tui-app.tsx:35, 127, 177, 210, 237, 272, 525`
- Modify: any test that asserts on the mode value

- [ ] **Step 1: Verify hit count**

```bash
grep -rn '"boardroom"\|setMode("boardroom"' src/tui/ --include="*.ts" --include="*.tsx"
```
Expected: 6 `setMode("boardroom")` callsites in `tui-app.tsx` plus the type definition and one `mode === "boardroom"` check at line 525.

- [ ] **Step 2: Edit `src/tui/tui-app.tsx`**

In the type declaration:
```ts
type TuiMode = "setup" | "initializing" | "starting" | "boardroom";
```
becomes:
```ts
type TuiMode = "setup" | "initializing" | "starting" | "session";
```

Replace every `setMode("boardroom")` with `setMode("session")`.

Replace `if (mode === "boardroom" && appProps && spawnManager)` (line 525) with `if (mode === "session" && appProps && spawnManager)`.

- [ ] **Step 3: Update file header comment + relevant JSDoc**

Line 2:
```ts
 * TUI application wrapper — handles the setup -> starting -> boardroom lifecycle.
```
becomes:
```ts
 * TUI application wrapper — handles the setup -> starting -> session lifecycle.
```

Line 11:
```ts
 * (ScreenManager) or the full boardroom App (advanced mode via Tab).
```
becomes:
```ts
 * (ScreenManager). The boardroom App is reachable only as a deep-inspect
 * overlay via Ctrl+I from RunningView.
```

Line 34:
```ts
/** The TUI mode state machine: setup -> initializing/starting -> boardroom. */
```
becomes:
```ts
/** The TUI mode state machine: setup -> initializing/starting -> session. */
```

Line 85:
```ts
/** TUI application root that manages the setup -> boardroom lifecycle. */
```
becomes:
```ts
/** TUI application root that manages the setup -> session lifecycle. */
```

Line 110:
```ts
/** Tracks whether we reached boardroom via Resume (start on RunningView). */
```
becomes:
```ts
/** Tracks whether we reached the session view via Resume (start on RunningView). */
```

Line 274:
```ts
          // no future boardroom→setup path should pre-fill Connect with
```
becomes:
```ts
          // no future session→setup path should pre-fill Connect with
```

Line 319:
```ts
  // Shared via SpawnManagerContext to both ScreenManager and App (advanced mode).
```
becomes:
```ts
  // Shared via SpawnManagerContext to both ScreenManager and App (inspect overlay).
```

- [ ] **Step 4: Find downstream callers of TuiMode**

```bash
grep -rn "TuiMode\|tui-app" src/tui/ --include="*.ts" --include="*.tsx" | grep -v "tui-app.tsx"
```
For each external consumer, verify it does not pattern-match on the literal `"boardroom"`. Fix any that do.

- [ ] **Step 5: Compile + run TUI test subset**

```bash
npx tsc --noEmit && npx vitest run src/tui/
```
Expected: clean, all TUI tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tui/tui-app.tsx
git add -u
git commit -m "tui: rename TuiMode boardroom -> session (#191)"
```

---

## Task 11: TDD — `StatusBar` `[INSPECT]` chip and `ScreenContext` rename

**Files:**
- Modify: `src/tui/components/status-bar.tsx:13, 76`
- Modify: `src/tui/screens/screen-manager.tsx` (compute and pass `screenContext` to App rendering)
- Create or modify: a status-bar test (search first; if absent, add `src/tui/components/status-bar.test.tsx`)

Today `ScreenContext = "running" | "boardroom"` and `SCREEN_CONTEXT_LABELS.boardroom = "BOARDROOM"`. No caller passes `"boardroom"`. We rename to `"inspect"` and **wire it** by passing `screenContext` whenever the top page is `inspect`.

- [ ] **Step 1: Inspect the existing test surface for StatusBar**

```bash
ls src/tui/components/ | grep -i status
grep -rn "StatusBar\|ScreenContext\b" src/tui/components src/tui/screens --include="*.ts" --include="*.tsx" | head
```
Note whether a test file exists. If not, Step 2 creates one.

- [ ] **Step 2: Write the failing test**

If `src/tui/components/status-bar.test.tsx` does not exist, create it. If it exists, add the cases below.

```tsx
import { render } from "@opentui/react/testing"; // use the project's actual testing entry — adjust if a different helper is used in neighbouring tests
import { describe, expect, it } from "vitest";
import { InputMode } from "../hooks/use-panel-focus.js";
import { StatusBar } from "./status-bar.js";

describe("StatusBar inspect chip", () => {
  it("renders [INSPECT] when screenContext is 'inspect'", () => {
    const out = render(<StatusBar mode={InputMode.Normal} screenContext="inspect" />);
    expect(out.lastFrame()).toContain("[INSPECT]");
  });

  it("does not render [INSPECT] without screenContext", () => {
    const out = render(<StatusBar mode={InputMode.Normal} />);
    expect(out.lastFrame()).not.toContain("[INSPECT]");
  });
});
```

If `@opentui/react/testing` is not how the project renders TUI in tests, use the same helper neighbouring tests (e.g., `running-view.c2.test.tsx`) use — search:

```bash
grep -rn "from \"@opentui" src/tui --include="*.test.*" | head -5
```

- [ ] **Step 3: Run — expect failure**

```bash
npx vitest run src/tui/components/status-bar.test.tsx
```
Expected: FAIL — type `"inspect"` is not assignable; or chip text mismatches.

- [ ] **Step 4: Rename in `src/tui/components/status-bar.tsx`**

Line 13:
```ts
export type ScreenContext = "running" | "boardroom";
```
becomes:
```ts
export type ScreenContext = "running" | "inspect";
```

Line 74-77 (the labels map):
```ts
const SCREEN_CONTEXT_LABELS: Record<ScreenContext, string> = {
  running: "RUNNING",
  boardroom: "BOARDROOM",
};
```
becomes:
```ts
const SCREEN_CONTEXT_LABELS: Record<ScreenContext, string> = {
  running: "RUNNING",
  inspect: "INSPECT",
};
```

- [ ] **Step 5: Wire `screenContext` from `screen-manager.tsx`**

Search for the StatusBar usage:

```bash
grep -n "StatusBar\b" src/tui/screens/screen-manager.tsx src/tui/app.tsx src/tui/screens/running-view.tsx
```

For the call site inside `InspectModeWrapper` (or wherever `App` is rendered for the inspect overlay), thread `screenContext="inspect"` into the StatusBar. The simplest path: pass an optional `screenContext` prop from `InspectModeWrapper` down through `App` to its StatusBar. If `App` already takes a prop bag, add `screenContext?: ScreenContext` to it and forward.

Concretely:
1. Add `screenContext?: ScreenContext` to `AppProps` (search `interface AppProps` in `src/tui/app.tsx`; if it is exported, add the optional field).
2. In `App`'s `<StatusBar ... />` JSX, pass `screenContext={screenContext}`.
3. In `InspectModeWrapper` (post-rename), call `<App {...appProps} screenContext="inspect" />`.

If the type plumbing is excessive, the alternative is to subscribe `StatusBar` itself to `PagesStore` via `useScreenStack` and derive `screenContext` internally. Use whichever the surrounding code style prefers — both are acceptable.

- [ ] **Step 6: Run — expect pass**

```bash
npx vitest run src/tui/components/status-bar.test.tsx
```
Expected: both new cases pass.

- [ ] **Step 7: Commit**

```bash
git add src/tui/components/status-bar.tsx src/tui/components/status-bar.test.tsx \
        src/tui/screens/screen-manager.tsx src/tui/app.tsx
git commit -m "tui: ScreenContext boardroom -> inspect, render [INSPECT] chip (#191)"
```

---

## Task 12: Copy audit — comments outside the renamed files

**Files:**
- Modify: `src/tui/hooks/refresh-context.tsx:94, 122`
- Modify: `src/tui/main.ts:201, 203, 779`

Server-API comments in `app.tsx` and `remote-provider.ts` stay (see "Out of scope" in pre-flight context).

- [ ] **Step 1: Verify hit list**

```bash
grep -n "boardroom" src/tui/hooks/refresh-context.tsx src/tui/main.ts
```
Expected: matches at the lines above.

- [ ] **Step 2: Edit `src/tui/hooks/refresh-context.tsx`**

Line 94:
```ts
 * setup -> boardroom transitions.
```
becomes:
```ts
 * setup -> session transitions.
```

Line 122:
```ts
// interactive TUI state during the setup -> boardroom transition.
```
becomes:
```ts
// interactive TUI state during the setup -> session transition.
```

- [ ] **Step 3: Edit `src/tui/main.ts`**

Lines 201-203:
```ts
/**
 * Build boardroom AppProps from a resolved backend.
 *
 * Shared between the direct boardroom path and the post-init transition.
 */
```
becomes:
```ts
/**
 * Build session AppProps from a resolved backend.
 *
 * Shared between the direct session path and the post-init transition.
 */
```

Line 779:
```ts
// --url flag: legacy direct boardroom mode (no interactive screens)
```
becomes:
```ts
// --url flag: legacy direct session mode (no interactive screens)
```

- [ ] **Step 4: Confirm no production-code `boardroom` strings remain in scope**

```bash
grep -rn "boardroom\|BOARDROOM" src/tui/ --include="*.ts" --include="*.tsx"
```
Expected matches **only** at:
- `src/tui/app.tsx:579,595,601` (server API path comments)
- `src/tui/remote-provider.ts:585-682` (server API paths)

Anything else is a miss — fix and re-grep.

- [ ] **Step 5: Compile**

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tui/hooks/refresh-context.tsx src/tui/main.ts
git commit -m "tui: replace boardroom references in JSDoc/comments (#191)"
```

---

## Task 13: Help-overlay one-liner

**Files:**
- Modify: the help-rendering surface used by `?` from RunningView and from `App`

- [ ] **Step 1: Locate the help text source**

```bash
grep -rn "Help\|help\|hint" src/tui/data/hint-map.ts src/tui/views/ src/tui/components/ 2>/dev/null | grep -i "help\b" | head -20
```
Find where help body lines are assembled. Likely in `data/hint-map.ts` or a `views/help.tsx` (search for both). The actual file may differ — adopt whatever the surrounding pattern dictates.

- [ ] **Step 2: Insert the line**

At the top of the help body, prepend:

```
Inspect: Ctrl+I opens deep panel view; Ctrl+I or Esc returns.
```

If help is a list of hint groups rather than free text, add a new entry near the existing global keys (`?`, `q`) describing the same action.

- [ ] **Step 3: Manually verify**

```bash
GROVE_DEV=1 npx tsx src/cli/grove.ts up 2>/dev/null &
# Open a session, press ?, confirm the new line appears.
```
(Project may use a different dev entrypoint — `grep -n "bin\|scripts" package.json | head` to confirm.)

If a manual run is blocked by environment (no nexus, etc.), skip the manual step but ensure unit/snapshot tests on the help view, if any, are updated.

- [ ] **Step 4: Compile + relevant tests**

```bash
npx tsc --noEmit && npx vitest run src/tui/
```
Expected: clean, all pass.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "tui: document inspect overlay in help overlay (#191)"
```

---

## Task 14: Information-architecture doc

**Files:**
- Create: `docs/tui/information-architecture.md`

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p docs/tui
```

Then create `docs/tui/information-architecture.md` with this content:

```markdown
# Grove TUI — Information Architecture

> Status: living document. Update with any change to the lifecycle, screen
> set, or inspect overlay surface.

## Two views, one product

Grove's TUI is a single product with two views:

- **Session View** — the default. Drives an operator from "I want to start a
  session" to "the session is done". This is what every user sees on launch.
- **Inspect Overlay** — opened on demand from the Session View. A multi-panel
  workspace for understanding state in depth (DAG, frontier, dashboard,
  decisions, terminal, …). The overlay is *layered above* the Session View,
  not parallel to it.

If you find yourself saying "the boardroom" in user-facing copy, you mean
"the inspect overlay". `boardroom` survives in server route names
(`/api/boardroom/*`) for backwards compatibility and is not exposed to
operators.

## Lifecycle

```
Welcome ──┬──▶ Initializing ──▶ Session View ──[Ctrl+I]──▶ Inspect Overlay
          ├──▶ Starting     ──▶ Session View ◀─[Ctrl+I or Esc]──┘
          └──▶ Connecting   ──▶ Session View
```

Lifecycle states (`TuiMode` in `src/tui/tui-app.tsx`):

| Mode | When | What renders |
| --- | --- | --- |
| `setup` | First mount | `WelcomeScreen` |
| `initializing` | New grove being created | `InitProgressView` |
| `starting` | Existing grove resuming, or new session in an existing grove | `InitProgressView` |
| `session` | Post-init / post-start | `ScreenManager` (Session View) |

`session` was previously named `boardroom`; the rename landed with #191 to
stop the name from suggesting a separate product.

## Session View

The Session View is a 5-screen state machine in
`src/tui/screens/screen-manager.tsx`. Screen names map 1:1 to the `Screen`
union type:

1. **`preset-select`** — pick a preset (or skip if a topology is already
   supplied).
2. **`goal-input`** — type the operator's goal.
3. **`agent-detect`** / **`launch-preview`** — confirm CLIs and binding.
4. **`spawning`** — per-role spawn progress.
5. **`running`** — live contribution feed and agent status. **This is the
   default landing screen for resumed groves.**
6. **`complete`** — terminal screen with a "new session" option.

The pages stack (`PagesStore`, `src/tui/data/pages-store.ts`) tracks the
visible page. Pushes happen on screen transitions; the stack also carries
the inspect overlay as a top-of-stack page when opened.

## Inspect Overlay

- **Purpose:** deep panel workspace, multi-panel layout, command palette,
  panel zoom, decisions/inbox/vfs/terminal/frontier panels.
- **Entry:** `Ctrl+I` from the `running` screen, and only from there.
  Pushes `{ kind: "inspect" }` onto `PagesStore`.
- **Exit:** `Ctrl+I` *or* `Esc`. Both pop the inspect page; the session
  state underneath is preserved bit-for-bit (no re-mount, no lost cursor
  or autoFollow state).
- **State mechanism:** stack push, **not** a separate mode flag. The
  inspect overlay is rendered by `InspectModeWrapper` (in
  `screen-manager.tsx`), which mounts `App` from `src/tui/app.tsx`.
- **Status badge:** while the overlay is open, the bottom status bar
  renders `[INSPECT]`. The chip is the operator's visual cue that they
  are layered, not in a different product.

`Ctrl+B` is retained for one release as a back-compat alias on the
overlay; it is intentionally undocumented in the footer.

## State ownership

| Concept | Module |
| --- | --- |
| Lifecycle mode (`TuiMode`) | `src/tui/tui-app.tsx` |
| 5-screen state machine (`Screen`) | `src/tui/screens/screen-manager.tsx` |
| Pages stack (`PagesStore`, `PageKind`) | `src/tui/data/pages-store.ts` |
| Inspect overlay panels (`Panel`, `PanelManager`) | `src/tui/app.tsx`, `src/tui/panels/panel-manager.ts` |
| Status bar (`ScreenContext`) | `src/tui/components/status-bar.tsx` |

## When to add to Session View vs. Inspect Overlay

- **Session View** — anything an operator needs to **complete a run**:
  status, contributions, prompts, permission requests, the goal, the
  spawn list.
- **Inspect Overlay** — anything an operator needs to **understand state
  in depth**: graphs, raw events, multi-panel views, command palette,
  search.

If a feature could plausibly live in either, default to the Session View
and add an entry point in the overlay only if the depth view is genuinely
different.

## Naming guidance

- Use "Session View" or "session" in user-facing copy.
- Use "Inspect Overlay" or "inspect" in user-facing copy.
- Do **not** use "boardroom" or "advanced" in user-facing copy.
- The string `boardroom` remains in server route names
  (`/api/boardroom/message`, `/api/boardroom/summary`,
  `/api/boardroom/answer`). Treat these as opaque API identifiers.
```

- [ ] **Step 2: Sanity check rendering**

```bash
cat docs/tui/information-architecture.md | head -20
```
Confirm the leading heading and intro paragraph look right.

- [ ] **Step 3: Commit**

```bash
git add docs/tui/information-architecture.md
git commit -m "docs: TUI information architecture (#191)"
```

---

## Task 15: Final sweep — full test suite + grep audit

**Files:** none (verification only)

- [ ] **Step 1: Full type check**

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 2: Full vitest run (TUI subset)**

```bash
npx vitest run src/tui/
```
Expected: all pass.

- [ ] **Step 3: User-facing `boardroom` grep**

```bash
grep -rn "boardroom\|BOARDROOM" src/tui/ --include="*.ts" --include="*.tsx"
```
Expected matches (exhaustive — anything else is a miss):
- `src/tui/app.tsx:579` — JSDoc on `sendMessage`, server API description
- `src/tui/app.tsx:595` — `// Fallback: POST to boardroom endpoint`
- `src/tui/app.tsx:601` — `/api/boardroom/message` route
- `src/tui/remote-provider.ts` lines 585-682 — `/api/boardroom/*` routes

- [ ] **Step 4: User-facing `advanced` grep**

```bash
grep -rn "Advanced\|ADVANCED\|advanced" src/tui/ --include="*.ts" --include="*.tsx" \
  | grep -v "// " | grep -vi "advance the" | head -30
```
Note: the word "advanced" may legitimately appear in unrelated contexts (e.g., "advance the cursor"). Eyeball the list; flag anything that names a UI mode or surface.

- [ ] **Step 5: Manual smoke (best-effort)**

If a local Grove instance is runnable:
```bash
grove up
```
Open a session. Verify:
1. Footer chip reads `Ctrl+I Inspect`.
2. `Ctrl+I` opens the overlay; `[INSPECT]` chip appears in status bar.
3. `Esc` and `Ctrl+I` both return to the running view.
4. `Ctrl+B` still works (back-compat).
5. `Ctrl+A` does nothing.
6. `?` opens help showing the new inspect line.

If the environment is unavailable, document the skip in the PR description.

- [ ] **Step 6: No commit needed; sweep is verification only.**

---

## Self-review against the spec

Coverage of every spec section:

| Spec section | Plan task |
| --- | --- |
| Architecture (no structural changes) | Implicit — no task removes structure |
| Naming changes table — `TuiMode` value | Task 10 |
| Naming changes table — `Screen` value | Task 4 |
| Naming changes table — `PageKind` value | Tasks 1, 2, 3 |
| Naming changes table — `AdvancedModeWrapper` | Task 4 |
| Naming changes table — `advanced-hints.ts` file rename | Task 6 |
| Naming changes table — `ADVANCED_HINTS` constant | Task 6 |
| Naming changes table — `handleToggleAdvanced` | Task 4 |
| Transitions — `Ctrl+I` entry | Task 7 |
| Transitions — `Ctrl+I` or `Esc` exit | Task 9 |
| Transitions — `Ctrl+B` retained one release | Task 9 |
| Transitions — `[INSPECT]` status chip | Task 11 |
| Copy & label — `tui-app.tsx` header | Task 10 |
| Copy & label — `screen-manager.tsx` headers/JSDoc | Task 4 |
| Copy & label — `running-view.tsx` footer + header | Task 8 |
| Copy & label — `inspect-hints.ts` JSDoc + body | Task 6 |
| Copy & label — `main.ts` JSDoc + line 779 | Task 12 |
| Copy & label — `refresh-context.tsx` comments | Task 12 |
| Copy & label — help overlay one-liner | Task 13 |
| Copy & label — `app.tsx` API path refs excluded | Pre-flight + Task 15 grep audit |
| IA doc | Task 14 |
| Testing — rename `advanced` test cases to `inspect` | Tasks 2, 4, 5 |
| Testing — Esc exit test | Task 9 |
| Testing — Ctrl+A no longer triggers | Task 7 |
| Testing — footer chip snapshot/text | Task 8 |
| Testing — status bar inspect chip | Task 11 |
| Risk: PagesStore serialization | Resolved in pre-flight — `PagesStore` does not persist; no migration needed |

No placeholder steps. Every step shows the exact code/command/file path required.
