# TUI Supervision Hero Surface — Design

**Issue:** [#193](https://github.com/windoliver/grove/issues/193) — TUI: make agent supervision the hero surface of the operator experience
**Related:** [#163](https://github.com/windoliver/grove/issues/163) — stale-blocked handoff detection (data source the Supervision screen will adopt when it lands; not blocking)
**Date:** 2026-05-15

## Problem

Grove's strongest UX is supervising many agents in parallel, but the experience is split across the contribution feed, the agent-list table, the DAG, terminal panes, and ad-hoc approval prompts. Operators have to switch panels and mentally filter to one agent to answer simple questions: *Which agents are stuck? Who needs me right now? What is agent X doing?*

The current `running-view.tsx` is a 73 KB monolith with four equal panels (Feed / Agents / DAG / Terminal). No panel is the supervision surface; supervision is implicit across all four.

## Goals

- Default landing for a multi-agent session shows the fleet, not the feed.
- Problem agents (blocked / stuck / silent / thrashing / awaiting approval) stand out immediately.
- Operator can act on approvals and inspect any agent without leaving the supervision surface.
- Agent-level navigation (select agent → see its feed/DAG/terminal) is one keystroke away.
- The new surface is decomposed (no new 73 KB monolith).

## Non-goals

- New server-side state machine for handoff/agent health. That belongs to [#163](https://github.com/windoliver/grove/issues/163). When #163 lands, the Supervision screen can adopt its server states by swapping the body of one pure function (`classifyAgent`); this design ships without that dependency.
- Web UI for supervision. The view-model and pure functions are structured so a web surface could share them later, but no work in this spec targets the web.
- Long-lived feature flag. The env flag introduced during migration (Section "Migration") is scaffolding torn down in the same PR series.

## Decisions (brainstorming locks)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Surface shape | **New top-level Supervision screen.** Replaces running-view; Feed/DAG/Terminal become per-agent drill-ins. |
| 2 | Fleet scale target | **Medium: 8–30 agents.** Compact cards in a 3-column grid, scrollable, filter chips at top. |
| 3 | State classification source | **TUI-side heuristics over existing data.** Pure functions, configurable thresholds. Ships independently of #163. |
| 4 | Approvals UX | **Badge on card + fleet chip + `A`-to-next modal.** Card stability preserved; per-card `y`/`n` precedence when modal closed. |
| 5 | Drill-down | **Split-pane below grid.** Grid stays visible; bottom dock scoped to focused agent with Feed/DAG/Term tabs. |
| 6 | Fate of running-view | **Full replacement.** Phased commits, but no long-lived dual-surface gate. |
| 7 | Architecture | **Aggregator hook + view-model + decomposed presentational shell.** Pure derive functions unit-tested in isolation. |

## Architecture

### Module layout

```
src/tui/views/supervision/
  supervision-screen.tsx        # shell — banner + grid + drill dock + approval modal
  fleet-banner.tsx              # top strip: counts by state, approval chip, filter input, goal+progress
  agent-grid.tsx                # 3-col virtualized grid of AgentCard, cursor wraps rows
  agent-card.tsx                # single card: id/role/state/last-action/task/cost (fixed 26-col width)
  drill-dock.tsx                # bottom pane scoped to focused agent (collapsible)
  drill-tabs.tsx                # Feed | DAG | Term tab strip (reuses existing views, scoped)
  approval-modal.tsx            # full prompt + y/n/d, fed by approval queue
  approval-queue.ts             # ordered list of pending approvals across fleet (adapter over existing sources)
  derive-state.ts               # pure: classifyAgent(...), summarize(...)
  derive-state.test.ts
  thresholds.ts                 # SupervisionThresholds defaults + env/config overrides
  thresholds.test.ts
  use-fleet-supervision.ts      # hook: provider + thresholds + tick → SupervisedAgent[] + FleetSummary
  keyboard.ts                   # key router (j/k card nav, /=filter, A=next approval, ...)
  keyboard.test.ts
  types.ts                      # SupervisedAgent, AgentState enum, FleetSummary, DrillTab
```

### Existing assets reused (not duplicated)

- `agent-columns.ts` — sort comparators.
- `derive-dag-status.ts` — DAG status logic for the drill-down DAG tab.
- `feed-view`, `dag-view`, `terminal-view` — rendered inside `drill-dock` with a new `scopedAgentId` prop (one-line addition each).
- `useAgentMonitor`, `useEntities`, `useEventDrivenData` — provider hooks unchanged.
- `confirm-and-mutate` — wraps approval acceptance; preserves the audited mutation path.
- `running-cmd-mode.ts` — filter cmd-mode reused as-is (`/` to enter, Esc to cancel).
- `@opentui-ui/dialog/react` — approval modal primitive.
- `FlashBar`, `Prompt`, `ProgressBar`, `EmptyState` — unchanged.

### Retired

- `src/tui/screens/running-view.tsx` (73 KB)
- `src/tui/views/agent-list.tsx`
- `src/tui/screens/running-keyboard.ts` (13.7 KB) + tests
- Associated tests in `running-view-handoffs.test.tsx`, `running-view.c2.test.tsx` migrate to supervision tests (not duplicated).

`screen-manager.tsx` swaps `RunningView` registration for `SupervisionScreen`. The saved-session route name `running` is aliased to supervision so persisted state and external URLs keep working.

## Data flow

```
provider                       useAgentMonitor             approval-queue.ts
  │                                  │                            │
  │ getClaims, getSessionCosts,      │  log timestamps, health    │  pendingApprovals
  │ getContributions(sessionId),     │                            │
  │ getHandoffs (if VFS provider)    │                            │
  └────────────┬─────────────────────┴────────────────────────────┘
               ▼
       useFleetSupervision(provider, thresholds, tick)
               │
               │  pure: derive-state.ts
               │    classifyAgent(claim, lastContribAt, logTail, cost, handoffs, now, thresholds) → SupervisedAgent
               │    summarize(agents[]) → FleetSummary
               ▼
       { agents: readonly SupervisedAgent[], summary: FleetSummary }
               │
   ┌───────────┼──────────────┬────────────────┐
   ▼           ▼              ▼                ▼
FleetBanner  AgentGrid      DrillDock      ApprovalModal
                         (focusedAgentId)  (queue head)
```

Key properties:

- **One tick = one render.** `useEventDrivenData` already de-dupes server polling; the hook owns the throttle so cards never re-fetch.
- **Pure derive.** `classifyAgent` is a pure function of inputs + injected `now` — every state transition is unit-testable without React.
- **Focus & scroll state** lives in `SupervisionScreen` local state, not in the hook, so re-derives don't reset cursor.
- **No new provider methods required for v1.** All inputs already exist on `TuiDataProvider`. Server-side projection (a future option) can replace the hook's body without touching consumers.

## View-model

```ts
// supervision/types.ts
export type AgentState =
  | "running"     // active claim + recent contribution
  | "silent"      // no contribution > silentMs, lease still valid
  | "stuck"       // same task > stuckMs, no progress markers
  | "blocked"     // lease expired OR handoff target unhealthy
  | "thrashing"   // > thrashContribs in thrashWindowMs against same target
  | "awaiting"    // pending approval prompt
  | "done"        // claim complete, kept on screen for completedRetentionMs
  | "idle";       // no active claim

export type DrillTab = "feed" | "dag" | "term";

export interface SupervisedAgent {
  readonly agentId: string;
  readonly agentName?: string;
  readonly role: string;
  readonly platform: string;
  readonly state: AgentState;
  readonly stateReason: string;        // human-readable badge text
  readonly lastActionAt: number;       // epoch ms — drives "42s ago"
  readonly currentTask?: string;       // claim target/task description
  readonly costUsd: number;
  readonly tokens: number;
  readonly contextPercent?: number;
  readonly sessionName?: string;       // tmux/acpx session for terminal tab
  readonly pendingApproval?: PendingApproval;
  readonly contribCount: number;       // for thrash detection feedback
}

export interface FleetSummary {
  readonly total: number;
  readonly byState: Readonly<Record<AgentState, number>>;
  readonly approvalsPending: number;
  readonly costUsd: number;
}
```

## State classification heuristics

### Thresholds (`thresholds.ts`)

```ts
export interface SupervisionThresholds {
  readonly silentMs: number;             // default 120_000   (2m)
  readonly stuckMs: number;              // default 600_000   (10m)
  readonly thrashWindowMs: number;       // default 60_000    (1m)
  readonly thrashContribs: number;       // default 6         (≥6 contribs/min same target)
  readonly completedRetentionMs: number; // default 60_000    (keep done cards 1m)
  readonly costSpikeUsdPerMin: number;   // default 1.0       (annotation, not state)
  readonly contextPctWarn: number;       // default 85
  readonly contextPctCritical: number;   // default 95
}
```

Overridable via env `GROVE_TUI_SUP_*` (parsed in `thresholds.ts`) and per-session config. Invalid env values fall back to defaults with a debug log entry.

### Classification order

First match wins. Priority encodes operator urgency (approvals before failures before soft heuristics).

| # | State | Rule |
|---|-------|------|
| 1 | `awaiting` | `pendingApproval !== undefined` |
| 2 | `blocked` | `claim.lease.expiresAt < now` OR `handoff.target` unhealthy OR (when #163 lands) `handoff.state ∈ {overdue, blocked, dead_lettered}` |
| 3 | `thrashing` | `≥ thrashContribs` contributions to same target within `thrashWindowMs` |
| 4 | `stuck` | Same `currentTask` for > `stuckMs` AND contribution-kind diversity = 1 over the window (no progress markers) |
| 5 | `silent` | `now − lastContribAt > silentMs` AND lease valid |
| 6 | `running` | Active claim AND `lastContribAt` within `silentMs` |
| 7 | `done` | Claim status complete AND `now − completedAt < completedRetentionMs` |
| 8 | `idle` | No active claim |

### Annotations (additive, not state)

- `cost spike` — `costUsdPerMin > costSpikeUsdPerMin` → `⚠ $X/min` badge on otherwise-`running` cards.
- `context hot` — `contextPercent ≥ contextPctCritical` → `near-limit` badge regardless of primary state.

### Edge cases (each has a test)

- Brand-new agent (no contributions yet) → `running` until `silentMs` elapses from claim start, then `silent`. Don't classify a fresh agent as stuck.
- Handoff target unhealthy but agent itself producing contributions → still `blocked` (target dictates).
- Approval granted mid-tick → transitions `awaiting → running` next tick.
- Lease renewal flicker → recompute per tick; `useEventDrivenData` throttles.

## UI shell & layout

```
┌─────────────────────────────────────────────────────────────────┐
│ FLEET  7 run · 2 blk · 1 silent · 3 ⏸ approve   filter:[____]  │  banner  (3 lines)
│ goal: ship #193 supervision surface          [▓▓▓▓░░░░░ 42%]    │
│ cost: $4.21   ctx hot: 1   thrashing: 0                          │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                 │  grid    (flex)
│ │a-7a3  RUN ● │ │a-9b2  BLK ⨯ │ │a-2c4  ⏸APPR │                 │  3 cols
│ │rev claude   │ │impl codex   │ │scout claude │                 │  fixed
│ │last 42s     │ │stale 4m     │ │needs approve│                 │  26-col
│ │PR #304 rev  │ │C6 #299 impl │ │rm node_modu │                 │  width
│ │$0.42  73%   │ │$1.10  91%⚠  │ │$0.08  44%   │                 │
│ └─────────────┘ └─────────────┘ └─────────────┘                 │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                 │
│ │a-8f1 SLNT ◐ │ │a-3d9  DONE✓ │ │a-4e0  RUN ● │                 │
│ │   …                                                           │
├─────────────────────────────────────────────────────────────────┤
│ a-2c4 · [Feed] DAG  Term                              [Tab cyc] │  drill   (40%)
│ 12:04  contribution: ran tests                                   │  scoped to
│ 12:05  contribution: 3 pass 1 fail                               │  focused
│ 12:06  approval requested: rm node_modules                       │  agent
└─────────────────────────────────────────────────────────────────┘
```

### State color & icon

All colors reuse existing `theme.ts` keys (`error / stale / secondary / success / warning / info`). No new theme entries.

| State | Color (theme key) | Icon |
|-------|-------------------|------|
| `running` | `success` (green) | `●` |
| `silent` | `stale` (orange) | `◐` |
| `stuck` | `warning` (yellow) | `↻` |
| `thrashing` | `error` (red) | `↯` |
| `blocked` | `error` (red) | `⨯` |
| `awaiting` | `info` (blue/cyan) | `⏸` |
| `done` | `secondary` (grey) | `✓` |
| `idle` | `secondary` (grey) | `·` |

### Sort & filter

- **Default sort:** state severity (awaiting → blocked/thrashing → stuck/silent → running → done), then `lastActionAt` desc.
- **`/`** enters filter input (existing cmd-mode pattern). Substring matches id/role/task/state.
- **`s`** cycles sort: severity / role / cost / age.
- **`f`** cycles state filter: all / problems-only / running-only.

### Keyboard model

| Key | Action |
|-----|--------|
| `h/j/k/l` | Card cursor (left/down/up/right in grid) |
| `Enter` / `o` | Open drill-dock for focused card |
| `Tab` | Cycle drill-dock tab (Feed → DAG → Term) when drill open |
| `Esc` | Collapse drill-dock → clear filter → cancel quit |
| `/` | Enter filter input |
| `s` | Cycle sort |
| `f` | Cycle state filter |
| `A` | Jump to next pending approval → open approval modal |
| `y` / `n` | Approve / deny focused approval (in modal or per-card precedence) |
| `d` | Expand approval detail (full prompt) in modal |
| `c` | Copy focused card's agentId to clipboard |
| `g` / `G` | Top / bottom of grid |
| `Ctrl+G` | Open inspect overlay (existing) |
| `Ctrl+F` | Nexus folder browser (existing) |
| `1` / `2` / `3` | When drill open: switch directly to Feed / DAG / Term |
| `q` | Confirm quit (existing double-tap) |

### Removed bindings (vs. running-view)

- `1` / `2` / `3` / `4` global panel toggles. Their "expand panel N to half/full screen" semantics don't map to per-agent drill-down. `1` / `2` / `3` are repurposed to drill-tab selection inside the dock (Feed / DAG / Term) when drill is open; otherwise no-op. `4` is unbound (only three drill tabs). Documented in the commit message; no silent loss.
- `f` previously toggled fullscreen on an expanded panel — repurposed to state filter.

### Empty / degenerate states

- **0 agents:** centered `EmptyState` "No agents registered. Press r to register, Ctrl+P to spawn." (mirrors today's agent-list empty state).
- **1 agent:** grid renders one card; drill-dock opens by default (Enter auto-fired) since there's nothing to choose. Avoids the "over-scaffolded for a solo session" cost.
- **Scoped provider** (existing `useProviderScoped`): same empty state as today's agent-list; no fleet data leaks across sessions.

## Approvals integration

### Source

`useAgentMonitor` already exposes pending tmux permission prompts and contract decisions — the same data running-view consumes at `approvePermission` (line 876) and the `y:approve n:deny` hint (line 1791). Supervision takes over that wiring; **no new server contract**.

### Queue (`approval-queue.ts`)

```ts
export interface PendingApproval {
  readonly agentId: string;
  readonly requestId: string;
  readonly kind: "tmux-permission" | "contract-decision" | "handoff-reroute";
  readonly prompt: string;          // truncated body for card
  readonly fullBody: string;        // modal body
  readonly requestedAt: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ApprovalQueue {
  readonly pending: readonly PendingApproval[];
  readonly head: PendingApproval | undefined;        // oldest first
  readonly forAgent: (agentId: string) => PendingApproval | undefined;
  readonly accept: (requestId: string) => Promise<void>;
  readonly reject: (requestId: string) => Promise<void>;
}
```

- FIFO by `requestedAt`, deduped by `(agentId, requestId)`.
- `accept` / `reject` delegate to the same mutation path running-view uses today, wrapped in `confirm-and-mutate` when the kind requires it. Audit trail and toast feedback unchanged.

### `A` keypress flow

1. `routeKey('A')` → `actions.openNextApproval()`.
2. Hook returns `approvalQueue.head` → modal mounts, `modalApproval = head`.
3. `ApprovalModal` renders centered overlay (reuses `@opentui-ui/dialog/react`):

```
┌────────────────────────────────────────────┐
│ APPROVAL  a-2c4 · scout · claude           │
│ requested 8s ago                            │
├────────────────────────────────────────────┤
│ kind: tmux-permission                       │
│                                             │
│ cmd: rm -rf node_modules                    │
│ cwd: /repo/sub                              │
│                                             │
│ [y]es   [n]o   [d]etail   [Esc] dismiss    │
└────────────────────────────────────────────┘
```

4. `y` → `accept(requestId)` → toast → auto-advance to next pending if queue non-empty, else close.
5. `n` → `reject` (same flow).
6. `d` → toggle inline full-body pane (no new overlay).
7. `Esc` → close modal; focus returns to the card that owns the request.

### Per-card `y/n` precedence

When a card with `state === "awaiting"` is focused **and** the modal is closed, `y`/`n` act on that card directly (no modal). Operators with one approval get one keystroke; operators with a queue get the `A` flow.

Router precedence:
1. Modal open → modal keys.
2. Modal closed + focused card awaiting → card keys.
3. Otherwise → cmd-mode / filter / nav.

### Concurrency

- **Optimistic accept:** local removal first, server call awaited; on failure FlashBar surfaces error and entry re-appears at its original queue position.
- **New approval during modal open:** header counter increments (`requested 8s ago · 2 more queued`); modal does not auto-jump.
- **Stale approval** (target died between request and accept): server returns existing "stale" error, FlashBar shows it, queue entry drops.

## Migration & replacement plan

Six commits, each independently mergeable, each leaves the TUI runnable.

| # | Commit | Ships | Risk |
|---|--------|-------|------|
| 1 | `tui/supervision: pure heuristics + types` | `types.ts`, `thresholds.ts`, `derive-state.ts` + tests. Unwired. | Zero — dead code with tests |
| 2 | `tui/supervision: fleet aggregator hook` | `use-fleet-supervision.ts` + tests against fake provider. Unwired. | Zero |
| 3 | `tui/supervision: approval queue` | `approval-queue.ts` + tests. Read-only adapter, no UI. | Low |
| 4 | `tui/supervision: presentational shell` | All `supervision/*.tsx` files + tests. Registered as **new route only** (`/supervision`), reachable behind `GROVE_TUI_SUPERVISION=1`. Running-view untouched. | Low — opt-in, side-by-side |
| 5 | `tui/supervision: keyboard + filter` | `keyboard.ts` + tests. Drives the new screen. Running-view still default. | Low |
| 6 | `tui/supervision: flip default, retire running-view` | `screen-manager.tsx` swaps registration. `running-view.tsx`, `agent-list.tsx`, `running-keyboard.ts` + tests deleted. `running` route alias added. | Medium — visible default change |

The env flag in step 4 is **scaffolding**, not a long-lived gate; it is removed in step 6 in the same series. Rollback story is a single `git revert` of step 6 — steps 1-5 are net-additive and stay.

### Feature parity checklist (verified before step 6)

- [x] Contribution feed → drill-dock Feed tab
- [x] DAG view → drill-dock DAG tab (one-line `focusedAgentId` prop added)
- [x] Terminal view → drill-dock Term tab (selectedSession driven by focused card)
- [x] Inspect overlay (Ctrl+G) — kept at screen level
- [x] Nexus folder browser (Ctrl+F) — kept
- [x] VFS browser — kept
- [x] Permission `y/n` → approval modal + per-card precedence
- [x] Goal input / progress bar → moved to FleetBanner
- [x] Filter cmd-mode (`/`) — `running-cmd-mode.ts` reused
- [x] Quit confirm (`q` double-tap) — kept
- [x] Toast / FlashBar — kept

### Saved-session migration

`useTuiStatePersistence` currently stores `expandedPanel: RunningPanel`. On load:

```ts
function migrateRunningPanel(saved: RunningPanel | undefined): DrillTab | undefined {
  switch (saved) {
    case RunningPanel.Feed: return "feed";
    case RunningPanel.Dag: return "dag";
    case RunningPanel.Terminal: return "term";
    default: return undefined;  // grid stays focused (operator was on a list view)
  }
}
```

Storage key bumps so migration runs once; thereafter the persisted shape is `SupervisionState`.

## Testing strategy

### Unit (pure functions, no React)

| File | Coverage |
|------|----------|
| `derive-state.test.ts` | Each row of the classification table: ≥1 positive + ≥1 negative case. Priority/order (`awaiting` beats `blocked` when both hold). Edge cases: brand-new agent, lease flicker, handoff target down with own contribs, contribution-kind diversity stuck detection. ~25 cases. |
| `thresholds.test.ts` | Env override parsing, invalid values fall back to defaults, env beats config-file. ~6 cases. |
| `approval-queue.test.ts` | FIFO, dedup, optimistic accept rollback, concurrent accept rejects second caller, stale-target drop. ~8 cases. |
| `keyboard.test.ts` | Router precedence (modal → card-awaiting → default). Grid cursor hjkl + g/G + filter entry/exit. ~15 cases. |

### Component (React tree, mocked provider)

| File | Coverage |
|------|----------|
| `agent-card.test.tsx` | Each state renders correct badge color + icon + reason. Fixed 26-col width holds across state changes. |
| `agent-grid.test.tsx` | 3-col layout at N=1..30; scrolling at >9 cards; cursor wraps row boundaries. |
| `fleet-banner.test.tsx` | Counts match input. Filter input mounts via `/`. Approval chip bold-pulses on increase. |
| `drill-dock.test.tsx` | Tab switching; scoping prop forwarded to Feed/DAG/Term; collapse on Esc. |
| `approval-modal.test.tsx` | y/n routes to queue; auto-advance when more pending; detail toggle; counter on new pending without auto-jump. |
| `supervision-screen.test.tsx` | Empty state (0 agents); solo-agent auto-drill; scoped-provider empty state; saved-state migration. |

### Integration / E2E

| Test | Mechanism | Why |
|------|-----------|-----|
| `tests/tui/supervision-snapshot.test.ts` | Render `<SupervisionScreen>` against fixtured `FakeProvider` with 12 agents covering all states. Text snapshot. | Cheap visual regression coverage across state combinations. |
| `tests/tui/supervision-keyboard-e2e.test.ts` | Real screen, simulated keystrokes, real hook, fake provider. Walk a full operator session: filter → next approval → accept → drill → switch tabs → quit. | Verifies keyboard model end-to-end without a process. |
| `tests/e2e/supervision-real-grove.ts` | tmux + real `grove up`. Spawn 3 agents, induce stale handoff + pending approval, screenshot, accept, verify card transitions. | Wire-protocol changes (approval mutation path) need real-process verification per project convention. |

### Coverage gates

- **100% line coverage** on `derive-state.ts`, `thresholds.ts`, `approval-queue.ts`, `keyboard.ts` — pure modules, cheap to keep at 100%, prevents quiet drift.
- **≥80%** on presentational components.
- E2E harness exits non-zero on any unexpected toast or crash, not just failed assertions.

### Anti-flake measures

- All heuristic-dependent tests inject a fake `now` (no `Date.now()` in derive code paths).
- Component tests use the existing `mock @opentui-ui/toast/react` pattern (recent fix in commit `564b0bf3`).
- E2E uses the `--keep` tmux flag for failure inspection.

## Open questions

None — all design choices are locked. Implementation-time decisions (exact theme colors per state, precise scrollbar behavior in `agent-grid`, modal width) are deferred to the implementation plan but do not affect this design.

## Success criteria

Lifted from the issue and made measurable:

| Issue acceptance criterion | How we'll verify |
|---------------------------|------------------|
| Operator can understand fleet state at a glance | `tests/tui/supervision-snapshot.test.ts` — fleet banner counts and card badges are present and correct for a fixture covering all 8 states. |
| Problem agents stand out immediately | Cards in `awaiting / blocked / thrashing` use `danger`/`accent` theme colors and sort to the top by default. Snapshot test asserts ordering. |
| Approvals and interventions reachable from the same surface | `tests/tui/supervision-keyboard-e2e.test.ts` covers the full `A → modal → y → next` flow without leaving the screen. |
| Agent-level navigation faster than today | One keystroke (`Enter`) opens drill-dock vs today's two-step (panel switch then session selection). Documented in the migration commit. |
