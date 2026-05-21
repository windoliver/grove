# LogView with backpressure — design

**Issue**: [#310](https://github.com/windoliver/grove/issues/310)
**Parent epic**: #286 (Polish: Log / Pulse / Hot-Reload)
**Source roadmap**: `docs/proposals/tui-orchestration-roadmap.md` #17
**Depends on**: #296 (central store, closed), #301 (EntityView, closed)

## Goal

Live-tail a single agent's stdout in the TUI with bounded memory, lossless ingest, fast filter, and pause/resume — replacing the current tmux-capture-based `<TerminalView>` for ACPX-streamed sessions.

## Acceptance (from issue)

1. 1k lines/sec sustained — no drops (writes always reach the buffer).
2. `space` pauses rendering; the view stops advancing until resumed.
3. `/foo` filters the visible tail buffer by substring.

## Non-goals

- ANSI color rendering (current `TerminalView` provides this via xterm-headless; LogView strips ANSI like `AgentLogBuffer` already does). Color support is a follow-up.
- Regex / multi-line filter — substring only.
- Persisted filter / pause state across mounts.
- Per-line type icons beyond the existing classifier output.

## Architecture

Three units, each with one responsibility.

### 1. `AgentLogBuffer` (existing — minor change)

`src/tui/data/agent-log-buffer.ts`

Already lossless: every `push()` writes to the ring buffer synchronously; subscribers are notified at most once per flush window. Only change: constructor takes an optional `flushMs` (default `16`). LogView constructs its buffer with `flushMs: 50` per the acceptance criterion. TracePane keeps the 16ms default.

```ts
new AgentLogBuffer(role, sessionId, capacity?: number, flushMs?: number)
```

Default of 16 preserves current TracePane behavior. No other callers touched.

### 2. `LogViewport` (new)

`src/tui/components/log-viewport.tsx`

Pure render component. Subscribes to an `AgentLogBuffer`, slices the viewport, applies a substring filter, dims historical lines, and renders a header (line count, auto-scroll state, filter chip, pause badge). Knows nothing about keyboard or routing.

```ts
interface LogViewportProps {
  readonly buffer: AgentLogBuffer;
  readonly paused: boolean;
  readonly filter: string;          // empty = no filter
  readonly scrollOffset: number;    // 0 = autoscroll
  readonly viewportLines?: number;  // default: rows - chrome
  readonly title?: string;          // header label
}
```

Behavior:

- Re-renders on `buffer.subscribe()` notify (coalesced by the buffer's flush).
- When `paused`, captures a `frozenLines` snapshot via `buffer.toArray()` once at the pause edge and renders from it until unpaused.
- Filter applies to the (live or frozen) sliced lines: `lines.filter(l => l.line.includes(filter))`. View-only — buffer is not mutated. Match-count is shown in the header as `42/1.2k` when the filter is non-empty.
- Autoscroll: when `scrollOffset === 0`, the slice ends at `buffer.size`. Any positive offset pins the view.
- Historical lines (`line.historical === true`) render dimmed.

### 3. `LogView` (new)

`src/tui/views/log-view.tsx`

Stateful wrapper. Owns:

- buffer lookup by `sessionId` (reads from the running-view's existing `Map<role, AgentLogBuffer>`),
- local state: `paused`, `filterText`, `filterMode` (input-active flag), `scrollOffset`,
- keyboard handlers (registered through the same keymap surface as other views).

```ts
interface LogViewProps {
  readonly sessionId: string;
  readonly buffer: AgentLogBuffer;   // pre-resolved by caller; LogView does not manage lifecycle
  readonly active: boolean;
  readonly mode: InputMode;
}
```

Delegates render to `<LogViewport>`.

### 4. TracePane refactor

`src/tui/views/trace-pane.tsx`

Right-hand trace column replaced with `<LogViewport>`. Left-hand agent list, status icons, and scroll math are unchanged. This eliminates the duplicated viewport-slicing block at trace-pane.tsx:117-128 and the duplicated header rendering at trace-pane.tsx:157-169.

### 5. Mount swap

`src/tui/views/running-view.tsx` (and the agent-split-pane that hosts `TerminalView`)

Where the running-view currently mounts `<TerminalView sessionName>`, mount `<LogView sessionId>` instead **when the agent was launched through ACPX** (the SSE-streamed path that produces real per-line log file output). For tmux-managed legacy sessions where only `tmux.capturePanes` is available, keep `<TerminalView>` as fallback — those sessions don't have a line-stream source and would render empty in LogView.

Selection signal: the existing `spawnManager` already distinguishes acpx vs tmux sessions (see `src/tui/spawn-manager.ts`); LogView is selected when `session.runtime === "acpx"` (or equivalent — exact field confirmed during implementation).

## Data flow

```
ACPX log file (or acp.message SSE event)
   │  existing path: pollLogFile() / pushRawLines()
   ▼
AgentLogBuffer (ring, lossless, 50ms notify coalesce)
   │  subscribe()
   ▼
LogViewport ──┬─ if !paused: read buffer.slice(start, end)
              │  if paused:  read frozen snapshot taken at pause edge
              ▼
           substring filter (view-only) → render
```

Writes are never blocked. Flush is just a notify cadence. Pause does not detach the SSE/ingest path — only freezes the render snapshot.

## Keyboard

LogView installs handlers when `active && mode === "terminal"`:

| Key | Action |
|-----|--------|
| `space` | Toggle pause. Captures `frozenLines = buffer.toArray()` on pause edge; clears it on resume. |
| `/` | Enter filter-input sub-mode. Cursor moves to one-line filter prompt in the header. |
| `Enter` (filter sub-mode) | Commit filter text; exit sub-mode. |
| `Esc` (filter sub-mode) | Clear filter text; exit sub-mode. |
| `j` / `↓` | Scroll one line up (increases `scrollOffset`). |
| `k` / `↑` | Scroll one line down (decreases `scrollOffset`, clamped at 0). |
| `G` | Jump to bottom: `scrollOffset = 0`, resumes autoscroll. |
| `g g` | Jump to top: `scrollOffset = buffer.size - viewportLines`. |

Filter sub-mode swallows printable keys into `filterText`; outside the sub-mode, all keys above behave normally. Keys are dispatched from the existing `src/tui/screens/running-keyboard.ts` switch when the active panel resolves to the log view (same pattern the trace pane and terminal panel already use). LogView exposes setters via context or props so the central handler can mutate its state without LogView owning input subscription.

Header layout:

```
session: coder-abc123 │ 1.2k lines │ auto: ON │ /foo (42 matches) │ ❚❚ PAUSED
```

## Error handling

- Missing `buffer` (sessionId not in the map): render `<EmptyState title="No log buffer for <sessionId>" />` — same component used elsewhere in the TUI.
- `buffer.toArray()` on pause is O(buffer.size); capacity is bounded (default 10k) so this is safe.
- Filter input never throws — pure substring match on stripped text.

## Testing

Three new test files (each follows existing patterns under `src/tui/views/` and `src/tui/components/`):

1. **`src/tui/components/log-viewport.test.tsx`** — render correctness.
   - Mounts with a fixture buffer; asserts viewport slicing at various `scrollOffset` values.
   - Asserts filter masks non-matching lines and updates the match-count badge.
   - Asserts pause-freeze: pushing new lines after `paused=true` does not change rendered output.
   - Asserts autoscroll re-clamps to bottom on buffer growth when `scrollOffset === 0`.

2. **`src/tui/views/log-view.test.tsx`** — keyboard wiring.
   - Simulates `space` → asserts `paused` toggles and frozen snapshot is taken.
   - Simulates `/foo<Enter>` → asserts filter is applied and sub-mode exits.
   - Simulates `j` / `k` → asserts `scrollOffset` increments/decrements.
   - Simulates `G` → asserts `scrollOffset === 0` and autoscroll resumes.

3. **`src/tui/data/agent-log-buffer.backpressure.test.ts`** — acceptance test for the "1k lines/sec no drops" criterion.
   - Push 1000 lines synchronously into a buffer constructed with `flushMs: 50`.
   - Assert `buffer.size === 1000` (every write applied — lossless).
   - Assert subscriber `listener` fired `≤ ceil(elapsed_ms / 50) + 1` times (coalesced — not 1000 renders).

No new test infrastructure. Uses existing `@opentui/testing` setup that already powers `entity-view.test.tsx`.

## Risks and mitigations

- **Losing ANSI colors for ACPX sessions.** Current `TerminalView` provides full xterm color rendering; LogView strips ANSI. Mitigation: scope the mount swap to ACPX paths only on first landing; revisit color rendering in a follow-up. Document this in the running-view comment where the swap happens.
- **`AgentLogBuffer` constructor signature change.** Adding an optional `flushMs` parameter could surprise external callers. Mitigation: default is 16 (current behavior); audit existing call sites during implementation and verify no breakage.
- **Pause snapshot allocates `buffer.size` array.** At default 10k capacity, that's 10k object refs — cheap. If capacity grows, revisit with a copy-on-write view. Out of scope here.

## Out of scope (explicit)

- ANSI/xterm color rendering in LogView.
- Regex filter.
- Filter persistence across sessions or remounts.
- Pulse dashboard (#308), hot-reload (#289) — sibling issues under epic #286.

## Files

New:
- `src/tui/components/log-viewport.tsx`
- `src/tui/components/log-viewport.test.tsx`
- `src/tui/views/log-view.tsx`
- `src/tui/views/log-view.test.tsx`
- `src/tui/data/agent-log-buffer.backpressure.test.ts`

Modified:
- `src/tui/data/agent-log-buffer.ts` — add `flushMs` constructor arg, default 16
- `src/tui/views/trace-pane.tsx` — use `<LogViewport>` for the right pane
- `src/tui/views/running-view.tsx` (and `src/tui/components/agent-split-pane.tsx`) — swap `<TerminalView>` → `<LogView>` for ACPX sessions
- `src/tui/screens/running-keyboard.ts` — add LogView key handling branch (`space`, `/`, `j`/`k`, `G`, `g g`) gated on the active panel being the log view
