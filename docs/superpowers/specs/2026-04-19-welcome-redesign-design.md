# Welcome flow redesign — smarter startup and session resumption

- **Issue:** [#190](https://github.com/windoliver/grove/issues/190)
- **Status:** Design approved — pending implementation plan
- **Date:** 2026-04-19

## Problem

The current `src/tui/views/welcome.tsx` is a single 640-LOC module with a
four-step state machine (`action → sessions | preset | connect → name`). It is
functional but treats first-time users and returning operators identically,
surfaces an always-on glossary, keeps Nexus/local/federated concepts muddled,
and offers no first-run affordances for keybinding or topology defaults.

Issue #190 asks for a "polished operator entry point, not a raw setup wizard":
smarter resume, clearer backend choices, explicit first-run defaults, and
tighter copy for new-session creation.

## Goals

1. Returning operators reach a running session in one Enter keystroke.
2. First-time users see at most two screens before a grove is initialized.
3. Backend choice (local vs Nexus) is the top-level axis, not buried under
   preset selection.
4. First-run offers opinionated defaults for preset, name, and keybinding
   preset — writing through the existing `GroveUserConfig` machinery from
   issue #195.
5. Each sub-view is independently testable and under ~200 LOC.

## Non-goals

- Live agent count on session rows (`SessionRecord` does not expose this
  today; belongs to #184 territory).
- "Switch grove" semantics for `c` on the fast-path (new feature, out of
  scope).
- Cross-grove session search.
- Changes to `ScreenManager`, `SpawnManager`, or any post-setup screen.

## Design overview

The welcome UI becomes a router (`views/welcome/index.tsx`) that selects one of
two top-level flows:

- **Fast-path** — when `.grove/` exists. Session list with rich top-row
  rendering, cursor on most-recent active session, footer hints for the four
  operator actions (resume, new, connect, archive toggle).
- **First-run** — when `.grove/` does not exist. Two-step wizard:
  `mode-picker` (Local vs Connected) followed by optional `customize`
  (preset + name + keybinding) reached via Tab.

Both branches share a `connect.tsx` sub-view for Nexus URL entry, and
fast-path additionally exposes a `new-session.tsx` sub-view reached via `n`
that reuses the existing grove's backend.

### Module layout

```
src/tui/views/welcome/
  index.tsx          router — picks branch based on grove state
  fast-path.tsx      session list + footer actions
  session-row.tsx    rich top-row / compact row renderer
  first-run.tsx      wizard state container (mode → customize)
  mode-picker.tsx    Local vs Connected cards
  customize.tsx      preset + name + keybinding selector
  new-session.tsx    preset picker for `n` on fast-path
  connect.tsx        Nexus URL input (shared by both branches)
  keymap-presets.ts  pure mapping from preset name → keymap block
  router.ts          pure decision function (tested in isolation)
```

The old `src/tui/views/welcome.tsx` is deleted once `index.tsx` is in place.

### Router decision

Pure function in `router.ts`:

```ts
export type WelcomeRoute =
  | { kind: "fast-path" }
  | { kind: "first-run"; step: "mode" | "customize" }
  | { kind: "new-session" }
  | { kind: "connect"; returnTo: "fast-path" | "first-run" };

export function resolveInitialRoute(input: {
  groveExists: boolean;
  sessions: readonly SessionRecord[];
}): WelcomeRoute;
```

- `!groveExists` → `{ kind: "first-run", step: "mode" }`
- `groveExists` (any session count) → `{ kind: "fast-path" }`
- Empty session list is handled inside fast-path as an empty-state layout;
  it is not a separate route.
- `autoConnectNexus` in `TuiApp` is handled upstream and bypasses this router
  entirely (unchanged behavior).

### Fast-path

Layout:

```
┌ Grove · wondrous-finding-emerson ──────────────────────┐
│                                                         │
│  Continue session                                       │
│                                                         │
│  > ● "refactor welcome flow"        3 agents · 42c · 3m │
│      auth/feature · reviewer-pair                       │
│    ○ "add login flow"              12c · yesterday      │
│    ○ "benchmark fence algo"         8c · 4d ago         │
│                                                         │
│ [Enter] resume  [n] new  [c] connect  [a] archive  [q]  │
└─────────────────────────────────────────────────────────┘
```

Row rendering rules in `session-row.tsx`:

- The focused row renders in **rich mode**: two lines — goal/status/count/
  relative-time on line 1, topology/workspace-branch on line 2, higher
  contrast.
- Non-focused rows render **compact**: one dim line with dot, goal, count,
  relative time.
- Dots: `●` for `status === "active"`, `○` for completed/archived.
- Relative-time formatter is a small pure function: `< 60s → "just now"`,
  `< 60m → "Nm"`, `< 24h → "Nh"`, `< 7d → "Nd"`, `< 30d → "yesterday"`/`"Nd ago"`,
  otherwise absolute date.

Empty-state (`sessions.length === 0` after archive filter):

```
  Grove "wondrous-finding-emerson" ready.
  No sessions yet. Press [n] to start one.
```

Footer stays visible so `n`, `c`, `q` still work.

Keyboard handling:

| Key            | Effect                                                  |
| -------------- | ------------------------------------------------------- |
| `Enter`        | `onResume(focused.id)`                                  |
| `n`            | Route to `new-session.tsx`                              |
| `c`            | Route to `connect.tsx` with `returnTo: "fast-path"`     |
| `a`            | Toggle archived-session visibility (hidden by default)  |
| `/`            | Enter filter mode                                       |
| `j` / `↓`      | Cursor down (clamped)                                   |
| `k` / `↑`      | Cursor up (clamped)                                     |
| `Esc`          | Exit filter mode if active; otherwise no-op             |
| `q`            | `onQuit()`                                              |

Filter mode captures character input and narrows by case-insensitive goal
substring; `Esc` clears and exits; `Enter` commits filter and returns to
navigation. Cursor clamps to the filtered list length.

### First-run — step 1: mode-picker

Layout:

```
┌ Welcome to Grove ─────────────────────────────────────────┐
│                                                            │
│  Multi-agent collaboration workspace.                      │
│                                                            │
│  ┌ Local ───────────┐  ┌ Connected ────────┐              │
│  │ Single host      │  │ Join a Nexus      │              │
│  │ Fast iteration   │  │ Team workspace    │              │
│  │ Preset: coder    │  │ Preset: team-pair │              │
│  └──────────────────┘  └───────────────────┘              │
│                                                            │
│   [h/l] move   [Enter] start with defaults                 │
│   [Tab] customize   [c] connect to existing Nexus URL      │
│   [?] glossary   [q] quit                                  │
└────────────────────────────────────────────────────────────┘
```

Mode-to-default mapping (pure function in `router.ts`):

| Mode      | Default preset                 | Backend behavior on Enter                          |
| --------- | ------------------------------ | -------------------------------------------------- |
| Local     | first preset in list (`coder`) | `mode: "local"`, create `.grove/` in cwd           |
| Connected | first preset whose name starts with `team-`; falls back to first preset if none match | `mode: "nexus"` — if `resolveBackend` already yields a URL (env / `grove.json` / docker), use it; otherwise route through `connect.tsx` before launching |

Keys on mode-picker:

| Key           | Effect                                                               |
| ------------- | -------------------------------------------------------------------- |
| `h` / `←`     | Select Local card                                                    |
| `l` / `→`     | Select Connected card                                                |
| `Enter`       | Launch with defaults; Connected may route through `connect.tsx`      |
| `Tab`         | Route to `customize.tsx` with mode + defaults pre-filled             |
| `c`           | Route to `connect.tsx` directly (Connected mode implied)             |
| `?`           | Toggle glossary overlay                                              |
| `q`           | `onQuit()`                                                           |

The glossary (the six concept definitions currently at the root of
`welcome.tsx`) moves behind `?` so first-time users can summon it but it
never competes with the primary choice.

### First-run — step 2: customize

Layout:

```
┌ Customize ────────────────────────────────────────────────┐
│                                                            │
│  Mode: Local                             [Tab] back        │
│                                                            │
│  Preset    > coder                                         │
│              reviewer-pair                                 │
│              federated-swarm                               │
│              ...                                           │
│                                                            │
│  Name      wondrous-finding-emerson_                       │
│                                                            │
│  Keymap    (•) vim   ( ) emacs   ( ) none                  │
│                                                            │
│  [j/k] preset  [Tab] field  [Enter] launch  [?] details    │
│  [Esc] back                                                │
└────────────────────────────────────────────────────────────┘
```

Focus model: `Tab` cycles through three fields (`preset` list, `name` input,
`keymap` radio). Within the focused field:

- Preset list: `j` / `k` navigate; `?` toggles detail overlay (reuses existing
  preset detail rendering).
- Name input: character input, `Backspace` removes.
- Keymap radio: `h` / `l` or `1` / `2` / `3` toggles between `vim` / `emacs` /
  `none`.

`Esc` from any field routes back to mode-picker (not a character clear) — the
footer hint reflects this. `Tab` cycles focus as above. `?` opens preset
detail overlay when the preset field is focused.

On `Enter` (any field):

1. Validate name is non-empty.
2. Apply keymap preset if not `none`: merge the preset keymap block into
   `~/.config/grove/config.json` via the machinery introduced by #195. Preset
   blocks live at `src/tui/keymaps/{vim,emacs}.json` and are read-through in
   `keymap-presets.ts`. Only the keymap block is written; theme and other
   keys are left untouched.
3. Call `onSelect(presetName, groveName)`.
4. If mode is Connected and no backend URL resolved, route through
   `connect.tsx` first; on success, wire the URL as `--nexus` equivalent and
   then complete `onSelect`.

Keymap presets are shipped as read-only JSON resources, parsed once, merged
into user config on write. Idempotent: re-running first-run with the same
preset is a no-op; switching presets overwrites only keymap keys defined in
the new preset (others remain as user set them).

### `new-session.tsx` (fast-path `n`)

Layout:

```
┌ New session in wondrous-finding-emerson ─────────────────┐
│                                                           │
│  Pick a preset for this session:                          │
│                                                           │
│  > coder                single coder agent                │
│    reviewer-pair        coder + reviewer                  │
│    federated-swarm      6-role coordination               │
│    ...                                                    │
│                                                           │
│  [j/k] navigate  [Enter] pick  [?] details  [Esc] back    │
└───────────────────────────────────────────────────────────┘
```

- Data source: same `presets` prop already passed to `TuiApp`.
- `Enter` calls `onNewSession(presetName)`.
- `TuiApp` handler: reuses existing `appProps`, sets `mode = "boardroom"`,
  passes `initialState = { screen: "goal-input", selectedPreset: presetName }`
  to `ScreenManager`, `startOnRunning: false`.
- `Esc` routes back to fast-path.

No name prompt on this screen — the session identifier is generated by the
provider; the goal text on the next screen becomes the human label.

### `connect.tsx`

Layout:

```
┌ Connect to remote Nexus ─────────────────────────────────┐
│                                                           │
│  Nexus URL: http://localhost:2026_                        │
│                                                           │
│  [Enter] connect  [Esc] back                              │
└───────────────────────────────────────────────────────────┘
```

- `Enter` calls `onConnect(url)` (existing callback, unchanged signature).
- `Esc` routes back to `returnTo` (fast-path or first-run mode-picker).
- Inline error rendering on connect failure: reads `initError` from the
  parent; stays on screen so user can retry without losing typed URL.
- From Connected-mode first-run with no pre-resolved URL: on successful
  connect, route to `customize.tsx` with the URL bound. Preserves wizard
  progress instead of forcing a restart.

### Callback contract changes in `TuiApp`

Existing:

```ts
onSelect(presetName: string, groveName: string): void;
onResume(): void;
onConnect(nexusUrl: string): void;
onQuit(): void;
```

New shape:

```ts
onSelect(presetName: string, groveName: string, opts?: {
  nexusUrl?: string;          // set when Connected-mode with resolved URL
}): void;
onResume(sessionId?: string): void;   // id forwarded to resume flow
onConnect(nexusUrl: string): void;    // unchanged
onNewSession(presetName: string): void;  // new
onQuit(): void;
```

- `onResume` now receives the focused session id. Hook it into the existing
  resume path in `TuiApp`; `ScreenManager`'s `resumeScopeIdRef` already
  exists to scope the feed, so forward the id into `initialState`. This
  unblocks #184 without doing its full scope.
- `onNewSession` is new; implementation transitions straight to boardroom
  without `onInit`, reusing the existing `appProps` captured at grove start.

### Props contract changes in `TuiApp`

- New prop `onNewSession` with the same shape as above.
- `onResume` signature broadens to accept an optional id.
- No change to `autoConnectNexus`, `presets`, `sessions`, `groveInfo`,
  `onInit`, `onConnect`, `onStart`.

### Keymap preset file format

`src/tui/keymaps/vim.json`:

```json
{
  "keymap": {
    "navigate.up":   "k",
    "navigate.down": "j",
    "navigate.left": "h",
    "navigate.right":"l",
    "search":        "/"
  }
}
```

`src/tui/keymaps/emacs.json`: equivalent mapping for emacs conventions. Only
action names already registered in `use-keybinding-overrides` are written.
Unknown actions are stripped at load time (existing schema behavior).

## Error handling

| Situation                                            | Behavior                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `onConnect` URL unreachable                          | Stay on `connect.tsx`; render inline `Error: <msg>`; Enter retries; Esc routes back.      |
| `onInit` fails                                       | Existing `InitProgressView` error flow (Esc → setup, q → quit) — unchanged.               |
| Sessions fetch fails                                 | Fast-path renders with empty list and a banner ("Sessions unavailable"); `n` still works. |
| Keymap preset write fails                            | `process.stderr.write` a warning; launch proceeds. User can re-apply via settings.        |
| `presets` empty / undefined                          | Existing fallback message preserved in `index.tsx`.                                       |
| `groveInfo` missing while `groveExists === true`     | Router defensively routes to first-run; log a stderr warning.                             |
| `autoConnectNexus` set                               | `TuiApp` skips welcome mount entirely (unchanged).                                        |
| All sessions archived, none active                   | Fast-path renders with empty active list; `[a] show N archived` hint; `a` reveals.        |
| Filter narrows to zero                               | "No sessions match filter"; `Esc` clears.                                                 |
| Cursor out-of-bounds after filter/toggle             | Clamp to `0` or `list.length - 1`.                                                        |
| `n` pressed while filter mode is active              | Ignored (reserved keys outside filter only).                                              |
| Backend resolves to `remote` (--url debug viewer)    | Fast-path renders read-only (current provider already handles read-only semantics).       |

## Testing strategy

Following the existing `screens/running-keyboard.test.ts` precedent: extract
pure logic into testable modules, keep rendering thin.

**Pure-logic tests** (one `.test.ts` per module):

- `router.test.ts` — the `groveExists × sessions.length × autoConnect` matrix
  maps to the expected `WelcomeRoute`.
- `session-row.test.ts` — relative-time formatter across boundaries; rich vs
  compact branch selection.
- `fast-path-keyboard.test.ts` — Enter / n / c / a / / / Esc / j / k / q
  behavior across filter-active, archive-visible, empty-list states.
- `first-run-keyboard.test.ts` — mode-picker h / l / Enter / Tab / c / ? and
  customize Tab field cycle, preset j/k, keymap radio toggles.
- `keymap-preset.test.ts` — `vim` and `emacs` preset JSON merges into
  `GroveUserConfig` without touching theme keys; unknown actions stripped.
- `new-session-keyboard.test.ts` — Enter calls `onNewSession` with the
  focused preset name; Esc routes back.

**Integration tests** (snapshot + event-driven):

- First-run happy path: mode-picker → Enter → `onSelect(defaultPreset, cwd)`
  with correct mode-dependent defaults.
- First-run Tab → customize → Enter → `onSelect` called with custom args
  and keymap-preset side effect recorded.
- Fast-path Enter → `onResume(sessionId)` called with focused session's id.
- Fast-path `n` → `onNewSession(presetName)` called, routed away from
  fast-path.
- Fast-path `c` → `connect.tsx` → Esc → returns to fast-path.
- First-run `c` (Connected-mode with no URL) → connect → success → customize
  with URL bound.

**Snapshot tests** one per screen:

- `mode-picker`
- `customize`
- `fast-path` with 3 sessions (1 active, 2 completed)
- `fast-path` empty-state
- `fast-path` with filter active
- `new-session`
- `connect` (fresh) and `connect` (error state)

No migration tests — the old `welcome.tsx` is deleted in this change.

## Rollout

- Feature is behind no flag — the redesign replaces the existing welcome
  wholesale.
- CLI flags `--nexus` and `--url` continue to bypass welcome as they do
  today.
- Users whose `.grove/` already exists go straight to fast-path; no
  migration needed.
- Keymap preset selection on first-run writes once to global config; users
  who later customize via #195's config file keep their edits (only keys
  defined by the preset are touched).

## Risks

- **Coupling with #184** (Resume shows past traces) — the `onResume(sessionId)`
  signature change is the wire format #184 will consume. If #184 lands first,
  that signature is already in place; if this issue lands first, #184 hooks
  into `sessionId` directly. Low risk either order.
- **`TuiApp` prop surface** — adding `onNewSession` plus widening `onResume`
  touches the `TuiAppProps` interface. Callers in `src/tui/main.ts` must be
  updated in the same commit; no other callers exist.
- **Keymap preset overwrite** on re-run — mitigated by only applying on
  first-run (fresh `.grove/`); subsequent launches never re-run the wizard.
- **Module count** — `views/welcome/` grows from 1 file to ~10. Matches the
  existing `screens/` pattern and each file stays under ~200 LOC. Net
  maintainability gain.

## Open questions

None blocking. Deferred explicitly:

- Live agent count / real-time running indicator on session rows (#184).
- `c` on fast-path as "switch grove" — possible future enhancement, needs
  its own design.
- Cross-grove session search.
