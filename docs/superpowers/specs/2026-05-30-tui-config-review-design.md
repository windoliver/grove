# TUI Session Config Review Screen — Design

**Issue:** [#201](https://github.com/windoliver/grove/issues/201) — feat: TUI session config screen
**Date:** 2026-05-30
**Depends on:** #198 (session records store full config), #199 (PolicyEnforcer reads config from session), #200 (GROVE.md optional) — all merged.

## Goal

Add a config review/edit screen between preset selection and goal input so an operator
can tweak a session's resolved config before launching — not just pick a preset. The
screen shows the config resolved from the chosen preset and lets the operator edit a
focused set of scalar/enum fields. Everything else is shown read-only.

## Scope

**Editable (v1, "Tasks-faithful"):**
- **Mode** — `evaluation ⇄ exploration` toggle.
- **Stop conditions (numeric thresholds)** — `maxRoundsWithoutImprovement`,
  `budget.maxContributions`, `budget.maxWallClockSeconds`, and `targetMetric.value`
  (only when a target metric is defined).
- **Concurrency** — `maxActiveClaims`, `maxClaimsPerAgent`.

**Read-only summaries:**
- Topology — role names + edge count (one line).
- Metrics — `name (direction, gate)` list.
- Gates — `type → target` list.
- `quorumReviewScore` / `deliberationLimit` stop conditions (shown if present).
- Concurrency `maxClaimsPerTarget` (fixed at 1 — not rendered).

**Non-goals (explicitly out of scope):**
- Full visual topology editor.
- Defining metrics from scratch; editing the metrics map.
- Adding/removing gates (deferred — the issue's prose mentioned it, but the Tasks
  checklist and non-goals narrow v1 to scalar/enum edits).
- Editing execution / rate-limit / retry / gossip / hooks / admission sections.

## Flow & Routing

New screen `config-review` inserted per the issue's ordering:

```
preset-select → config-review → goal-input → launch-preview → spawning → running → complete
```

- Add `"config-review"` to the `Screen` union (`src/tui/screens/screen-manager.tsx`) and to
  `PageKind` (`src/tui/data/pages-store.ts`).
- `handlePresetSelect` (in `screen-manager.tsx`) changes: after setting `selectedPreset`
  and the baseline topology, resolve the **baseline contract for the selected preset** via
  `presetToSessionConfig(getPreset(name), name)` (from `src/cli/presets/index.js`) rather
  than reusing the boot-time `appProps.contract` (which reflects the *previous* grove.json
  preset). Store the result as `state.editedConfig` and `pages.push({ kind: "config-review" })`.
- **Bypass rule:** if the selected preset resolves to no contract *and* `appProps.contract`
  is also undefined (possible on some remote/nexus backends where the contract probe
  returns nothing), skip `config-review` and go straight to `goal-input` — there is nothing
  to edit. This is the data-level "use defaults / optional screen" escape hatch.

## Component — `src/tui/screens/config-review.tsx`

Reuses the `agent-detect.tsx` interaction model (cursor list + inline edit buffer). Renders
three zones:

1. **Editable field list** (navigable cursor): Mode, then the present stop-condition
   scalars, then concurrency scalars.
2. **Read-only summaries:** topology, metrics, gates.
3. **Hint bar:** active keybindings.

### Keybindings

| Key | Action |
| --- | --- |
| `j` / `k` / ↑ / ↓ | Move cursor between editable fields |
| `e` | Edit focused scalar field (enters inline edit mode) |
| `space` | Toggle the Mode enum (when Mode is focused) |
| `d` | Reset all edits back to preset defaults |
| `Enter` (not editing) | Confirm & continue → `goal-input` |
| `Esc` (not editing) | Back → `preset-select` |
| digits / backspace | (in edit mode) modify the numeric buffer |
| `Enter` (editing) | Commit the field |
| `Esc` (editing) | Cancel just this field's edit |

`Enter` is dual-meaning — it commits the focused field while editing, and confirms the
screen otherwise — matching the existing `goal-input` / `agent-detect` convention. Scalar
edit mode is entered only with `e` (not `Enter`), so `Enter` is unambiguously "confirm
screen" at the list level.

## State & Persistence

- `ScreenState` gains `editedConfig?: GroveContract | undefined`.
- ConfigReview is a controlled-ish screen: it receives the baseline `config` and the
  read-only `topology`, holds a working draft in local state, and emits
  `onConfirm(updatedConfig: GroveContract)` and `onBack()`.
- `handleConfigReviewConfirm(updatedConfig)` → `setState({ editedConfig: updatedConfig,
  screen: "goal-input" })` + `pages.push({ kind: "goal-input" })`.
- `handleConfigReviewBack` → `pages.pop()` (returns to `preset-select`).
- `spawnAgents` (`screen-manager.tsx` ~line 682): build `sessionConfig` from
  `state.editedConfig ?? contract` instead of `contract`. The existing
  `provider.createSession({ goal, presetName, topology, config })` path already persists the
  config into the session record (#198) — no store changes required.
- Component map in `screen-manager.tsx` gains a `config-review` entry wiring the component
  to `topology`, `state.editedConfig`, and the two handlers.

## Validation & Error Handling

- **Per-field commit** validates against the Zod bounds defined in `src/core/contract.ts`:
  - `concurrency.maxActiveClaims`: int 1–1000
  - `concurrency.maxClaimsPerAgent`: int 0–100
  - `stopConditions.maxRoundsWithoutImprovement`: int 1–1000
  - `budget.maxContributions`: int ≥ 1
  - `budget.maxWallClockSeconds`: int ≥ 1
  - `targetMetric.value`: number (no bound)

  Bounds are mirrored as named constants in the component with a
  `// keep in sync with src/core/contract.ts` comment. Invalid input shows an inline error
  and remains in edit mode (does not commit).
- **Unset semantics:** clearing a numeric field to empty unsets that optional field. If
  **both** budget fields are cleared, the `budget` object is dropped entirely (its Zod
  `refine` requires at least one of the two) so an invalid empty budget is never emitted.
- **No new cross-field hazards:** execution / rate-limit / gossip constraints are not
  editable here, so their cross-field validations cannot be newly violated.

## Testing

- **Component test** (`config-review.test.tsx`): render with a representative contract, drive
  key events — navigate, edit a numeric field (valid + out-of-range), toggle mode, `d` reset,
  `Enter` confirm — and assert: the `onConfirm` payload reflects edits, out-of-range input is
  rejected (no commit, error shown), clearing both budget fields drops `budget`. Follows the
  existing TUI screen-test harness.
- **Flow test** (extends `screen-manager` tests): assert the transition
  `preset-select → config-review → goal-input`, and that an edited contract reaches
  `createSession` via `spawnAgents`.
- **Manual TUI smoke:** `grove up` → pick preset → edit a stop-condition threshold → confirm
  → verify the edited value lands in the session record (consistent with the project's
  E2E-first validation practice; manual smoke is tracked as a follow-up, not auto-run).

## Files Touched

| File | Change |
| --- | --- |
| `src/tui/screens/config-review.tsx` | **New** screen component |
| `src/tui/screens/screen-manager.tsx` | `Screen` union, `editedConfig` state, `handlePresetSelect` rewrite, confirm/back handlers, component-map entry, `spawnAgents` config source |
| `src/tui/data/pages-store.ts` | `PageKind` adds `"config-review"` |
| `src/tui/components/pages-router.tsx` | Route `config-review` (breadcrumb/hints) if router needs an explicit entry |
| `src/tui/screens/config-review.test.tsx` | **New** component test |
| `screen-manager` test file | Flow-transition assertions |
