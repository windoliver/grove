# TUI Plugin Extensibility Design

## Issue

GitHub issue: https://github.com/windoliver/grove/issues/189

Grove's TUI should let teams add workflow-specific operator panels and command
palette actions without editing the core TUI for each workflow. The first
plugin surface is trusted local code. It does not load arbitrary remote modules,
does not read plugin paths from config, and does not grant plugins special
filesystem or process authority beyond what their own JavaScript code already
has in the local process.

## Goals

- Let local or third-party code register at least one custom panel.
- Let local or third-party code register at least one custom command palette
  action.
- Keep built-in panel and palette behavior unchanged when no extensions are
  provided.
- Make registrations data-driven, deterministic, and testable.
- Document the safety and compatibility contract for extension authors.

## Non-Goals

- Runtime plugin discovery from config or package manifests.
- Remote plugin loading.
- Sandbox enforcement inside the TUI process.
- A marketplace or plugin packaging format.
- Replacing provider capability checks with plugin-specific provider types.

## Architecture

The TUI receives an optional list of trusted `TuiExtension` objects from its
caller. Each extension can contribute panel registrations and command action
registrations. Grove merges these registrations with built-in entries through
pure registry helpers that validate IDs, reject duplicates, apply stable
ordering, and return diagnostics for invalid plugin entries.

The rendering and palette layers consume the merged registries. Built-in entries
continue to route to existing core components and handlers. Plugin panel entries
render their registered React component with a constrained `TuiPluginContext`.
Plugin action entries render as command palette items and execute their
registered callback with the same constrained context.

## Public Contracts

### TuiExtension

`TuiExtension` is the bundle a trusted local plugin provides:

- `id`: stable lowercase extension ID.
- `name`: display name for diagnostics and documentation.
- `version`: semantic version string supplied by the extension.
- `panels`: optional `readonly TuiPanelRegistration[]`.
- `actions`: optional `readonly TuiActionRegistration[]`.

The extension object is plain data plus local callback/component references. It
is passed directly to the TUI by application code or tests.

### TuiPanelRegistration

Existing panel registration remains the panel contract:

- `id`: stable lowercase panel ID matching Grove's safe ID pattern.
- `label`: display label.
- `slot`: initially `operator-panel` for rendered panels.
- `defaultVisible`: whether the panel should be visible on first render.
- `order`: optional sort key, defaulting after built-ins.
- `component`: React component receiving `TuiPluginContext`.

Plugin panels are operator panels. They are not added to the numeric `Panel`
enum. This avoids expanding keyboard focus state for every local extension and
keeps built-in keyboard shortcuts stable. Plugin panels are rendered after
built-ins in registry order and participate in row grouping through plugin
registry metadata, not through the built-in enum.

### TuiActionRegistration

Command palette action registrations use a separate action contract:

- `id`: stable lowercase action ID.
- `label`: command palette label.
- `detail`: short detail text for the palette's right-hand metadata.
- `order`: optional sort key, defaulting after built-ins.
- `enabled`: optional predicate receiving `TuiPluginContext`.
- `run`: callback receiving `TuiPluginContext` and returning `void` or
  `Promise<void>`.

The palette treats disabled plugin actions like disabled built-in entries:
visible, dimmed, and not executable from Enter.

### TuiPluginContext

Plugins receive a narrow read/action context:

- `provider`
- `topology`
- `selectedSession`
- `selectedCid`
- `density`
- `showMessage(message: string)`

The context intentionally excludes raw reducer dispatch, panel state mutation,
tmux manager internals, renderer lifecycle, and direct access to core palette
handlers. Future fields can be added in a backward-compatible way.

## Registry Behavior

The existing `src/tui/plugins/registry.ts` becomes the shared home for panel and
action merge helpers.

Panel behavior:

- Built-in panel entries are validated first.
- Plugin panel entries with invalid IDs are skipped with diagnostics.
- Plugin panel entries that duplicate built-ins or earlier plugin entries are
  skipped with diagnostics.
- Entries sort by `order`, then source rank, then ID.

Action behavior:

- Built-in action entries are validated first.
- Plugin action entries use the same ID validation and duplicate handling.
- Built-in actions keep their current ordering.
- Plugin actions default to order `1000`.

Diagnostics are returned to the caller instead of thrown for plugin mistakes.
Invalid built-in entries still throw, because those are programmer errors in
core code.

## Panel Rendering Flow

`PanelManager` receives optional merged panel registry entries. When no entries
are provided, it uses the built-in registry and renders the exact current TUI.

For built-in entries, `PanelManager` renders the existing switch-based panel
views. For plugin entries, it renders the registered component inside standard
panel chrome:

1. Build the current `TuiPluginContext`.
2. Select visible entries from merged registry entries.
3. Keep built-in visibility driven by existing `PanelFocusState`.
4. Render plugin panels whose registration has `defaultVisible: true` or whose
   visibility is enabled by future extension state.
5. Wrap plugin panel content in the same title/focus chrome used by built-ins.

The first implementation only guarantees default-visible plugin panels. Toggling
arbitrary plugin panels from keyboard shortcuts is deferred until the built-in
focus state is generalized from numeric enum values to stable string IDs.

## Command Palette Flow

Built-in palette items keep their current spawn, kill, register, delegate, and
goal behavior. A new action registry layer converts plugin actions into palette
items with kind `plugin-action`.

Execution flow:

1. `App` builds the current `TuiPluginContext`.
2. `buildPaletteItems` includes built-in items and plugin action items.
3. Fuzzy filtering and selection continue to operate on one item list.
4. Enter on a built-in item follows the existing handler.
5. Enter on a plugin action checks `enabled`, calls `run(context)`, catches
   errors, and reports failures through `showMessage`.
6. The palette closes and resets after a successful or failed plugin action,
   matching built-in action behavior.

## Error Handling

- Invalid plugin IDs are skipped with diagnostics.
- Duplicate plugin IDs are skipped with diagnostics.
- Plugin panel render failures are contained by React's existing render path as
  much as the current TUI supports; the plugin contract documents that plugin
  code is trusted and can still crash the local process.
- Plugin action failures are caught and shown through `showMessage`.
- A bad extension cannot remove or replace built-in panels/actions by using the
  same ID.

## Safety and Compatibility

This is a trusted local-code extension model. Grove does not claim to sandbox
plugin code. Safety comes from the limited TUI contract, deterministic registry
validation, and preserving built-in behavior when plugins are invalid or absent.

Compatibility expectations:

- Built-in IDs are stable.
- Plugin IDs must be stable and lowercase.
- Optional fields can be added to `TuiPluginContext`.
- Existing context fields will not be repurposed incompatibly without a major
  compatibility note.
- Plugin registration diagnostics are part of the testable contract.

## Testing Plan

- Extend registry tests for action registration ordering, duplicate rejection,
  unsafe IDs, and invalid order diagnostics.
- Add panel registry or panel manager tests proving plugin panel entries can be
  merged and rendered without modifying built-in panel definitions.
- Add command palette tests proving plugin action items appear, filter through
  existing fuzzy search, respect disabled state, and execute through the plugin
  callback.
- Add app-level focused tests where practical for palette selection of a plugin
  action.
- Run `bun run typecheck`.
- Run focused TUI tests with coverage disabled where config coverage thresholds
  make partial test runs exit nonzero despite passing test cases.
- Run `bun run check` before final delivery.

## Documentation Plan

Add a TUI extensions guide under `docs/tui/` that shows:

- How to define a trusted local extension.
- How to register a default-visible custom panel.
- How to register a custom command palette action.
- What the plugin context contains.
- What Grove does not sandbox.
- Compatibility expectations for IDs, ordering, and future context fields.

## Acceptance Mapping

- Third-party or local extensions can register at least one custom panel and one
  custom action through `TuiExtension`.
- Core TUI source does not need workflow-specific edits after the registration
  surface is wired.
- Extension boundaries are documented in `docs/tui/`.
- Registry and palette behavior are covered by focused tests.
- Baseline stability is preserved by duplicate rejection, invalid ID diagnostics,
  and built-in-first merge behavior.
