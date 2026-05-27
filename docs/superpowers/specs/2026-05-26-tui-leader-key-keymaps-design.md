# TUI Leader-Key Keymaps - Design

**Issue:** [windoliver/grove#186](https://github.com/windoliver/grove/issues/186)
**Date:** 2026-05-26
**Status:** Approved design

## Problem

The inspect TUI still routes most normal-mode keys through a flat set of direct bindings in `src/tui/hooks/use-keyboard-handler.ts`. Core panels use numbers, operator panels use punctuation from `PANEL_REGISTRY`, and several global or panel-local actions are hard-coded in the router, help overlay, and status bar.

This is hard to scale:

- New panels consume more punctuation keys.
- Help and status text can drift from the actual router.
- User overrides only cover a subset of actions.
- Existing override loading handles single keys, not leader-key sequences.
- First-run keymap choices exist, but they are `vim` / `emacs` presets rather than the issue's `default` / `power-user` operating modes.

## Goals

- Introduce a leader-key grammar for normal-mode TUI actions.
- Ship two built-in presets: `default` and `power-user`.
- Persist user keymap choices and overrides through the existing config stack.
- Route normal-mode actions from the active resolved keymap rather than scattered hard-coded keys.
- Render help overlay and status bar hints from the same resolved keymap used by routing.
- Keep modal text entry and terminal input modes protected from leader-key interception.
- Preserve a narrow compatibility path for existing user config keys while moving the product surface to `default` / `power-user`.

## Non-Goals

- No change to TUI business actions, panels, provider calls, or data loading.
- No rewrite of the command palette.
- No global app-wide keymap for welcome screens beyond the existing first-run keymap selection UI.
- No arbitrary multi-stroke macro system; keymaps bind sequences to existing action ids only.
- No plugin system for external keymap packages.

## Current Anchors

The implementation should build on these files:

| File | Current role |
| --- | --- |
| `src/tui/hooks/use-keyboard-handler.ts` | Main normal-mode and modal key router |
| `src/tui/hooks/use-keybinding-overrides.ts` | Existing action-to-key override loader and default actions |
| `src/tui/config-loader.ts` | Layered `~/.config/grove/config.json`, `.grove/config.json`, and `GROVE_CONFIG` loader |
| `src/tui/config-watcher.ts` | Live `~/.grove/hotkeys.yaml` watcher |
| `src/tui/panels/panel-registry.ts` | Canonical panel list and existing panel keybindings |
| `src/tui/components/help-overlay.tsx` | Help overlay currently mixing config-derived and hard-coded entries |
| `src/tui/components/status-bar.tsx` | Status bar currently using hard-coded panel hint strings |
| `src/tui/views/welcome/keymap-presets.ts` | First-run keymap preset persistence |
| `src/tui/views/welcome/customize-keyboard.ts` | First-run keymap selector routing |

## Design

### Keymap Model

Add a pure keymap module, `src/tui/keymap/keymap.ts`, that defines the stable contract used by routing and display:

```ts
export type TuiActionId =
  | "quit"
  | "help"
  | "palette"
  | "refresh"
  | "zoom_cycle"
  | "zoom_reset"
  | "layout_toggle"
  | "view_cycle"
  | "focus_panel"
  | "toggle_panel"
  | "cycle_panel_next"
  | "cycle_panel_prev"
  | "search_start"
  | "terminal_input"
  | "compare_toggle"
  | "artifact_prev"
  | "artifact_next"
  | "artifact_diff"
  | "approve"
  | "deny"
  | "broadcast"
  | "direct_message";

export interface KeySequence {
  readonly keys: readonly string[];
}

export interface KeyBinding {
  readonly action: TuiActionId;
  readonly sequence: KeySequence;
  readonly label: string;
  readonly context: "global" | "panel" | "navigation";
  readonly panel?: Panel | undefined;
  readonly args?: Readonly<Record<string, string | number>> | undefined;
}

export interface ResolvedKeymap {
  readonly preset: "default" | "power-user";
  readonly bindings: readonly KeyBinding[];
}
```

`focus_panel` and `toggle_panel` carry the target panel id in `args.panel`. Specific actions such as `artifact_prev` remain separate because their code paths are not panel registry operations.

### Leader Grammar

Use `Space` as the default leader key because it is common in terminal UIs and is currently not used by normal-mode routing. Escape cancels a pending leader sequence. Modal input modes continue to consume printable characters before normal-mode keymap resolution runs.

Default leader groups:

| Sequence | Action |
| --- | --- |
| `Space ?` | Help |
| `Space q` | Quit |
| `Space r` | Refresh |
| `Space p 1` ... `Space p 4` | Focus core panels |
| `Space p a` | Toggle Agents |
| `Space p t` | Toggle Terminal |
| `Space p f` | Toggle Frontier |
| `Space p c` | Toggle Claims |
| `Space p s` | Toggle Search |
| `Space p v` | Toggle VFS |
| `Space z` | Zoom cycle |
| `Space Z` | Zoom reset |
| `Space l` | Toggle layout |
| `Space V` | Cycle grid / pipeline view |
| `Space m b` | Broadcast |
| `Space m @` | Direct message |
| `Space c p` | Command palette |

Direct navigation keys stay direct in both presets:

- `j` / `down`: cursor down
- `k` / `up`: cursor up
- `Enter`: select
- `Tab` / `Shift+Tab`: cycle focused panel
- `Esc`: back, cancel, or zoom reset depending on current state

Panel-local keys stay available when they are efficient and unlikely to conflict:

- Terminal panel: `i`, `j`, `k`, `G`
- Artifact panel: `h`, `l`, `d`
- Frontier panel: compare action
- Decisions panel: approve / deny
- Search panel: `/`

The keymap model can still represent those direct bindings as one-key sequences, which lets help and status rendering use one source of truth.

### Built-In Presets

Add `src/tui/keymaps/default.json` and `src/tui/keymaps/power-user.json`.

`default` should prefer leader-key sequences for global actions and panel access. It should keep only essential navigation and panel-local keys direct.

`power-user` should include the same leader sequences plus direct aliases for existing muscle memory:

- `q`, `?`, `r`, `+`
- `1` through `4` for core panels
- existing panel registry keys for operator panel toggles
- `b` and `@` for messaging
- `m` and `Ctrl+P` for palette entry
- existing panel-specific direct actions

The direct aliases are additive. They should not replace leader bindings, so help can show both when useful and a user can still learn the structured grammar.

### User Configuration

Extend `GroveUserConfig` with a top-level `keymapPreset?: "default" | "power-user"` while preserving the existing `keymap` object for overrides.

Config example:

```json
{
  "keymapPreset": "power-user",
  "keymap": {
    "quit": "Space x",
    "refresh": "F5",
    "toggle_panel:terminal": "Space p t"
  }
}
```

Override keys are parsed as whitespace-separated sequences. Existing single-key override values continue to work. The loader should accept existing action ids from `REMAPPABLE_ACTIONS` and the new parameterized panel ids:

- `focus_panel:dag`
- `focus_panel:detail`
- `focus_panel:frontier`
- `focus_panel:claims`
- `toggle_panel:terminal`
- `toggle_panel:search`
- and the rest of `PANEL_REGISTRY`

Layering order:

1. Built-in preset (`default` if unspecified)
2. `config.json` `keymap`
3. live `~/.grove/hotkeys.yaml`
4. legacy `.grove/keybindings.json`

Later layers win for the same action id. If two action ids resolve to the same sequence, the first binding in resolved order wins and the losing conflict is reported to stderr. This matches the existing first-win conflict behavior while making the final source explicit.

### Sequence Resolver

Replace the current single-key reverse map with a pure sequence resolver:

```ts
export type KeymapResolution =
  | { readonly kind: "pending"; readonly prefix: readonly string[] }
  | { readonly kind: "match"; readonly binding: KeyBinding }
  | { readonly kind: "miss" };
```

`routeKey` owns the pending prefix state through a new `leaderPrefix` field in the app keyboard reducer, or through a small hook wrapping `routeKey`. The pure resolver should be tested without React:

- leader alone returns `pending`
- a valid prefix returns `pending`
- a complete sequence returns `match`
- an invalid sequence returns `miss` and clears the prefix
- Escape clears a pending prefix before normal Escape behavior runs

Routing still checks modal modes first. The resolver only runs in `InputMode.Normal`, after global hard-wired controls that must remain universal (`Ctrl+P` command palette toggle and Escape cancel/back behavior), and before legacy hard-coded normal-mode handlers. As implementation progresses, those legacy branches should be deleted once each action has a keymap binding and tests prove parity.

### Action Dispatch

Add an `executeKeymapAction(binding, actions)` helper near `routeKey`. It maps action ids to existing callbacks:

- `quit` -> `actions.onQuit()`
- `help` -> `panels.setMode(InputMode.Help)`
- `focus_panel` -> `panels.focus(panel)`
- `toggle_panel` -> `panels.toggle(panel)`
- `palette` -> `actions.onSpawnPalette()` and command palette mode
- `broadcast` / `direct_message` -> existing message mode callbacks
- panel-local actions keep their current focus guards

The helper should return `true` when it handled the binding and `false` when the binding is invalid for current focus. Invalid-for-context bindings should still consume the key sequence to avoid accidentally falling through into unrelated direct actions.

### Help Overlay

Replace local binding arrays in `help-overlay.tsx` with a presenter that receives the active `ResolvedKeymap`. The overlay groups bindings by context:

- Global
- Navigation
- Panels
- Focused panel
- Messaging

For panel sections, derive labels from `PANEL_REGISTRY` and `PANEL_LABELS`. If multiple bindings point to the same action, show the preferred binding first and optional aliases after it, such as `Space p t / 6`.

### Status Bar

Update `StatusBar` props to accept the active keymap or a precomputed hint list. The hint selection should be derived from bindings relevant to current mode, detail state, and focused panel.

The status bar should stay compact. Suggested default forms:

- Default preset: `Space:leader  Tab:cycle  j/k:nav  Enter:select  ?:help`
- While a leader prefix is pending: `Space p ...  Esc:cancel`
- Terminal panel: `Space p t:panel  i:input  j/k:scroll  ?:help`
- Search panel: `Space p s:panel  /:search  j/k:nav  ?:help`

This removes the current hard-coded punctuation ranges such as `5-\`:toggle`.

### First-Run Experience

Change the first-run keymap choices from `vim`, `emacs`, and `none` to `default`, `power-user`, and `none`.

- Fast path should choose `default`.
- Customize should default to `default`.
- Selecting `power-user` writes `"keymapPreset": "power-user"` to `~/.config/grove/config.json`.
- Selecting `default` writes `"keymapPreset": "default"` only when the config file already exists or when another first-run setting is being persisted; otherwise the implicit default is enough.
- Existing `vim` and `emacs` JSON presets may remain in the tree temporarily, but they should not be shown in new UI copy.

## Testing

Use TDD for implementation. Minimum tests:

- `keymap` resolver tests for pending, match, miss, conflict, and Escape cancellation.
- Built-in preset tests proving `default` has leader panel access and `power-user` keeps direct aliases.
- Config loader tests for `keymapPreset`, sequence parsing, and compatibility with existing single-key `keymap` values.
- `routeKey` tests proving leader sequences call the expected existing callbacks.
- `routeKey` tests proving modal input modes are not intercepted by leader sequences.
- Help overlay tests proving rendered keys come from the active keymap.
- Status bar tests proving hints change when preset, focused panel, or pending leader prefix changes.
- First-run customize keyboard tests for `default` / `power-user` / `none` selection.

Run targeted Bun tests during development, then finish with:

```bash
bun test src/tui/hooks/use-keyboard-handler.test.ts src/tui/hooks/use-keybinding-overrides.test.ts src/tui/config-loader.test.ts src/tui/components/help-overlay.test.ts src/tui/components/status-bar.test.tsx src/tui/views/welcome/customize-keyboard.test.ts src/tui/views/welcome/keymap-presets.test.ts
bun run typecheck
bun run check
```

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Space conflicts with a future normal-mode action | Reserve Space as leader in the keymap module and route it before direct normal-mode actions. |
| Users with existing `vim` or `emacs` config lose behavior | Keep existing `keymap` overrides valid; do not delete old preset files in this issue unless a migration test proves compatibility. |
| Help gets noisy if every alias is shown | Mark one binding per action as preferred and collapse aliases to one slash-separated key cell. |
| Leader state leaks into modal input | Resolver only runs in `InputMode.Normal`; tests cover search, message, goal, terminal, and command palette modes. |
| Panel ids in config drift from `PANEL_REGISTRY` | Generate valid panel action ids from `PANEL_REGISTRY` instead of duplicating a list. |

## Acceptance Criteria

- Core actions are reachable through the leader-key grammar without relying on a growing punctuation map.
- `default` and `power-user` presets are available and selectable from first-run customization.
- Users can override keybindings in config without patching source.
- Help overlay reflects the active preset and user overrides.
- Status bar reflects the active preset, focused panel, and pending leader prefix.
- Existing modal input behavior is unchanged.
- Existing direct keys remain available in `power-user` where they were already part of the TUI's normal-mode workflow.
