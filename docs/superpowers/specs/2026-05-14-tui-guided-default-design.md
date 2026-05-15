# TUI: Guided Session as the Default Product, Boardroom as Inspect Overlay

**Issue:** [windoliver/grove#191](https://github.com/windoliver/grove/issues/191)
**Date:** 2026-05-14
**Status:** Draft

## Problem

Grove's TUI presents two surfaces that read as competing products:

1. A guided 5-screen flow (`ScreenManager`) — preset → goal → detect → spawn → running → complete.
2. A dense multi-panel workspace (`App` in `src/tui/app.tsx`), reached from `RunningView` via Ctrl+A.

The guided flow already mounts first in code, but naming and labels frame the workspace as an equal-weight "advanced boardroom" rather than an on-demand inspector. Specifically:

- `TuiMode` enum value `"boardroom"` actually means "post-init: render `ScreenManager`" — it does *not* render the boardroom App. The name actively misleads readers of `tui-app.tsx`.
- The `Screen` value `"advanced"` and the page kind `"advanced"` describe the boardroom overlay but reuse the generic word "advanced" everywhere.
- The footer chip on `RunningView` reads `Ctrl+A Advanced boardroom` — two names for one thing, neither of which signals "this is layered above your session".
- There is no documented information architecture, so each contributor reconstructs the model from `tui-app.tsx`, `screen-manager.tsx`, and `app.tsx` independently.

## Goals

- Establish one primary product (the **Session View**) and one layered secondary surface (the **Inspect Overlay**).
- Make entry to and exit from inspect symmetric, deliberate, and obviously layered (not a parallel product).
- Audit every label, JSDoc comment, and help-text string in the TUI so the mental model is internally consistent.
- Land a permanent IA doc at `docs/tui/information-architecture.md` so future contributors share the model.

## Non-goals

- No structural refactor of `App.tsx` or `panels/panel-manager.ts`. The boardroom remains intact internally; only its outer framing changes.
- No removal of panels, no merge of boardroom functionality into `RunningView`. That is a separate, higher-risk effort and is out of scope for this issue.
- No rename of the server route `/api/boardroom/message`. Route names are a server contract, not user-facing TUI copy.
- No change to `App.tsx` internal panel names (DAG, Frontier, Dashboard, etc.) or `PanelBar` labels.

## Design

### Architecture

The component hierarchy is unchanged:

```
TuiApp (tui-app.tsx)
  └─ ScreenManager (screens/screen-manager.tsx)         ← Session View
       └─ PagesRouter
            ├─ PresetSelect / GoalInput / AgentDetect / SpawnProgress
            ├─ RunningView                              ← default landing
            ├─ CompleteView
            └─ InspectModeWrapper(App)                  ← Inspect Overlay (on-demand push)
```

`InspectModeWrapper` (renamed from `AdvancedModeWrapper`) mounts `App` only when the user pushes `{ kind: "inspect" }` onto `PagesStore`. The push originates from `RunningView` via Ctrl+I and nowhere else.

### Naming changes (internal)

| Symbol / file                                  | Old                  | New                |
| ---------------------------------------------- | -------------------- | ------------------ |
| `TuiMode` value (tui-app.tsx)                  | `"boardroom"`        | `"session"`        |
| `Screen` value (screen-manager.tsx)            | `"advanced"`         | `"inspect"`        |
| `PageKind` value (data/pages-store.ts)         | `"advanced"`         | `"inspect"`        |
| Component (screen-manager.tsx)                 | `AdvancedModeWrapper`| `InspectModeWrapper`|
| File                                           | `views/advanced-hints.ts` | `views/inspect-hints.ts` |
| Exported constant                              | `ADVANCED_HINTS`     | `INSPECT_HINTS`    |
| Handler (screen-manager.tsx)                   | `handleToggleAdvanced` | `handleEnterInspect` |

These are internal symbols; no public API changes.

### Transitions

- **Entry:** `Ctrl+I` from `RunningView`. Pushes `{ kind: "inspect" }` onto `PagesStore`; sets `state.screen = "inspect"`.
- **Exit:** `Ctrl+I` *or* `Esc` from inside the inspect overlay. Both call `onBack`, which pops `PagesStore` and sets `state.screen = "running"`.
- **Backwards compatibility:** `Ctrl+B` continues to exit the overlay for one release (footer does not document it). This protects muscle memory from the prior keymap.
- **Status badge:** while `PagesStore.top().kind === "inspect"`, `components/status-bar.tsx` renders an `[INSPECT]` chip. The chip is the operator's visual cue that they are layered above the session, not in a different product.

### Copy & label changes

| File                               | Change                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `tui-app.tsx` (header)             | "setup → starting → boardroom lifecycle" → "setup → starting → session lifecycle". Drop "(advanced mode via Tab)" — replace with "deep inspect via Ctrl+I from RunningView". |
| `screen-manager.tsx` (header)      | "Ctrl+A: toggle to App (advanced mode) / Ctrl+B back to RunningView" → "Ctrl+I: open inspect overlay (full panel workspace) / Ctrl+I or Esc to return". |
| `screen-manager.tsx` JSDoc on `appProps` | "AppProps for the advanced boardroom mode" → "AppProps passed through to the inspect overlay". |
| `screen-manager.tsx` `AdvancedModeWrapper` JSDoc | "Wraps the full App (boardroom) and intercepts Tab" → "Wraps the full App as an inspect overlay above the session view." |
| `screens/running-view.tsx` (footer chip, line 1857) | `Ctrl+A Advanced boardroom` → `Ctrl+I Inspect`. |
| `screens/running-view.tsx` (header comment, line 12) | "Ctrl+A: toggle to advanced boardroom" → "Ctrl+I: open inspect overlay". |
| `views/inspect-hints.ts` JSDoc     | "Hints for advanced (boardroom) mode (#309)" → "Hints for the inspect overlay opened from RunningView (#191)". |
| `views/inspect-hints.ts` body      | Keymap becomes `Ctrl+I Back`, `Esc Back`, `? Help`, `q Quit`. |
| `main.ts` JSDoc (lines 201–203)    | Replace "boardroom AppProps" / "direct boardroom path" with "session AppProps" / "direct session path". |
| Help overlay (RunningView help, App help) | Prepend one line: `Inspect: Ctrl+I opens deep panel view; Ctrl+I or Esc returns.` |

`App.tsx` server-API references to `/api/boardroom/message` are explicitly excluded.

### Information architecture document

New file: `docs/tui/information-architecture.md`. Outline:

1. **Two views, one product** — opening framing: Session View is default, Inspect Overlay is layered.
2. **Lifecycle diagram (ASCII)** — Welcome / Initializing / Starting / Connecting → Session View → Inspect Overlay (with Ctrl+I round trip).
3. **Session View** — the 5 screens, transitions, and the fact that screen names map 1:1 to `Screen` enum values in `screen-manager.tsx`.
4. **Inspect Overlay** — purpose (deep panel workspace), entry rule (only from `RunningView`), state mechanism (PagesStore stack push, not a mode flag), exit (Ctrl+I or Esc, returns identical RunningView state).
5. **State ownership table** —
   - `TuiMode` lifecycle → `tui-app.tsx`
   - 5-screen state machine → `screen-manager.tsx` (`Screen` type)
   - PagesStore stack → `data/pages-store.ts`
   - Inspect overlay panels → `app.tsx` + `panels/panel-manager.ts`
6. **When to add to Session View vs. Inspect Overlay** —
   - Session View: anything an operator needs to *complete a run* (status, contributions, prompts, permissions).
   - Inspect Overlay: anything they need to *understand state in depth* (graphs, raw events, multi-panel views).
7. **Naming** — explicit guidance: do not use "boardroom" in user-facing copy. Internal grandfather list contains only `/api/boardroom/message`.

## Testing

- `screen-manager.test.ts` already covers `advanced` push/pop. Rename test cases to `inspect`; add a case asserting `Esc` exits the inspect overlay (currently only `Ctrl+B` is tested).
- `running-keyboard.test.ts` — replace `Ctrl+A` assertions with `Ctrl+I`; add an assertion that `Ctrl+A` no longer triggers an entry handler.
- Snapshot or text assertion on `RunningView` footer chip text.
- New test: status bar renders `[INSPECT]` chip iff `PagesStore.top().kind === "inspect"`.
- IA doc: smoke test via `npx markdownlint docs/tui/information-architecture.md` in CI if markdownlint is already configured; otherwise no test.

## Risks & mitigations

| Risk                                            | Mitigation                                          |
| ----------------------------------------------- | --------------------------------------------------- |
| Muscle memory: Ctrl+A users land on a no-op.   | Keep `Ctrl+B` exit binding for one release; document the keymap change in the IA doc and in the release notes for the issue. |
| Grep churn: contributors searching for `boardroom` get fewer hits. | The IA doc names both terms explicitly; PR description should list the rename table verbatim. |
| `PageKind` rename touches `pages-store.ts` serialization. | Confirm `PagesStore` does not persist page kinds across process restarts. If it does, write a migration shim that reads `"advanced"` and rewrites to `"inspect"` on load. (Investigation note for the implementation plan, not a design decision.) |

## Acceptance criteria

Mirroring the issue:

- [ ] New users land on the Session View; no path takes them to the Inspect Overlay before they explicitly press Ctrl+I.
- [ ] Switching to Inspect is intentional (Ctrl+I from RunningView only) and reversible (Ctrl+I or Esc).
- [ ] Status bar, footer chip, and help text consistently use "Session" and "Inspect" — no `boardroom` or `advanced` strings remain in user-facing copy.
- [ ] `docs/tui/information-architecture.md` exists and documents the two-view model and state ownership.
