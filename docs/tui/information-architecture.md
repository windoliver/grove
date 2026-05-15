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
