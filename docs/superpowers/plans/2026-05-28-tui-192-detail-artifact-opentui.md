# TUI #192 — Detail + Artifact OpenTUI Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `detail.tsx` scrollable + focus-aware and replace artifact-preview's hand-rolled plain-text diff with OpenTUI's `<diff>` intrinsic (inline/split toggle), plus a minimal focus-change pulse.

**Architecture:** Follow the existing centralized pattern — UI state in the pure reducer `app-reducer.ts`, key→callback mapping in `use-keyboard-handler.ts`, callbacks defined in `app.tsx`, props threaded through `panel-manager.tsx` into the two views. No server/provider changes.

**Tech Stack:** TypeScript, React + `@opentui/react` intrinsics (`<box>`, `<text>`, `<scrollbox>`, `<diff>`, `<markdown>`, `<code>`), `useTimeline` for animation, `bun test` + `react-test-renderer`, biome.

**Spec:** `docs/superpowers/specs/2026-05-28-tui-192-detail-artifact-opentui-design.md`

**Commands:** test `bun test <path>` · typecheck `bun run typecheck` · lint `bun run lint` · build `bun run build`

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/tui/opentui-probe.test.tsx` | One-off runtime probe for the two OpenTUI unknowns | Create (Task 0; deleted in Task 10) |
| `src/tui/app-reducer.ts` | Pure UI state: add `artifactDiffMode`, `detailFocusedSection` + actions | Modify |
| `src/tui/app-reducer.test.ts` | Reducer unit tests | Create/Modify |
| `src/tui/hooks/use-keyboard-handler.ts` | Map `s` (artifact) + `j/k` (detail view) to callbacks; extend `KeyboardActions` | Modify |
| `src/tui/hooks/use-keyboard-handler.test.ts` | Handler unit tests | Modify (or create if absent) |
| `src/tui/app.tsx` | Define dispatch callbacks; reset section on detail change; pass props | Modify |
| `src/tui/panels/panel-manager.tsx` | Thread `diffMode` + `focusedSection` props into views | Modify |
| `src/tui/views/artifact-preview.tsx` | Render diff via `<diff>`/`SplitDiff` per `diffMode`; drop LCS (contingent) | Modify |
| `src/tui/views/artifact-preview.test.tsx` | Diff-mode rendering tests | Create/Modify |
| `src/tui/views/detail.tsx` | `<scrollbox>` + focusable sections + no truncation + pulse | Modify |
| `src/tui/views/detail.test.tsx` | Section-focus + truncation-removal tests | Create/Modify |

**Section order (detail.tsx focus ring):** `summary, scores, relations, artifacts, ancestors, children, discussion, context`. A section is "present" when it has data (same conditions already guarding each block today). Focus ring iterates present sections only.

---

## Task 0: Probe the two OpenTUI runtime unknowns

Resolve, before building on them: (a) does `<diff>` accept `mode="inline"`? (b) does `<scrollbox>` expose a controllable scroll position prop (`scrollTop`/`scrollOffset`/`stickyScroll`)? Result decides the fallbacks named in the spec.

**Files:**
- Create: `src/tui/opentui-probe.test.tsx`

- [ ] **Step 1: Write a probe test that renders both intrinsics and inspects the runtime**

```tsx
import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { createElement } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("opentui probe (#192)", () => {
  test("diff intrinsic accepts mode=inline without throwing", () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        createElement("diff", { oldContent: "a\nb", newContent: "a\nc", mode: "inline" }),
      );
    });
    const json = tree?.toJSON();
    // Record what the renderer produced for mode=inline.
    console.log("DIFF_INLINE_JSON", JSON.stringify(json));
    expect(json).toBeDefined();
  });

  test("scrollbox surfaces its scroll-control props", () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        createElement("scrollbox", { scrollTop: 5 }, createElement("text", {}, "x")),
      );
    });
    const json = tree?.toJSON();
    console.log("SCROLLBOX_JSON", JSON.stringify(json));
    expect(json).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the probe and read the output**

Run: `bun test src/tui/opentui-probe.test.tsx 2>&1 | grep -E "DIFF_INLINE_JSON|SCROLLBOX_JSON"`
Expected: two JSON lines print. Inspect them:
- If `DIFF_INLINE_JSON` shows `mode:"inline"` preserved (no error) → inline mode is usable. If it threw or dropped to split, mark inline unusable.
- If `SCROLLBOX_JSON` shows `scrollTop` preserved as a prop → controllable scroll is usable. If absent, fall back to manual windowing.

Note: `react-test-renderer` records intrinsic props verbatim; this confirms the *prop surface* but not pixel behavior. Final visual confirmation is the TUI smoke in Task 10. If the probe is inconclusive, also `grep -rn "scrollTop\|stickyScroll\|mode" node_modules/@opentui/core/dist 2>/dev/null | head` to confirm against source.

- [ ] **Step 3: Record findings as a comment at the top of the probe file**

Add a comment block stating the two decisions (`INLINE_DIFF: usable|fallback-to-code`, `SCROLLBOX_SCROLL: scrollTop|manual-window`). Later tasks read this.

- [ ] **Step 4: Commit**

```bash
git add src/tui/opentui-probe.test.tsx
git commit -m "test(tui): probe OpenTUI diff inline + scrollbox scroll for #192"
```

---

## Task 1: Reducer — artifact diff mode (inline/split)

**Files:**
- Modify: `src/tui/app-reducer.ts`
- Test: `src/tui/app-reducer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { INITIAL_KEYBOARD_STATE, tuiReducer } from "./app-reducer.js";

describe("artifact diff mode (#192)", () => {
  test("defaults to inline", () => {
    expect(INITIAL_KEYBOARD_STATE.artifactDiffMode).toBe("inline");
  });
  test("ARTIFACT_DIFF_MODE_TOGGLE flips inline <-> split", () => {
    const once = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "ARTIFACT_DIFF_MODE_TOGGLE" });
    expect(once.artifactDiffMode).toBe("split");
    const twice = tuiReducer(once, { type: "ARTIFACT_DIFF_MODE_TOGGLE" });
    expect(twice.artifactDiffMode).toBe("inline");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/app-reducer.test.ts 2>&1 | tail -20`
Expected: FAIL — `artifactDiffMode` is undefined / action type not assignable.

- [ ] **Step 3: Implement**

In `src/tui/app-reducer.ts`:
- Add to `TuiKeyboardState`: `readonly artifactDiffMode: "inline" | "split";`
- Add to `TuiAction` union: `| { readonly type: "ARTIFACT_DIFF_MODE_TOGGLE" }`
- Add to `INITIAL_KEYBOARD_STATE`: `artifactDiffMode: "inline",`
- Add reducer case (next to `ARTIFACT_DIFF_TOGGLE`):

```ts
    case "ARTIFACT_DIFF_MODE_TOGGLE":
      return {
        ...state,
        artifactDiffMode: state.artifactDiffMode === "inline" ? "split" : "inline",
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/app-reducer.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/app-reducer.ts src/tui/app-reducer.test.ts
git commit -m "feat(tui): add artifactDiffMode reducer state for #192"
```

---

## Task 2: Reducer — detail section focus

`detailFocusedSection` is a raw integer; the view applies modulo over present sections (the reducer cannot know which sections have data). Reset to 0 when a new contribution opens (wired in Task 5).

**Files:**
- Modify: `src/tui/app-reducer.ts`
- Test: `src/tui/app-reducer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("detail section focus (#192)", () => {
  test("defaults to 0", () => {
    expect(INITIAL_KEYBOARD_STATE.detailFocusedSection).toBe(0);
  });
  test("NEXT increments, PREV decrements (may go negative; view applies modulo)", () => {
    const a = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "DETAIL_SECTION_NEXT" });
    expect(a.detailFocusedSection).toBe(1);
    const b = tuiReducer(a, { type: "DETAIL_SECTION_PREV" });
    expect(b.detailFocusedSection).toBe(0);
    const c = tuiReducer(b, { type: "DETAIL_SECTION_PREV" });
    expect(c.detailFocusedSection).toBe(-1);
  });
  test("RESET returns to 0", () => {
    const a = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "DETAIL_SECTION_NEXT" });
    expect(tuiReducer(a, { type: "DETAIL_SECTION_RESET" }).detailFocusedSection).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/app-reducer.test.ts 2>&1 | tail -20`
Expected: FAIL — property/actions missing.

- [ ] **Step 3: Implement**

In `src/tui/app-reducer.ts`:
- Add to `TuiKeyboardState`: `readonly detailFocusedSection: number;`
- Add to `TuiAction`: `| { readonly type: "DETAIL_SECTION_NEXT" } | { readonly type: "DETAIL_SECTION_PREV" } | { readonly type: "DETAIL_SECTION_RESET" }`
- Add to `INITIAL_KEYBOARD_STATE`: `detailFocusedSection: 0,`
- Add reducer cases:

```ts
    case "DETAIL_SECTION_NEXT":
      return { ...state, detailFocusedSection: state.detailFocusedSection + 1 };
    case "DETAIL_SECTION_PREV":
      return { ...state, detailFocusedSection: state.detailFocusedSection - 1 };
    case "DETAIL_SECTION_RESET":
      return state.detailFocusedSection === 0
        ? state
        : { ...state, detailFocusedSection: 0 };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/app-reducer.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/app-reducer.ts src/tui/app-reducer.test.ts
git commit -m "feat(tui): add detailFocusedSection reducer state for #192"
```

---

## Task 3: Keyboard handler — artifact split/inline toggle (`s`)

Mirror exactly how `d`/`onArtifactDiffToggle` is wired: a named action case in the top `switch` (keymap parity) AND a hardcoded `input === "s"` in the `focused === Panel.Artifact` block.

**Files:**
- Modify: `src/tui/hooks/use-keyboard-handler.ts`
- Test: `src/tui/hooks/use-keyboard-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Locate the existing pattern (how a test builds a `KeyboardActions` stub + `Panel`). If the suite already has an artifact `d` test, copy it. Add:

```ts
test("'s' in Artifact panel toggles diff mode", () => {
  const calls: string[] = [];
  const actions = makeActionsStub({ onArtifactDiffModeToggle: () => calls.push("mode") });
  const handled = handleKey(makeKey("s"), { ...ctx, focused: Panel.Artifact }, actions);
  expect(handled).toBe(true);
  expect(calls).toEqual(["mode"]);
});
```

(Use the suite's actual helper names — `makeActionsStub`/`handleKey`/`makeKey` are placeholders for whatever the file already defines. If no handler test file exists, create one modeled on `app-reducer.test.ts` + the handler's exported entry function.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/hooks/use-keyboard-handler.test.ts 2>&1 | tail -20`
Expected: FAIL — `onArtifactDiffModeToggle` not on `KeyboardActions`.

- [ ] **Step 3: Implement**

In `src/tui/hooks/use-keyboard-handler.ts`:
- In `interface KeyboardActions` (near `onArtifactDiffToggle` line 38): add `readonly onArtifactDiffModeToggle: () => void;`
- In the top `switch`, after the `artifact_diff` case (line 177): add

```ts
    case "artifact_diff_mode":
      if (focused !== Panel.Artifact) return false;
      actions.onArtifactDiffModeToggle();
      return true;
```

- In the hardcoded `if (focused === Panel.Artifact) { ... }` block (after the `input === "d"` branch, line 568): add

```ts
    if (input === "s") {
      actions.onArtifactDiffModeToggle();
      return true;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/hooks/use-keyboard-handler.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-keyboard-handler.ts src/tui/hooks/use-keyboard-handler.test.ts
git commit -m "feat(tui): 's' toggles artifact split/inline diff (#192)"
```

---

## Task 4: Keyboard handler — detail section nav (`j`/`k` in detail view)

When `nav.isDetailView` is true, `j`/`k`/arrows move the focused section instead of the (meaningless-in-detail) row cursor. Gate this BEFORE the generic within-panel `j`/`k` at line ~609.

**Files:**
- Modify: `src/tui/hooks/use-keyboard-handler.ts`
- Test: `src/tui/hooks/use-keyboard-handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("'j'/'k' move detail section when in detail view", () => {
  const calls: string[] = [];
  const actions = makeActionsStub({
    onDetailSectionNext: () => calls.push("next"),
    onDetailSectionPrev: () => calls.push("prev"),
    nav: { ...navStub, isDetailView: true },
  });
  expect(handleKey(makeKey("j"), ctx, actions)).toBe(true);
  expect(handleKey(makeKey("k"), ctx, actions)).toBe(true);
  expect(calls).toEqual(["next", "prev"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/hooks/use-keyboard-handler.test.ts 2>&1 | tail -20`
Expected: FAIL — callbacks missing / `cursorDown` called instead.

- [ ] **Step 3: Implement**

In `src/tui/hooks/use-keyboard-handler.ts`:
- Add to `KeyboardActions`: `readonly onDetailSectionNext: () => void; readonly onDetailSectionPrev: () => void;`
- Immediately BEFORE the generic `// Within-panel navigation` block (line ~608), add:

```ts
  // Detail overlay: j/k move the focused section (no row cursor in detail).
  if (actions.nav.isDetailView) {
    if (input === "j" || input === "down") {
      actions.onDetailSectionNext();
      return true;
    }
    if (input === "k" || input === "up") {
      actions.onDetailSectionPrev();
      return true;
    }
  }
```

(Place after the panel-specific Terminal/Artifact blocks so it doesn't shadow them; detail view has no panel focus so those guards won't match anyway.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/hooks/use-keyboard-handler.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-keyboard-handler.ts src/tui/hooks/use-keyboard-handler.test.ts
git commit -m "feat(tui): j/k navigate detail sections (#192)"
```

---

## Task 5: app.tsx — callbacks, reset effect, prop pass-through

No new unit test (integration wiring); guarded by typecheck + existing suite.

**Files:**
- Modify: `src/tui/app.tsx`

- [ ] **Step 1: Add the dispatch callbacks**

Near line 892 (next to `onArtifactDiffToggle`), add:

```ts
      onArtifactDiffModeToggle: () => dispatch({ type: "ARTIFACT_DIFF_MODE_TOGGLE" }),
      onDetailSectionNext: () => dispatch({ type: "DETAIL_SECTION_NEXT" }),
      onDetailSectionPrev: () => dispatch({ type: "DETAIL_SECTION_PREV" }),
```

- [ ] **Step 2: Reset focused section when the open contribution changes**

Add an effect (near other `useEffect`s that depend on `nav.detailCid`):

```ts
  useEffect(() => {
    dispatch({ type: "DETAIL_SECTION_RESET" });
  }, [nav.detailCid]);
```

- [ ] **Step 3: Pass new state into panel-manager**

Where `panel-manager`/`PanelManager` props are spread (the block around lines 1218–1219 passing `artifactIndex`/`showArtifactDiff`), add:

```tsx
          artifactDiffMode={ks.artifactDiffMode}
          detailFocusedSection={ks.detailFocusedSection}
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck 2>&1 | tail -20`
Expected: no new errors. (Props are consumed in Task 6; until then TS may flag unknown props on PanelManager — proceed to Task 6 in the same commit window. If typecheck blocks, do Task 6 first, then re-run.)

- [ ] **Step 5: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): wire diff-mode + section-focus callbacks and reset (#192)"
```

---

## Task 6: panel-manager — thread props into views

**Files:**
- Modify: `src/tui/panels/panel-manager.tsx`

- [ ] **Step 1: Extend the props interface**

Near line 93–95 (the `artifactIndex`/`showArtifactDiff` declarations), add:

```ts
  /** Diff rendering mode for the Artifact panel. */
  readonly artifactDiffMode?: "inline" | "split" | undefined;
  /** Raw focused-section index for the Detail overlay (view applies modulo). */
  readonly detailFocusedSection?: number | undefined;
```

- [ ] **Step 2: Destructure them**

In the component params (near line 183–184 where `artifactIndex, showArtifactDiff` are destructured), add `artifactDiffMode,` and `detailFocusedSection,`.

- [ ] **Step 3: Pass to DetailView**

Replace the `Panel.Detail` render (line ~300):

```tsx
            <DetailView
              provider={provider}
              cid={nav.detailCid ?? ""}
              intervalMs={intervalMs}
              focusedSectionRaw={detailFocusedSection ?? 0}
            />
```

- [ ] **Step 4: Pass to ArtifactPreviewView**

Add to the `<ArtifactPreviewView ... />` props (next to `showDiff={showArtifactDiff}`, line ~390):

```tsx
              diffMode={artifactDiffMode ?? "inline"}
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck 2>&1 | tail -20`
Expected: errors now only about `DetailView`/`ArtifactPreviewView` not yet accepting `focusedSectionRaw`/`diffMode` — fixed in Tasks 7–8. Confirm no OTHER new errors.

- [ ] **Step 6: Commit**

```bash
git add src/tui/panels/panel-manager.tsx
git commit -m "feat(tui): thread diffMode + focusedSection props to views (#192)"
```

---

## Task 7: artifact-preview.tsx — `<diff>` intrinsic + diffMode

Replace the plain-text diff branch. Behavior depends on Task 0's `INLINE_DIFF` finding.

**Files:**
- Modify: `src/tui/views/artifact-preview.tsx`
- Test: `src/tui/views/artifact-preview.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { ArtifactPreviewView } from "./artifact-preview.js";
// reuse the suite's existing provider stub if present; else a minimal one
// exposing capabilities.artifacts + diffArtifacts() returning {parent,child}.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function findType(json: unknown, type: string): boolean {
  if (!json || typeof json !== "object") return false;
  const node = json as { type?: string; children?: unknown[] };
  if (node.type === type) return true;
  return (node.children ?? []).some((c) => findType(c, type));
}

describe("artifact diff rendering (#192)", () => {
  test("split mode renders the <diff> intrinsic, not hand-rolled text", async () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        <ArtifactPreviewView
          provider={makeArtifactProvider()}
          cid="child" artifactName="a.txt" parentCid="parent"
          showDiff diffMode="split" active
        />,
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(findType(tree?.toJSON(), "diff")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/artifact-preview.test.tsx 2>&1 | tail -20`
Expected: FAIL — `diffMode` not a prop; no `<diff>` in tree (current code renders `<text>` unified diff).

- [ ] **Step 3: Implement**

In `src/tui/views/artifact-preview.tsx`:
- Add to `ArtifactPreviewProps`: `readonly diffMode?: "inline" | "split" | undefined;`
- Destructure `diffMode` (default `"inline"`) in the component params.
- Import `SplitDiff`: `import { SplitDiff } from "../components/split-diff.js";`
- Replace `diffBody` (the `computeUnifiedDiff` consumer) with raw text plus a render branch. Keep loading/error strings. New diff render block (replacing the `diffBody !== undefined ? (... scrollbox text ...)` branch):

```tsx
        {showDiff && parentCid ? (
          diffLoading && !diffData ? (
            <text>Loading diff...</text>
          ) : diffError && !diffData ? (
            <text color={theme.error}>{`Diff error: ${diffError.message}`}</text>
          ) : !diffData ? (
            <text opacity={0.5}>(no diff data)</text>
          ) : diffMode === "split" ? (
            <SplitDiff
              leftLabel={`parent (${parentCid.slice(0, 8)})`}
              rightLabel={`child (${(cid ?? "").slice(0, 8)})`}
              leftContent={diffData.parentText}
              rightContent={diffData.childText}
            />
          ) : (
            createElement("scrollbox" as string, { flexGrow: 1 },
              createElement("diff" as string, {
                oldContent: diffData.parentText,
                newContent: diffData.childText,
                mode: "inline",
              }))
          )
        ) : ( /* existing content render: empty | markdown | code | hex | text */ )}
```

- **If Task 0 found `INLINE_DIFF: fallback-to-code`:** replace the inline `createElement("diff", {mode:"inline"})` with `createElement("code" as string, { language: "diff" }, computeUnifiedDiff(diffData.parentText, diffData.childText, leftLabel, rightLabel))` and KEEP `computeUnifiedDiff`. Otherwise delete `computeUnifiedDiff` and its LCS table (lines ~165–214) and the now-unused `diffBody` memo.
- Update the header hint to include split/inline: `{showDiff ? \`  [DIFF ${diffMode}]\` : "  [d]iff"}` and, when `hasDiffSupport`, append `  [s]plit/inline` while diff is on.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/views/artifact-preview.test.tsx 2>&1 | tail -20`
Expected: PASS. Also add/keep a test that with `diffMode="inline"` the tree contains `<diff>` (or `<code language="diff">` in the fallback build).

- [ ] **Step 5: Lint + typecheck**

Run: `bun run lint src/tui/views/artifact-preview.tsx 2>&1 | tail; bun run typecheck 2>&1 | tail -20`
Expected: clean (no unused `computeUnifiedDiff` if deleted).

- [ ] **Step 6: Commit**

```bash
git add src/tui/views/artifact-preview.tsx src/tui/views/artifact-preview.test.tsx
git commit -m "feat(tui): render artifact diff via <diff> intrinsic with split/inline (#192)"
```

---

## Task 8: detail.tsx — scrollbox, focusable sections, no truncation

**Files:**
- Modify: `src/tui/views/detail.tsx`
- Test: `src/tui/views/detail.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { DetailView } from "./detail.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(json: unknown): string {
  if (json == null) return "";
  if (typeof json === "string") return json;
  if (Array.isArray(json)) return json.map(textOf).join("");
  const n = json as { children?: unknown };
  return textOf(n.children);
}
function hasType(json: unknown, type: string): boolean {
  if (!json || typeof json !== "object") return false;
  const n = json as { type?: string; children?: unknown[] };
  if (n.type === type) return true;
  return (n.children ?? []).some((c) => hasType(c, type));
}

describe("detail view (#192)", () => {
  test("wraps content in a scrollbox", async () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        <DetailView provider={makeDetailProvider(longContribution())} cid="c1" intervalMs={0} focusedSectionRaw={0} />,
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(hasType(tree?.toJSON(), "scrollbox")).toBe(true);
  });

  test("renders full description (no .slice truncation)", async () => {
    const longDesc = "X".repeat(800); // > old 500 cap
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        <DetailView provider={makeDetailProvider(longContribution({ description: longDesc }))} cid="c1" intervalMs={0} focusedSectionRaw={0} />,
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(textOf(tree?.toJSON()).includes("X".repeat(800))).toBe(true);
  });
});
```

(`makeDetailProvider`/`longContribution` model the existing provider stub used by other view tests; build them to return a `ContributionDetail` with the fields detail.tsx reads.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/views/detail.test.tsx 2>&1 | tail -20`
Expected: FAIL — no scrollbox; description capped at 500.

- [ ] **Step 3: Implement**

In `src/tui/views/detail.tsx`:
- Add to `DetailProps`: `readonly focusedSectionRaw?: number | undefined;`
- Build the present-section list in render order and compute the focused index via modulo:

```tsx
  const SECTION_ORDER = [
    "summary", "scores", "relations", "artifacts",
    "ancestors", "children", "discussion", "context",
  ] as const;
  const present = SECTION_ORDER.filter((s) => sectionHasData(s)); // mirror each block's existing guard
  const raw = focusedSectionRaw ?? 0;
  const focusedKey = present.length ? present[((raw % present.length) + present.length) % present.length] : undefined;
```

  where `sectionHasData("scores")` = `scores && Object.keys(scores).length>0`, `relations` = `(relations??[]).length>0`, `artifacts` = `Object.keys(artifacts).length>0`, `ancestors`/`children` = `.length>0`, `discussion` = `thread.length>1`, `context` = `context && Object.keys(context).length>0`, `summary` = always true.
- Wrap the returned section stack in `createElement("scrollbox" as string, { flexGrow: 1 }, <the column of sections>)` (header line with cid/status can stay above the scrollbox or inside it — keep inside so it scrolls with content is unnecessary; place header outside, sections inside).
- Give each section box a focus treatment when its key === `focusedKey`: `borderStyle="single" borderColor={theme.focus}` (or a `>` prefix on its title `<text>`), else no border. Use a small helper `sectionProps(key)` returning the border props.
- **Remove truncation:** render `description` in full (drop `.slice(0, 500)`); render ancestor/child `summary` in full (drop `.slice(0, 50)`); render full `context` JSON (drop `.slice(0, 300)`). Thread reply summary `.slice(0,40)` may stay (single-line list) or be removed — remove for consistency.
- **If Task 0 found `SCROLLBOX_SCROLL: scrollTop`:** also set `scrollTop` on the scrollbox so the focused section is in view (estimate offset by summing prior present-section heights, or pass the focused child's index — simplest: set `stickyScroll`/`scrollTop` to a coarse `focusedIndex * approxSectionRows`). **If `manual-window`:** instead render only a window of present sections centered on `focusedKey` (slice `present` around the focused index) — document this as the fallback in a comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/views/detail.test.tsx 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Add a focus-ring test and run**

```tsx
test("focusedSectionRaw selects a present section (skips absent ones)", async () => {
  // contribution with NO scores; focusedSectionRaw=1 should land on the 2nd PRESENT section
  // assert the focused section's title carries the accent marker/border.
});
```

Run: `bun test src/tui/views/detail.test.tsx 2>&1 | tail -20` → PASS.

- [ ] **Step 6: Lint + commit**

```bash
bun run lint src/tui/views/detail.tsx 2>&1 | tail
git add src/tui/views/detail.tsx src/tui/views/detail.test.tsx
git commit -m "feat(tui): scrollable focus-aware detail view, no truncation (#192)"
```

---

## Task 9: Minimal focus-change pulse (useTimeline)

A ~150ms accent pulse on the focused section border (detail) when `focusedSectionRaw` changes, and on the artifact header when `artifactIndex` changes. Must degrade gracefully — never required for correctness.

**Files:**
- Modify: `src/tui/views/detail.tsx`, `src/tui/views/artifact-preview.tsx`

- [ ] **Step 1: Write a smoke test that mounting + changing focus does not throw**

```tsx
test("changing focusedSectionRaw re-renders without error (pulse)", async () => {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(
      <DetailView provider={makeDetailProvider(longContribution())} cid="c1" intervalMs={0} focusedSectionRaw={0} />);
  });
  await act(async () => {
    tree?.update(<DetailView provider={makeDetailProvider(longContribution())} cid="c1" intervalMs={0} focusedSectionRaw={1} />);
  });
  expect(tree?.toJSON()).toBeDefined();
});
```

- [ ] **Step 2: Run — expect PASS already (no pulse yet), establishing the no-throw baseline**

Run: `bun test src/tui/views/detail.test.tsx 2>&1 | tail -10`
Expected: PASS (guards the next step against regressions).

- [ ] **Step 3: Implement the pulse**

- In `detail.tsx`: derive an animated accent via `useTimeline` keyed on `focusedKey`. Minimal approach that stays test-safe: `const tl = useTimeline({ duration: 150 });` and in a `useEffect([focusedKey])` drive a `useState` `pulse` boolean true→false (e.g. set true, then `tl.add(...).play()` with `onUpdate`/completion clearing it). When `pulse`, render the focused border with the `theme.warning` accent; else `theme.focus`. (Only real theme tokens — `focus`, `warning`, `secondary`, `error`, `compare` — exist; do not invent a `focusBright`.) Keep all timeline calls inside effects so SSR/test render is a no-op.
- In `artifact-preview.tsx`: same pattern keyed on `artifactIndex`, pulsing the header `<text color>`.
- Guard: if `useTimeline` is unavailable at runtime, wrap in try or feature-check so the view still renders static colors. (Theme already handles `16`-color downgrade for the color value itself.)

- [ ] **Step 4: Run both view suites**

Run: `bun test src/tui/views/detail.test.tsx src/tui/views/artifact-preview.test.tsx 2>&1 | tail -20`
Expected: PASS (no throw; static-color baseline still asserted).

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/detail.tsx src/tui/views/artifact-preview.tsx src/tui/views/detail.test.tsx
git commit -m "feat(tui): focus-change accent pulse for detail + artifact (#192)"
```

---

## Task 10: Full verification + cleanup

- [ ] **Step 1: Delete the probe**

```bash
git rm src/tui/opentui-probe.test.tsx
```

- [ ] **Step 2: Typecheck, lint, full test, build**

Run:
```bash
bun run typecheck 2>&1 | tail -20
bun run lint 2>&1 | tail -20
bun test 2>&1 | tail -30
bun run build 2>&1 | tail -10
```
Expected: all clean; no new failures vs baseline.

- [ ] **Step 3: TUI smoke (visual confirmation of the two runtime behaviors)**

Per memory feedback (use `grove up`, real run — not in-process): launch the TUI, open a contribution detail, press `j`/`k` to confirm section focus moves + scrolls into view + pulses; open an artifact with a parent, press `d` then `s` to confirm diff renders and toggles inline↔split. Capture the observed result (works / fallback path taken). If a runtime behavior differs from Task 0's probe, apply the documented fallback and re-run Step 2.

- [ ] **Step 4: Commit cleanup + open PR**

```bash
git add -A
git commit -m "chore(tui): remove #192 probe; finalize detail+artifact upgrade"
git push -u origin feat/tui-192-detail-artifact-opentui
gh pr create --fill --base main
```

---

## Self-review notes

- **Spec coverage:** scrollable detail → Task 8; obvious focus/selection → Tasks 2/4/8 (border+marker) ; diff rendering → Task 7; split/inline toggle → Tasks 1/3/7; transitions → Task 9; "native to OpenTUI" → `<scrollbox>`/`<diff>`/`useTimeline` across 7–9. All four acceptance criteria mapped.
- **Runtime unknowns** isolated to Task 0 with explicit fallbacks consumed in Tasks 7 (`INLINE_DIFF`) and 8 (`SCROLLBOX_SCROLL`).
- **Type consistency:** prop names `focusedSectionRaw` (detail) and `diffMode` (artifact), state `detailFocusedSection`/`artifactDiffMode`, callbacks `onDetailSectionNext/Prev`/`onArtifactDiffModeToggle`, actions `DETAIL_SECTION_NEXT/PREV/RESET`/`ARTIFACT_DIFF_MODE_TOGGLE` — used consistently across Tasks 1–8.
- **No silent truncation** preserved as a spec invariant in Task 8 (full content or visible marker only).
