# TUI #192 — Lean detail + artifact into OpenTUI rich components

**Issue:** [windoliver/grove#192](https://github.com/windoliver/grove/issues/192)
**Date:** 2026-05-28
**Scope decision:** Focused first cycle — `detail.tsx` + `artifact-preview.tsx` only. One PR. No other surfaces; no terminal-rendering swap. Remaining surfaces (dag, dashboard, lists, terminal) are out of scope and become follow-up issues.

## Problem

Grove uses OpenTUI but several surfaces still behave like a manually managed table dashboard. The two highest value-per-effort, lowest-risk surfaces:

- **`detail.tsx`** — a flat stack of `<box>`/`<text>` with no scrolling, no focus/selection state, and silent `.slice()` truncation of long content (`description.slice(0,500)`, ancestor/child summaries `.slice(0,50)`, context `.slice(0,300)`).
- **`artifact-preview.tsx`** — already uses `<scrollbox>`/`<markdown>`/`<code>`, but its diff path hand-rolls an LCS unified diff (`computeUnifiedDiff`, ~50 lines) rendered as uncolored plain text, ignoring OpenTUI's `<diff>` intrinsic that the codebase already wraps in `SplitDiff`.

## Goals (from issue acceptance criteria, scoped)

- Detail and artifact surfaces are easier to inspect in-terminal.
- Focus and selection states are consistently obvious.
- High-value transitions improve orientation instead of adding noise.
- These two surfaces feel native to the OpenTUI stack.

## Non-goals

- Changes to `terminal.tsx`, `dag.tsx`, `dashboard.tsx`, lists, or other views.
- Replacing the manual xterm cell-rendering with `ghostty-opentui`.
- Any provider/server changes. This is pure TUI render + local UI state.

## Architecture context

Keyboard input is centralized: `use-keyboard-handler.ts` maps keys → named actions (e.g. `artifact_prev`, `artifact_next`, `artifact_diff`, `terminal_scroll_up`). UI/nav state (`showArtifactDiff`, `artifactIndex`, scroll offsets) lives in `use-navigation` and flows as props through `panel-manager.tsx` into the views. New interactions therefore follow a fixed pattern: **new nav state → new action in the keyboard handler → new prop into the view.** This design adds nothing outside that pattern.

OpenTUI primitives relied on (all already present in the codebase): `<scrollbox>`, `<diff>` (via `SplitDiff`), `useTimeline` (declared in `opentui.d.ts`), and theme color-depth resolution (`truecolor`/`256`/`16`).

## Design

### 1. `detail.tsx` — scrollable, focus-aware surface

- Wrap the body in `<scrollbox flexGrow={1}>`.
- **Remove all `.slice()` truncations.** Full content (description, ancestor/child summaries, context JSON) becomes reachable via scroll rather than silently cut. Existing large-content caps that exist for *render-stall protection* (not present in detail today) are not introduced here; if a stall is observed during implementation, a generous cap is added with a visible "truncated" marker — never a silent cut.
- Treat the existing blocks as an ordered list of **focusable sections**: Summary, Scores, Relations, Artifacts, Ancestors, Children, Discussion, Context. Sections with no data are **skipped in the focus ring** (you cannot focus an absent "Scores").
- A new `focusedSection` index (nav state, passed as a prop) drives:
  - an accent border + `>` marker on the focused section, using `theme.focus`;
  - **scroll-into-view**: the scrollbox scroll position is set so the focused section is visible.
- `j`/`k` and arrow keys move `focusedSection` when the Detail panel is focused. New actions `detail_section_next` / `detail_section_prev` in `use-keyboard-handler.ts`, mirroring the existing `artifact_prev`/`artifact_next` wiring. Focus index wraps at the ends.

### 2. `artifact-preview.tsx` — real diff rendering

- **Delete** `computeUnifiedDiff` and its LCS table (~50 lines) — *contingent* on the `<diff mode="inline">` verification below passing. If inline mode is unavailable, `computeUnifiedDiff` is retained solely to feed the `<code language="diff">` inline fallback.
- Replace the diff branch with the `<diff>` intrinsic:
  - `diffMode === "inline"` → `<diff mode="inline" oldContent newContent />`
  - `diffMode === "split"` → the existing `SplitDiff` component (which renders `<diff mode="split">` with labeled panes).
  - The existing diff fetcher already returns `{ parentText, childText }`, which feed `oldContent`/`newContent` directly.
- New `diffMode: "inline" | "split"` (default `"inline"`; inline fits narrow panes).
- Keep the existing `[d]` toggle for diff on/off. Add `[s]` to flip split/inline. New action `artifact_diff_mode`, new nav state `artifactDiffMode`, new `diffMode` prop. Header reflects state: `[d]iff` and `[s]plit`/`inline`.

### 3. Minimal transition

- A single `useTimeline` accent pulse (~150ms ease) on:
  - the focused section's border in detail when `focusedSection` changes, and
  - the artifact header when `artifactIndex` changes.
- No slide/scroll animation. Degrades to static color on `16`-color terminals (theme already resolves color depth at load).

## Components / boundaries

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `detail.tsx` | Render contribution detail; accept `focusedSection`; manage scroll-into-view + pulse | `<scrollbox>`, `useTimeline`, theme |
| `artifact-preview.tsx` | Render artifact content; render diff via `<diff>`/`SplitDiff` per `diffMode` | `SplitDiff`, `<diff>`, theme |
| `use-keyboard-handler.ts` | Map `j/k` (detail), `s` (artifact) to new actions | existing action dispatch |
| `use-navigation` | Hold `focusedSection`, `artifactDiffMode` | — |
| `panel-manager.tsx` | Thread new state into views as props | above |

## Testing (TDD)

- **detail:** focus ring skips empty sections; `j`/`k` advance and wrap; truncation removed (assert full text present, not the old capped length); focused section carries the accent marker.
- **artifact:** `diffMode` selects `<diff mode="inline">` vs `SplitDiff`; `[s]` toggles `artifactDiffMode`; removing `computeUnifiedDiff` does not break the no-parent / diff-off / no-diff-data paths.
- **keyboard-handler:** unit tests for `detail_section_next`, `detail_section_prev`, `artifact_diff_mode`, following existing `artifact_*` test patterns.
- All changes via test-first. The two runtime unknowns below are resolved by a failing test before relying on them.

## Risks / open verifications

- **Scrollbox scroll-into-view API.** If OpenTUI's `<scrollbox>` exposes no controllable scroll position, fallback is manual windowing — slice the visible sections around `focusedSection`. Decided during the first TDD step, not assumed.
- **`<diff mode="inline">` prop.** `SplitDiff` proves `mode="split"` works; confirm `"inline"` is a valid mode before relying on it. If not, inline falls back to `<code language="diff">` over the computed unified text (kept only for that fallback).
- Low overall risk: no server/provider changes, no other surfaces touched.
