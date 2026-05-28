# TUI Agent Supervision — Hero Surface (issue #193)

**Date**: 2026-05-18
**Issue**: [windoliver/grove#193](https://github.com/windoliver/grove/issues/193)
**Related**: #163 (stale-blocked handoff detection), #175 (agent monitor extraction), #310 (LogView)
**Status**: Draft — awaiting user review

## Problem

Grove's strongest UX opportunity is supervising many agents, but that experience is split across status lists (`AgentListView`), the contribution feed, terminal panes (`TerminalView`), handoffs (`HandoffsView`), and a floating Permission Request overlay. The operator surface should feel more like a live control room: lanes/cards per agent, clear health states, last action, current task, approval needs, cost, and one-keystroke jumps into related claims/contributions/output.

### Today's gaps (from `running-view.tsx` audit)

- **No fleet-glance surface.** Operators must page through panels (`1` feed, `2` agents, `3` DAG, `4` terminal) one at a time. None of these is a hero.
- **Status semantics are too coarse.** `deriveAgentStatus` in `agent-columns.ts` returns only `running | claimed | stalled | idle | expired | error`. The issue calls for `blocked / stuck / thrashing / silent`.
- **Approvals are divorced from agent context.** The Permission Request overlay (lines ~1873–1894 of `running-view.tsx`) floats above the bottom bar, not attached to the agent's lane.
- **Selected-agent context requires panel hops.** Pick agent in panel `2`, lose it on switch to panel `3` or `4`.

## Acceptance criteria (verbatim from #193)

- An operator can understand the fleet state at a glance.
- Problem agents stand out immediately.
- Approvals and interventions are reachable from the same supervision surface.
- Agent-level navigation is faster than today.

## Decision

Replace the feed-default body of `RunningView` with a new supervision body composed of a **dense fleet rail** (left, ~40% width) plus a **detail rail** (right, ~60% width) that always reflects the selected agent. Approvals become a row badge on the lane plus an in-rail prompt. Existing panels (Feed, DAG, Terminal, Trace, Handoffs) remain reachable but become drill-downs from the supervision body, and they inherit the selected-agent identity.

Three implementation alternatives were considered and rejected:

1. **Net-new screen** — duplicates state pipes, creates two mental models. Rejected.
2. **Hero-default refactor of RunningView** — selected. One supervision surface, reuses `useAgentMonitor`, `useEntities`, `useEventDrivenData`.
3. **Cards-on-Agents-panel only** — stays hidden behind key `2`. Fails the "hero" and "at-a-glance" acceptance criteria. Rejected.

## Module layout

```
src/tui/screens/supervision/
  fleet-rail.tsx           // left rail — dense lanes, cursor-driven
  detail-rail.tsx          // right rail — selected agent context
  agent-health.ts          // pure: derive blocked/stuck/thrashing/silent
  agent-health.test.ts
  supervision-actions.ts   // pure: action descriptors and enablement
  supervision-actions.test.ts
  use-fleet-model.ts       // hook: join claims+tmux+cost+handoffs+permissions
  use-fleet-model.test.ts
  supervision.tsx          // composes fleet-rail + detail-rail; owns selection
  supervision.test.tsx
```

`running-view.tsx` changes:

- When no panel is expanded, render `<Supervision />` instead of the feed body.
- Keep `RunningPanel.Feed` reachable (`1`); demoted to non-default.
- Remove the floating Permission Request overlay (~25 lines); supervision owns it.
- Net change: ~50 added, ~25 removed in `running-view.tsx`. New code lives in dedicated files ≤ ~250 lines each.

## Data model

`FleetAgent` (output of `useFleetModel`):

```ts
interface FleetAgent {
  readonly agentId: string;
  readonly agentName: string;
  readonly role: string;
  readonly platform: string;
  readonly session: string | undefined;
  readonly claim: ClaimEntity;
  readonly health: AgentHealth;
  readonly currentTask: string | undefined;
  readonly lastAction: string | undefined;
  readonly lastOutputAt: string | undefined;
  readonly cost: { usd: number; tokens: number; ctxPercent?: number } | undefined;
  readonly handoffs: { pendingOut: number; overdueIn: number; blockedOn?: string };
  readonly pendingApproval: PermissionPrompt | undefined;
  readonly attemptCount: number;
}
```

`AgentHealth` — discriminated union replacing today's status string:

```ts
type AgentHealth =
  | { kind: "running" }
  | { kind: "idle" }
  | { kind: "approval"; cmd: string }
  | { kind: "blocked"; on: string; sinceMs: number }
  | { kind: "stuck"; sinceMs: number }
  | { kind: "thrashing"; retries: number }
  | { kind: "silent"; sinceMs: number }
  | { kind: "error"; reason: string }
  | { kind: "expired" };
```

### Derivation rules (`deriveAgentHealth(fleet, now, thresholds)` in `agent-health.ts`)

Evaluated top-down; first match wins.

| Priority | Condition | Result |
|---|---|---|
| 1 | `agentFailures.has(role)` | `error` (uses ACP bootstrap/auth failure message) |
| 2 | `pendingApproval !== undefined` | `approval` |
| 3 | `lease expired` | `expired` |
| 4 | `attemptCount >= 3` and last claim retry within 30 s | `thrashing` |
| 5 | `handoff.blockedOn !== undefined` and `sinceMs > 60_000` | `blocked` |
| 6 | `now - lastOutputAt > SILENT_MS` (default 5 min) | `silent` |
| 7 | `currentTask unchanged for STUCK_MS` (default 8 min) and `lastOutputAt` recent | `stuck` |
| 8 | `now - claim.heartbeatAt > 60_000` | `silent` (heartbeat lapse) |
| 9 | session alive + recent output | `running` |
| 10 | otherwise | `idle` |

Thresholds are exported constants for test overrides:
`SILENT_MS = 5 * 60_000`, `STUCK_MS = 8 * 60_000`, `THRASH_RETRIES = 3`, `THRASH_WINDOW_MS = 30_000`, `BLOCKED_MIN_MS = 60_000`.

### Sort order (problem-first)

`error > approval > blocked > stuck > thrashing > silent > running > idle > expired`; ties broken by role (`coordinator` first) then `agentName`.

## Components

### `<Supervision>`

- Owns: `selectedAgentId`, `cursor`, `pinnedSelection` ref, `filterText` (from C2 cmd-mode).
- Calls `useFleetModel({ provider, monitor, eventBus, topology, filterText })`.
- Renders fleet-rail and detail-rail in a horizontal box.
- Auto-selects highest-priority agent on mount and on new-approval events (skipped when `pinnedSelection.current === true`).
- After approve/deny resolves, unpins so the next problem agent floats up.
- Dispatches `onAction(agentId, action)` from key handlers and from detail-rail action footer.

### `<FleetRail>`

- Header: `Fleet (N · {x problem})` with counts by health kind.
- Each lane: `[health-icon] [role-badge] [agentName trunc14] [task/last-action trunc40] [age] [cost]`.
- Cursor row gets `►` prefix + `theme.focus` background.
- Approval lanes show `[y/n]` suffix in `theme.warning`.
- Blocked lanes show `← from-role` in `theme.error`.
- Empty state mirrors current `AgentListView` copy: "No agents registered. Press r to register, or Ctrl+P to spawn."

### `<DetailRail>`

Stacked sections, top-down:

1. **Header** — agent name + role + health badge with sinceMs ("STUCK 8m", "BLOCKED 3m on coordinator").
2. **Task** — `currentTask`, `targetRef`, claim age.
3. **Approval** (only when `health.kind === "approval"`) — full command + key hints `[y]allow [n]deny [a]always`.
4. **Tail** — last 8 lines from `monitor.agentOutputs.get(role)`.
5. **Handoffs** — counts and `blockedOn` line if any.
6. **Cost** — `$X · Y tok · Z% ctx`.
7. **Actions footer** — keyhints `[t]ail · [d]ag · [r]eroute · [k]ill · [m]essage`.

Placeholder when `selectedAgentId === undefined`: "Select an agent (j/k) to view context".

### Existing-view reuse

- `<TerminalView>` unchanged; reached via `t` from detail rail (fullscreens scoped to selected agent).
- `<DagView>`, `<HandoffsView>` gain an additive optional prop `filterAgentId` so drill-downs inherit the selected agent. Default behavior unchanged when prop omitted.
- The Permission Request overlay block in `running-view.tsx` is removed; supervision is the only host.

## Keyboard model

New keys apply only when no panel is expanded (`expandedPanel === null`). They run before the global router:

```
if (expandedPanel === null) supervisionKeyboard.handle(key) ?? globalRouter.handle(key)
```

| Key | Action |
|---|---|
| `j` / `k` | Move fleet-rail cursor (also applies inside expanded Agents panel for consistency) |
| `Enter` | Pin selection |
| `g` / `G` | Top / bottom of fleet |
| `y` / `n` / `a` | Approve / deny / always-allow on the selected agent's approval |
| `t` | Open Terminal panel scoped to selected agent |
| `d` | Open DAG panel scoped to selected agent |
| `r` | Reroute blocked handoff (only when `health.kind === "blocked"`); confirmation via existing safety/useConfirmAndMutate |
| `K` (capital) | Kill / revoke claim (safety-confirmed) |
| `m` | Open `<Prompt>` to message the selected agent's role |
| `1`–`4` | Expand panel (unchanged); panel inherits `selectedAgentId` |
| `/` / `:` | C2 cmd-mode; filter narrows lanes via `useFleetModel` predicate |
| `e` | Trace pane (unchanged) |
| `Esc` | Collapse panel → unpin selection → cancel quit |

Help overlay (`?`) gains a "Supervision" section listing the new shortcuts.

## Data flow

```
provider (informer / Nexus SSE push)
  ├─ claims watch ───────────────┐
  ├─ contributions watch ────────┤
  ├─ handoffs watch ─────────────┤
  └─ permissions/IPC via eventBus┤
                                 ▼
   useAgentMonitor (existing)  ─→ outputs / permissions / IPC / spinner
                                 │
                                 ▼
   useFleetModel  ────────────→ FleetAgent[] (memoized join + health derive)
                                 │
                                 ▼
   <Supervision>  ──→ <FleetRail> + <DetailRail>
```

- `useFleetModel` consumes `useEntities` watches; no new polling loops.
- Health derivation runs in the same `useMemo` as the join; recomputed only when source data changes.
- `useAgentMonitor` gets an additive extension: alongside `agentOutputs: Map<role, string[]>` it also exposes `agentOutputTimestamps: Map<role, string>` — the ISO timestamp of the most recent update per role, written whenever `setAgentOutputs` runs. This is the source for `FleetAgent.lastOutputAt`. The extension is pure additive: existing consumers (Trace pane, etc.) keep working.
- `silent` detection compares `now - lastOutputAt` against `SILENT_MS`; because `setAgentOutputs` runs on push, the timestamp inherits push semantics. The `silent` threshold itself is a wall-clock comparison, which the existing braille spinner re-render at ~80 ms covers — no new timer.
- Wall-clock badge refresh ("STUCK 3m" → "STUCK 4m") rides the same spinner re-render.

### Action dispatch

| Action | Implementation |
|---|---|
| `approve` / `deny` / `always` | `tmux.sendKeys(session, "y" / "n" / "a")` — existing `handlePermissionResponse` path |
| `kill` | `provider.revokeClaim(claimId)` via `useConfirmAndMutate` |
| `message` | Existing `onSendToAgent(role, msg)` prop on `RunningView` |
| `reroute` | `provider.rerouteHandoff(handoffId)` — disabled with tooltip "Reroute lands with #163" until that backend ships |

## Rollout

- Ship behind env flag `GROVE_SUPERVISION=1`. Default off in the first PR; supervision-body code lives alongside today's feed-default branch.
- Flip the default in a follow-up PR once stable. Keep `GROVE_SUPERVISION=0` as an escape hatch for one release cycle, then remove the feed-default branch.
- C2 cmd-mode, screen-stack, pagesTop sync untouched until the flag flips.

## Testing strategy

### Pure modules (Vitest, no React)

| File | Coverage |
|---|---|
| `agent-health.test.ts` | Every health kind across a `(claim, monitor outputs, handoffs, permissions, now, thresholds)` matrix. Priority ordering: error beats blocked beats stuck. Threshold edges (`SILENT_MS - 1` vs `SILENT_MS + 1`). |
| `supervision-actions.test.ts` | Action enablement per health kind: `reroute` only when `blocked`; `kill` always except `expired`; `approve/deny/always` only when `approval`. |
| `use-fleet-model.test.ts` | Join correctness: claim without tmux session leaves `session` undefined; cost rollup matches by `agentId`; handoff `blockedOn` aggregation; sort order with mixed-health input; C2 filter narrows result. |
| `use-agent-monitor.test.ts` (existing) | New assertion: each `setAgentOutputs` write also updates `agentOutputTimestamps` for the affected role. |

### Components (OpenTUI react-test renderer, mirroring `running-view.c2.test.tsx`)

| File | Coverage |
|---|---|
| `fleet-rail.test.tsx` | Render snapshot per health kind. Cursor movement on `j/k`. Filter prop narrows visible lanes. Empty state. |
| `detail-rail.test.tsx` | Each section renders for the selected agent. Approval section shows command + key hints. Placeholder when no selection. |
| `supervision.test.tsx` | Auto-select-highest-priority on mount. Auto-select on new approval (when not pinned). Pinned selection survives data refresh. Action dispatch routes to provider/tmux mocks. |

### Integration smoke (`tests/tui/`)

- `supervision-e2e.ts` — spawn nexus + 2 ACPX agents via `grove up`, force one into a stalled state, assert TUI capture frame contains lane with health badge and detail-rail shows tail. Hit Nexus stores, not local SQLite.

### Regression guards

- Keyboard test: `j/k` move cursor in supervision body (not feed scroll).
- Keyboard test: `Esc` from expanded panel returns to supervision with selection intact.
- Snapshot test: floating `Permission Request` box no longer rendered by `running-view.tsx` when supervision body is active.

## Out of scope (tracked separately)

- Reroute action — depends on issue #163 backend.
- Contribution-history sub-panel in detail rail — follow-up.
- Per-agent IPC message filtering — follow-up.
- Collapsible detail-rail sections — v1 is fixed stacked layout.

## Open questions

None blocking. Threshold defaults (`SILENT_MS = 5m`, `STUCK_MS = 8m`, `THRASH_RETRIES = 3`) are starting points; tune after first dogfood pass.
