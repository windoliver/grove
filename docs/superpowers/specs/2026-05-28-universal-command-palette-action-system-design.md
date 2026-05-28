# Universal Command Palette Action System (#194)

**Status:** Approved design — ready for implementation plan
**Issue:** https://github.com/windoliver/grove/issues/194
**Date:** 2026-05-28

## Problem

The TUI command palette is narrower than the actual capability surface. Many
actions still require memorizing keys or navigating to specific panels. Two
incompatible action shapes coexist:

- **Built-in** `PaletteItem` — a discriminated union (`kind`:
  `spawn | kill | register | delegate | goal | plugin-action`) handled by a
  large `switch` inside `onPaletteSelect` in `app.tsx`.
- **Plugin** `TuiActionRegistration` — `{ id, label, detail, enabled?, run(ctx) }`
  executed via `runTuiActionRegistration`.

The issue asks for ONE common model and a universal, searchable, context-sensitive
action surface that is the primary discoverability tool for new operators.

## Goals (acceptance criteria)

- Every major TUI action is reachable from the palette.
- Palette items are searchable (already true via `fuzzyMatch`) — preserved.
- Context-sensitive actions appear only when relevant.
- The palette is the primary discoverability surface.

## Decisions (locked during brainstorming)

1. **Delivery:** design + full implementation on a branch with tests.
2. **Action model:** unify everything on `run(ctx)`. Built-in spawn/kill/goal/etc.
   become `run`-based actions built from live state. The `kind` switch is removed.
3. **Context:** two-tier. A rich internal `ActionContext` for built-ins; the
   existing narrow `TuiPluginContext` stays as a documented subset for plugins.
4. **Relevance:** actions declare `available(ctx)` and are **hidden** when it
   returns false. This is distinct from `enabled(ctx)`, which keeps the item
   visible but **greyed** (e.g. spawn at capacity).
5. **Grouping:** grouped sections (Navigation, Agents, Workflow, Contributions,
   Plugins) when no query; collapse to a flat fuzzy-ranked list when a query is
   active.

## Out of scope (YAGNI)

- A separate jump-to-agent registry (agent IDs derive from session names, so
  jump-to-agent folds into jump-to-session).
- Action history / recents.
- Per-action user-customizable keybindings.

---

## Architecture

### 1. Common action model — `src/tui/actions/types.ts` (new)

```ts
export type ActionGroup =
  | "Navigation"
  | "Agents"
  | "Workflow"
  | "Contributions"
  | "Plugins";

export interface Action {
  /** Stable, unique id, e.g. "nav.panel.terminal", "agent.spawn.reviewer". */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly group: ActionGroup;
  /** Extra fuzzy-match terms beyond the label, e.g. "open" for a focus action. */
  readonly keywords?: readonly string[] | undefined;
  /** Relevance gate. False → item is HIDDEN entirely. Default: visible. */
  readonly available?: ((ctx: ActionContext) => boolean) | undefined;
  /** Capability gate. False → item is shown but GREYED and not executable. */
  readonly enabled?: ((ctx: ActionContext) => boolean) | undefined;
  readonly run: (ctx: ActionContext) => void | Promise<void>;
}
```

`available` and `enabled` are independent: `available` controls presence,
`enabled` controls executability of a present item.

### 2. Two-tier context

**`ActionContext`** (internal, rich) — defined in `src/tui/actions/types.ts`.
Holds closures over app machinery plus read-only state. Capabilities:

- Navigation: `focusPanel(panel)`, `togglePanel(panel)`, `openContribution(cid)`,
  `jumpToSession(session)`.
- Workflow: `enterGoalMode()`, `enterCompareMode()`, `answerPendingQuestion(verdict: "approve" | "deny")`, `registerAgentProfile()`.
- Agents: `spawn(roleId, command, parentAgentId)`, `kill(session)`, `delegate(peerAddress)`.
- Read state: `topology`, `selectedSession`, `selectedCid`, `sessions`,
  `claims`, `profiles`, `gossipPeers`, `pendingQuestionCount`, `hasGoals`,
  `canSpawn`, `canDelegate`, `parentAgentId`.
- `showMessage(msg)`.

**`TuiPluginContext`** — unchanged (`provider`, `topology`, `selectedSession`,
`selectedCid`, `density`, `showMessage`). Plugin blast radius is not widened.

**`pluginAdapter(reg, mkPluginCtx)`** — wraps a `TuiActionRegistration` into an
`Action` with `group: "Plugins"`. Its `available`/`enabled`/`run` build the
narrow `TuiPluginContext` from the rich `ActionContext` before delegating to the
registration's `enabled?`/`run`.

### 3. Built-in action builders — `src/tui/actions/builtin-actions.ts` (new)

A `buildBuiltInActions(ctx-snapshot): readonly Action[]` family (or per-group
builder functions composed into one list). Replaces `buildPaletteItems`.

- **Navigation**
  - For each operator panel that can be shown: a `focus/open panel` action.
    `available` ≈ always; `run` → `togglePanel` (open if hidden) or `focusPanel`
    (focus if already visible). `keywords: ["open", "focus", "go to"]`.
  - `jump to session <s>` per live grove session; `run` → `jumpToSession`.
  - `open contribution` — `available` only when `selectedCid` set; `run` →
    `openContribution(selectedCid)`.
- **Agents**
  - `spawn:<role>` per profile, then topology roles not covered by a profile.
    `enabled` ← capacity check (`checkSpawn`); `run` → `spawn`.
  - `kill:<session>` per live session; `run` → `kill`.
  - `delegate:<peer>` per gossip peer with free slots; `available` ←
    `canDelegate`; `run` → `delegate`.
- **Workflow**
  - `set goal` — `available` ← `hasGoals`; `run` → `enterGoalMode`.
  - `answer pending question` — `available` ← `pendingQuestionCount > 0`; `run`
    → `answerPendingQuestion`.
  - `compare contributions` — `run` → `enterCompareMode`.
  - `register agent profile` — `run` → `registerAgentProfile`.
- **Contributions** (context-sensitive; `available` only when `selectedCid` set)
  - `open`, `adopt`, `add to compare`.

### 4. Rendering — `src/tui/components/command-palette.tsx`

- Input: a unified `readonly Action[]` (built by the parent, single source of
  truth) plus the rich `ActionContext` for evaluating `available`/`enabled`.
- **No query:** filter to `available` items, render a section header per
  non-empty `group` (fixed group order), items beneath. `enabled === false` →
  greyed.
- **Query active:** hide group headers; fuzzy-rank a flat list, matching against
  `label` + `keywords`; render highlighted matches (reuse `renderHighlighted`).
- **Selection index stays flat** across the displayed (available) items in
  group order (no-query) or rank order (query). `paletteIndex`, `paletteItemCount`,
  and the `PALETTE_*` reducer actions are unchanged. Pressing Enter on a
  `enabled === false` item is a no-op (current behaviour preserved).
- `fuzzyMatch` and `renderHighlighted` are retained as-is.

### 5. Wiring — `src/tui/app.tsx`

- Build `actionContext` from existing memoized closures: `handleSpawn`,
  `handleKill`, `handleDelegate`, `panels.focus`/`panels.toggle`,
  `nav.pushDetail`, `setSelectedSession`, goal/compare `dispatch`,
  `handleApproveQuestion`/`handleDenyQuestion`, `showError`. New: a
  `getPendingQuestions` fetcher polled while the palette is visible to populate
  `pendingQuestionCount`.
- Build the action list: `[...buildBuiltInActions(...), ...pluginActions]` where
  `pluginActions` come from `mergedActionRegistry.entries` via `pluginAdapter`.
- `filteredActions` mirrors the palette's displayed order (same fuzzy logic the
  component uses) so Enter executes the visually selected item.
- `onPaletteSelect` collapses to:
  ```ts
  const a = filteredActions[ks.paletteIndex];
  if (!a || !(a.enabled?.(actionContext) ?? true)) return;
  // Close the palette FIRST, then run. Mode-switching actions (set goal,
  // compare) re-set their target input mode from inside run via the context,
  // so their setMode lands after this Normal transition in the same tick.
  panels.setMode(InputMode.Normal);
  dispatch({ type: "PALETTE_RESET" });
  void Promise.resolve(a.run(actionContext))
    .catch((e) => showError(e instanceof Error ? e.message : "Action failed"));
  ```
  Ordering rationale: `enterGoalMode()` dispatches `GOAL_INPUT_MODE` and
  `panels.setMode(InputMode.GoalInput)`; because `run` is invoked after the
  `setMode(Normal)` above, the committed mode is `GoalInput` — matching today's
  goal-action behaviour, where the goal case `return`ed before the generic
  `setMode(Normal)`. Plain actions leave the mode at `Normal`.

### 6. Migration & data flow

- Remove `buildPaletteItems`, `buildPluginPaletteItems`, `PaletteItem`,
  `getBuiltInPaletteActionRegistryEntries`'s `builtInAction` coupling. The
  built-in registry entries (`set-goal`, `register-agent`) are superseded by the
  built-in action builders.
- The existing fetchers (`activeClaims`, `paletteSessions`, `gossipPeers`,
  `agentProfiles`, `hasGoals`, `canSpawn`, `canDelegate`, `paletteParentId`)
  feed the builder snapshot — no new polling except `pendingQuestionCount`.

## Error handling

- `run` is awaited via `Promise.resolve(...).catch(showError)`; failures surface
  in the status bar (5 s auto-clear), same channel as today.
- Disabled items never execute. Hidden (unavailable) items are absent from the
  index space, so selection cannot land on them.
- Scoped-session spawn guard (`activeClaims === null`) is preserved in
  `handleSpawn`; the `spawn` action inherits it.

## Testing

- **Builder catalog** (`builtin-actions.test.ts`): given state snapshots, assert
  which actions are present (`available`) and which are greyed (`enabled`):
  spawn at capacity → present+disabled; `answer pending question` absent when
  `pendingQuestionCount===0`; contribution actions absent when no `selectedCid`;
  delegate absent when `canDelegate===false`.
- **Plugin adapter** (`plugin-adapter.test.ts`): registration → `Action` with
  `group:"Plugins"`; `run` receives a narrow `TuiPluginContext` (no app
  internals leak).
- **Rendering** (`command-palette.test.tsx`): grouped sections with headers when
  no query; flat ranked list with headers hidden when query set; greyed disabled
  items; highlighted matches.
- **Flat-index selection** : displayed-order flattening maps `paletteIndex` to
  the correct `Action` in both grouped and query modes.
- **Reducer** (`app-reducer.test.ts`): `PALETTE_*` transitions unchanged.
- Update existing palette tests that reference `PaletteItem`/`buildPaletteItems`
  to the new model.

## File summary

| File | Change |
|---|---|
| `src/tui/actions/types.ts` | new — `Action`, `ActionGroup`, `ActionContext` |
| `src/tui/actions/builtin-actions.ts` | new — built-in `Action[]` builders |
| `src/tui/actions/plugin-adapter.ts` | new — `TuiActionRegistration` → `Action` |
| `src/tui/components/command-palette.tsx` | grouped/flat render on `Action[]`; drop `PaletteItem`/builders; keep fuzzy + highlight |
| `src/tui/app.tsx` | build `actionContext` + action list; collapse `onPaletteSelect` switch; add `pendingQuestionCount` fetcher |
| `src/tui/plugins/types.ts` | `TuiPluginContext` unchanged (documented subset) |
| tests | new builder/adapter/render/index tests; migrate old palette tests |
