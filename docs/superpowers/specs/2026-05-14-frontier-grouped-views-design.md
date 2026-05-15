# Frontier — Grouped Navigable Ranking Views

**Date:** 2026-05-14
**Issue:** [windoliver/grove#187](https://github.com/windoliver/grove/issues/187)
**Status:** Approved (brainstorming → planning)

## Problem

The frontier is one of Grove's most differentiated concepts — multi-signal ranking
of contributions across `adoption`, `recency`, `review`, `reproduction`, and any
number of user-defined `metric:*` scores. The current TUI in
`src/tui/views/frontier-view.tsx` flattens every dimension into one long table
with section headers, navigated by a single global cursor. Operators have to
mentally re-group the dump to compare signals, and the rendering does not explain
**why** any given entry is winning. The "compare/adopt" flow exists in skeleton
form (`onCompareAdopt` shows a toast — no spawn).

## Goals

1. Make each ranking dimension a first-class navigable slice rather than a
   sub-section of one flat table.
2. Surface **why** an entry wins its slice (signal-specific badge + signal
   description in the slice header).
3. Wire `adopt` into the real spawn path so the frontier becomes the launchpad
   for "build on this contribution."
4. Empty / loading states teach the frontier concept.

## Non-goals

- Changing the server-side `Frontier` shape or the calculator
  (`src/core/frontier.ts` is unchanged).
- Changing the `getFrontier` fetch path, race guard, or Contribution-event
  refresh debounce.
- Multi-side compare (more than 2). Two-side compare stays as-is.
- Filter-within-slice (by tag / agent / kind). Tab-switching is the only
  filter affordance in this iteration.

## Architecture

`frontier-view.tsx` today owns fetch, projection, grouping, cursor math, and
rendering. We split it into focused units so each file has one responsibility
and is testable in isolation.

```
frontier-view.tsx          orchestrator: fetch + tab state + cursor restore
  ├── frontier-slices.ts        pure: Frontier → FrontierSlice[]
  ├── frontier-tab-bar.tsx      presentational: tab strip with overflow
  ├── frontier-overview.tsx     presentational: top-3 mini-leaderboards
  └── frontier-slice-table.tsx  presentational: ranked table + badges
```

Adopt wiring lives in `app.tsx` next to existing `onCompareAdopt`. Frontier
view emits `(cid, summary)` and intent; spawn flow is unchanged plumbing.

### Components

- **`frontier-view.tsx`** — owns Frontier fetch (unchanged), tab state, cursor
  map (`Map<sliceKey, number>`), and orchestrates child components. Only file
  in this set that talks to `provider`.
- **`frontier-slices.ts`** (new, pure) — exports
  `toSlices(frontier: Frontier): readonly FrontierSlice[]` and
  `slicesEqual(a, b): boolean`. A `FrontierSlice` is
  `{key: string; label: string; signalDescription: string; entries:
  readonly FrontierEntry[]; formatBadge: (e: FrontierEntry) => string}`.
- **`frontier-tab-bar.tsx`** (new) — renders tab strip, applies highlight to
  active tab, computes overflow window so the active tab is always visible,
  shows `+N` indicator for hidden tabs.
- **`frontier-overview.tsx`** (new) — renders top-3 per non-empty slice as
  mini-leaderboards. Read-only (no cursor); operator switches to a specific
  slice via `[` / `]` (see "Slice navigation keys" below).
- **`frontier-slice-table.tsx`** (new) — renders a single slice: header line
  with `signalDescription`, ranked table with columns
  `RANK | CID | VALUE | SIGNAL | SUMMARY`. SIGNAL column is the per-signal
  badge from `formatBadge`. Receives compare/cursor props; emits
  `onCompareSelect`, `onAdopt`.

### Data flow

- **Fetch:** unchanged. `useEventDrivenData(getFrontier)` + Contribution-event
  coalesced refresh + race guard (`latestFetchRef`) all preserved verbatim.
- **Projection:** `toSlices(data)` runs through `useDerived(["Contribution"],
  slicesEqual)` for memoization. Pure function makes equality cheap.
- **Tab state:** `useState<string>` initialized to `"overview"`. Persisted via
  the existing `saveState` mechanism (same pattern as
  `panels.state.focused`). On every Frontier reshape, an effect validates the
  saved key still maps to a present slice; if not, falls back to `"overview"`.
- **Cursor:** `Map<sliceKey, number>` lives in the orchestrator. Switching
  tabs restores that slice's last cursor position. The existing
  `onFrontierCidsChanged(cids)` parent callback emits the **active slice's**
  cids only, so the app-level keyboard handler resolves cursor → cid against
  the right list with no other changes.
- **Compare:** state stays in `app.tsx` (`ks.compareCids`). Frontier view does
  not own it. Compare selections persist across tab switches.

### Slice ordering

Built-ins first in fixed order: `adoption, recency, review, reproduction`.
Then `metric:*` slices in alphabetical order by metric name. Overview tab is
always first.

### Signal descriptions (header text)

- `overview` — `"Top contributions across all ranking signals"`
- `adoption` — `"Adoption — unique downstream uses (derives_from + adopts)"`
- `recency` — `"Recency — most recent contributions"`
- `review` — `"Review — highest average review scores"`
- `reproduction` — `"Reproduction — most-reproduced contributions"`
- `metric:<name>` — `"<name> — <maximize|minimize> per-contribution score"`

### Badge formatters (`formatBadge`)

- `adoption` → `×N adopters`
- `recency` → reuse existing `formatValue` relative time (e.g. `2h ago`)
- `review` → `4.7⋆` — value rounded to one decimal. Reviewer count is **not**
  in the current `FrontierEntry` shape (`{cid, summary, value,
  contribution?}`); adding it requires a server change, which is out of
  scope for this iteration. If a future change exposes reviewer count, the
  badge upgrades to `4.7⋆ (n=3)` with no other code change required.
- `reproduction` → `▲N confirmed`
- `metric:*` → `0.81 <metric>` — value to 3 decimals + metric name

### Adopt wiring

The existing `CommandPalette` already lists per-role `kind: "spawn"` items
(see `src/tui/components/command-palette.tsx`). Adopt reuses that surface
rather than introducing a separate prompt.

- New keyboard action `onFrontierAdopt(cid, summary)` registered in
  `use-keyboard-handler.ts`. Bound to `a` when focused panel is `Frontier`,
  not in compare mode, and cursor is on a row.
- Action records `{adoptTarget: cid, adoptSummary: summary}` into a new
  app-level state slot (`adoptContext`) and opens the command palette via
  `panels.setMode(InputMode.CommandPalette)`. Palette title gets a chip
  `"Adopt: {short cid}"` while `adoptContext` is set so the operator sees
  the implied target.
- The palette's existing spawn handler reads `adoptContext` (when set) and
  threads it into `spawnManager.spawn(roleId, command, parentAgentId, depth,
  {adoptTarget, adoptSummary})`. The same context appears in the spawned
  agent's `CLAUDE.md` (via `spawnManager.setSessionGoal`-equivalent helper)
  so the agent knows what to adopt.
- `adoptContext` is cleared on palette dismiss (Esc) or after a successful
  spawn.
- Existing `onCompareAdopt(side)` is rewired to set `adoptContext` from
  `compareCids[side]` and open the palette — same code path as the
  single-row adopt. The toast-only placeholder is removed.

If the spawn-manager surface lacks a hook to receive `{adoptTarget,
adoptSummary}` (current `spawn(...)` signature accepts an opaque `context`
object — confirmed at `src/tui/spawn-manager.ts:660`), the planning step
adds a typed pass-through. No spawn-manager logic change is required beyond
forwarding the context to the agent runtime.

## Error handling, empty, loading

- **Loading** (`!data`): tab bar disabled; body shows `"Loading frontier..."`.
  Tab keys ignored.
- **Error** (`error && !data`): tab bar disabled; body shows error message +
  `"r: refresh"` hint. DataStatus chip in header surfaces stale/error as
  today.
- **Empty Frontier** (data present, all slices empty): single full-panel
  `EmptyState` (no tabs):
  `"Frontier ranks the best contributions across 5+ signals."` + bullet list
  of signal names + `"Spawn agents with Ctrl+P to begin."`
- **Per-slice empty** (Frontier has data, active slice empty): slice-specific
  hint, e.g. `"adoption — no contributions have been adopted yet"`. Tab is
  still selectable; row count = 0.
- **Overview tab partial empty:** omit zero-entry slices from the
  mini-leaderboards. If all slices are empty, fall back to the full
  empty-Frontier state.
- **Tab overflow:** show first-N + `+M` indicator. Active tab is always
  visible — if scrolled out, the visible window shifts. `]` / `Right` while
  on the rightmost visible tab scrolls the window forward.
- **Saved tab key invalid** (metric removed between sessions): silently fall
  back to `"overview"`. Surface via `showError` only if the lost key was a
  user-defined metric (operator-relevant).
- **Adopt failure:** spawn rejection routes through `showError` (5s
  auto-clear). No special UI in the frontier view.
- **Compare + adopt:** `a` is suppressed when compare mode is active.
  Operator must `Esc` out of compare before adopting from a row. The
  compare-mode equivalent (`a`/`b` for the two selected sides) keeps
  working and now spawns instead of toasting.

## Testing

### Unit (pure)

- `frontier-slices.test.ts`
  - `toSlices(frontier)` produces correct slice array.
  - Built-in ordering is stable; metric slices alphabetical.
  - `formatBadge` per signal produces expected strings (table-driven).
  - Empty frontier → empty slices.
  - Missing dimensions skipped, never null.
- `frontier-slices.equals.test.ts`
  - `slicesEqual` returns true for identical content (including across
    different object references).
  - Returns false for any value / cid / order / count / badge delta.

### Component

- Tab bar renders one tab per non-empty slice + Overview.
- Active tab uses theme highlight; others use default.
- Overflow indicator appears past width threshold; active tab forced visible.
- `]` / `[` cycle slices forward/backward (vim-style next-tab). Tab and
  digits 1-9 are deliberately NOT used — they remain bound to global panel
  cycling and panel focus respectively, so a keyboard-only operator can
  always leave the Frontier panel.
- Slice switch resets the global cursor to row 0 (per-slice cursor memory
  is YAGNI for the first ship). Without this, a long→short slice switch
  would leave the cursor off-row and silently disable adopt/compare.
- `onFrontierCidsChanged` fires with the active slice's cids only.
- Overview tab: shows top-3 per non-empty slice; operator switches to a
  specific slice via `]` / `[` then acts on rows there.
- Per-slice empty: shows signal-specific hint, not generic empty.
- Full empty Frontier: shows teaching empty state with all signal names.
- Loading: tab bar disabled, no crash on tab keys.
- Saved tab key for removed metric → falls back to overview.
- Compare mode + tab switch: selection persists across tabs.
- Compare mode + `a`: key suppressed (logs no spawn).

### Integration

- `frontier-adopt.integration.test.ts`
  - Pressing `a` on a row sets `adoptContext` and opens the command palette.
  - Palette title shows the `"Adopt: {short cid}"` chip when context is set.
  - Selecting any spawn item calls mocked `spawnManager.spawn` with
    `context.adoptTarget = cid` and `context.adoptSummary = summary`.
  - Esc clears `adoptContext`.
  - `onCompareAdopt('a' | 'b')` resolves the side from `compareCids` and
    routes through the same code path.

### Regression

- `flatRowsEqual` test → replaced by `slicesEqual` test; old test removed.
- `dashboard.test.ts` (consumes `frontierSummary.topByAdoption` via
  `provider-utils`) — unaffected; that path is not touched.
- The `latestFetchRef` race-guard test — preserved verbatim; fetch logic is
  untouched.

### Manual smoke

- Run TUI with seeded contributions exercising every signal.
- Verify tab cycle, Overview rendering, per-slice empty hints.
- Verify adopt: `a` opens palette → submit → spawn dialog appears → child
  agent created with `adoptTarget` in context.
- Switch sessions; confirm Frontier reshapes and active tab key validates
  against new slices.

## Out of scope (follow-up issues)

- Filter-within-slice by tag / agent / kind.
- Multi-side compare (>2).
- Server-side reviewer count / score breakdown if needed for richer badges.
- Configurable badge formatters per metric (currently fixed templates).

## Acceptance criteria mapping

| Criterion (issue #187)                                         | Addressed by                                       |
| -------------------------------------------------------------- | -------------------------------------------------- |
| Inspect frontier results by signal without re-grouping         | Tabs + Overview                                    |
| Compare/adopt flows are natural                                | Adopt wired to spawn; compare unchanged + working  |
| Empty / loading states teach the frontier concept              | Full-empty teaching state; per-slice signal hints  |
| Rendering highlights what is winning and why                   | Signal description header + per-signal badge       |
| Group frontier entries by ranking dimension                    | One slice per dimension                            |
| Support switching/filtering between frontier slices            | `]` / `[` slice cycle (Tab/digits reserved for global panel nav)  |
| Improve comparison workflows from the frontier                 | Compare selection persists across slices           |
| Add stronger summaries so operators understand why             | `formatBadge` per slice + signal description       |
