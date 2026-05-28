# Stale Blocked Handoff Visibility Design

**Issue:** [windoliver/grove#163](https://github.com/windoliver/grove/issues/163)
**Date:** 2026-05-20
**Status:** Draft

## Problem

Grove already persists handoff delivery lifecycle state, but operators do not yet get a clear answer to the operational question: "which routed work is merely waiting, which is late, which cannot be handled because the target is unhealthy, and which failed delivery entirely?"

The current model has durable statuses:

- `pending_pickup`
- `delivered`
- `processed`
- `replied`
- `expired`
- `dead_lettered`

`expired` is used for deadline expiry and `dead_lettered` is used for delivery failures. The TUI handoff panel shows raw lifecycle state and deadline labels, but it does not derive a health-aware `blocked` state from agent or session availability. The boardroom summary also does not expose handoff health counts or remediation actions.

## Goals

- Distinguish operator-facing handoff states: `pending`, `overdue`, `blocked`, and `dead_lettered`.
- Incorporate target agent/session health into blocked detection, not only missing contribution replies.
- Surface pending replies, overdue handoffs, blocked handoffs, and delivery failures in the TUI and boardroom summary.
- Add safe operator action affordances for resend, reroute, cancel, and manual resolve.
- Keep existing store implementations and handoff state machine stable for `pending`, `overdue`, and `blocked`; add only the terminal states needed to make operator actions durable.

## Non-Goals

- Do not add persisted `blocked` or `overdue` `HandoffStatus` values in this slice.
- Do not migrate existing SQLite or Nexus handoff data.
- Do not change the semantics of `expired` or `dead_lettered`.
- Do not persist `blocked` or `overdue`; they remain projection states.
- Do not implement full scheduler-level rerouting policy. The first reroute path should be explicit and operator selected.
- Do not add cross-process leader election or global health consensus.

## Recommendation

Use derived operator-facing state.

The persisted handoff lifecycle remains the durable fact source. A pure projection layer maps each `Handoff` plus optional runtime/session health into a `HandoffOperatorState`. This avoids persisting transient health observations as irreversible durable state.

Operator cancellation and manual resolution are different: they are explicit operator decisions and must be durable. Add terminal persisted statuses for those actions while keeping `blocked` and `overdue` derived.

## Current State

Relevant existing files:

- `src/core/handoff.ts` defines the handoff lifecycle and store interface.
- `src/core/in-memory-handoff-store.ts`, `src/local/sqlite-handoff-store.ts`, and `src/nexus/nexus-handoff-store.ts` implement the store contract.
- `src/core/deadline-watcher.ts` expires overdue unresolved handoffs and emits `handoff.overdue`.
- `src/server/routes/handoffs.ts` exposes list, get, and delivered acknowledgement endpoints.
- `src/mcp/tools/handoffs.ts` exposes read, ack, process, and dead-letter tools for agents.
- `src/tui/views/handoffs-view.tsx` renders handoffs in the running TUI.
- `src/tui/hooks/use-agent-monitor.ts`, `src/tui/components/columns/agent-columns.ts`, and `src/core/agent-task.ts` already contain health-like signals.
- `src/server/routes/boardroom.ts` aggregates hot operator data but currently omits handoff health.

## Architecture

Add a pure projection module:

`src/core/handoff-operator-state.ts`

This module owns:

- `HandoffOperatorState`
- `HandoffHealthSignal`
- `HandoffOperatorProjection`
- `deriveHandoffOperatorState(handoff, options)`
- count helpers for boardroom summaries

The module has no I/O and does not depend on React, Hono, SQLite, Nexus, or tmux. Server routes and TUI components can share the same semantics.

```ts
export const HandoffOperatorState = {
  Pending: "pending",
  Overdue: "overdue",
  Blocked: "blocked",
  DeadLettered: "dead_lettered",
  Resolved: "resolved",
  Cancelled: "cancelled",
  ManuallyResolved: "manually_resolved",
} as const;
```

`Resolved` is not part of the issue acceptance criteria, but the projection should still return it for `replied` handoffs so callers do not need a separate branch.
`Cancelled` and `ManuallyResolved` are returned for explicit operator terminal states so the UI can show final action outcomes without folding them into deadline expiry.

## Projection Rules

The projection uses durable status first, then target health, then deadline.

1. `dead_lettered` always projects to `dead_lettered`.
2. `replied` projects to `resolved`.
3. `cancelled` projects to `cancelled`.
4. `manually_resolved` projects to `manually_resolved`.
5. `expired` projects to `overdue`.
6. Unresolved handoffs with an unhealthy target project to `blocked`.
7. Unresolved handoffs whose `replyDueAt` is in the past project to `overdue`.
8. Remaining unresolved handoffs project to `pending`.

Unresolved persisted statuses are:

- `pending_pickup`
- `delivered`
- `processed`

The target is unhealthy when any health signal says:

- target role has a spawn/bootstrap failure
- target role has no live tmux session when topology expects one
- target session is archived, cancelled, missing, crashed, or failed
- target `AgentTask` has `phase = Failed`
- target `AgentTask` has `Blocked=True`, `Unschedulable=True`, or `Failed=True`
- target claim lease is expired, when claim data is available

The projection returns a short reason string such as `target session missing`, `agent task failed`, `claim lease expired`, or `deadline passed`.

## Health Inputs

Use optional health inputs so each surface can pass only what it knows.

TUI running view can pass:

- `topology.roles`
- `agentFailures`
- tmux live sessions via `TmuxManager.listSessions()`
- `AgentTaskView[]` from `provider.getAgentTasks()` when available
- session status for the current `sessionId` when available

Server boardroom can pass:

- handoffs from `handoffStore`
- sessions from `goalSessionStore`
- agent tasks from `agentTaskStore`, when configured

If no health inputs are available, the projection still distinguishes `pending`, `overdue`, `dead_lettered`, and `resolved` from the handoff alone. It simply does not mark a handoff `blocked`.

## Boardroom API

Extend `GET /api/boardroom/summary` with a handoff summary:

```ts
handoffs: {
  pending: number;
  overdue: number;
  blocked: number;
  deadLettered: number;
  items: HandoffOperatorProjection[];
}
```

The route should:

- respect `?sessionId=` by using `handoffStoreForSession` when available
- call `expireStale()` before projecting so overdue status is fresh
- cap `items` to a small operator-friendly limit, such as 20
- keep existing `pendingQuestions`, `recentMessages`, `costSummary`, and `activeClaimCount` fields unchanged

## TUI

Update `src/tui/views/handoffs-view.tsx` to render projected state instead of only raw status.

Recommended columns:

- `FROM`
- `TO`
- `STATE`
- `REASON`
- `RECEIPT`
- `DEADLINE`
- `ACTIONS`
- `SOURCE CID`

Header counts should include:

- total
- pending
- overdue
- blocked
- dead-lettered

Blocked and dead-lettered rows should use `theme.error`. Overdue rows should use `theme.stale` or `theme.warning` if available. Pending rows remain neutral.

## Operator Actions

Add action semantics in the projection first so the TUI can render consistent affordances:

- `resend`: available for `pending`, `overdue`, `blocked`, and `dead_lettered`
- `reroute`: available for `blocked` and `dead_lettered`
- `cancel`: available for `pending`, `overdue`, and `blocked`
- `manual_resolve`: available for `overdue`, `blocked`, and `dead_lettered`

The first implementation should add explicit server endpoints only for actions that can be implemented safely against current stores:

- `POST /api/handoffs/:id/resend`
- `POST /api/handoffs/:id/cancel`
- `POST /api/handoffs/:id/manual-resolve`

`reroute` should require an explicit target role:

- `POST /api/handoffs/:id/reroute` with `{ "toRole": "reviewer-2" }`

`cancel` transitions an unresolved, expired, or dead-lettered handoff to `cancelled`. `manual-resolve` transitions an unresolved, expired, or dead-lettered handoff to `manually_resolved`. `resend` creates a replacement handoff for the same role and transitions the original to `cancelled` with a replacement reference. `reroute` creates a replacement handoff to the selected role and transitions the original to `cancelled` with a replacement reference.

## Durable State Changes

No new durable state is required for `pending`, `overdue`, `blocked`, or `dead_lettered`.

Operator cancellation and manual resolution require durable terminal states:

- `cancelled`: an operator stopped waiting for this handoff.
- `manually_resolved`: an operator declared the handoff handled outside the normal reply path.

Update `HandoffStatus`, `VALID_TRANSITIONS`, all HandoffStore implementations, route schemas, MCP schemas where relevant, and conformance tests. Do not reuse `expired` for cancellation, because `expired` is deadline-derived and already feeds overdue semantics.

Valid transitions:

- `pending_pickup -> cancelled`
- `delivered -> cancelled`
- `processed -> cancelled`
- `expired -> cancelled`
- `dead_lettered -> cancelled`
- `pending_pickup -> manually_resolved`
- `delivered -> manually_resolved`
- `processed -> manually_resolved`
- `expired -> manually_resolved`
- `dead_lettered -> manually_resolved`

Both `cancelled` and `manually_resolved` are terminal.

## Testing

Core tests:

- `deriveHandoffOperatorState` maps pending unresolved handoffs to `pending`.
- past unresolved deadline maps to `overdue`.
- `expired` maps to `overdue`.
- `dead_lettered` maps to `dead_lettered`.
- unhealthy target maps unresolved handoff to `blocked`.
- `dead_lettered` wins over health and deadline.
- `replied` maps to `resolved`.
- `cancelled` maps to `cancelled`.
- `manually_resolved` maps to `manually_resolved`.

Server tests:

- `/api/boardroom/summary` includes handoff counts.
- session-scoped boardroom requests do not leak handoffs from other sessions.
- boardroom summary expires stale handoffs before projecting.

TUI tests:

- HandoffsView renders `blocked`, `overdue`, `pending`, and `dead_lettered` states.
- blocked rows include a reason.
- action labels match the projection and do not show disabled fake mutations as enabled.
- RunningView continues to refresh handoffs on feed changes and while the panel is visible.

Store tests:

- Store tests are not needed for derived `pending`, `overdue`, or `blocked`.
- State-machine and HandoffStore conformance tests are required for `cancelled` and `manually_resolved`.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Operators may expect `blocked` to be durable. | Label it as a health-derived state in docs and keep raw lifecycle status available in detail views. |
| Health inputs differ between local and remote TUI modes. | Projection accepts optional health data and degrades to deadline/status-only semantics. |
| `expired` currently means deadline expiry, while the issue calls the operator state `overdue`. | Use `overdue` in the projection and retain `expired` as the durable lifecycle status. |
| Action endpoints can become unsafe without auth. | Keep role-sensitive mutations out of unauthenticated HTTP. Operator actions must be explicit, session-scoped, and limited to operator surfaces. |
| Reroute could duplicate work unexpectedly. | Require explicit target role and create a replacement handoff rather than mutating historical provenance silently. |
| New terminal statuses expand store conformance scope. | Add them in one isolated TDD task before wiring action endpoints. |

## Acceptance Criteria Mapping

- Grove can distinguish `pending`, `overdue`, `blocked`, and `dead_lettered` handoffs through `HandoffOperatorProjection`.
- Blocked detection incorporates agent runtime or session health through optional health signals.
- TUI and boardroom show pending replies, overdue handoffs, blocked handoffs, and delivery failures through shared projection counts and labels.
- Operator actions exist as projected affordances and as durable transitions for cancel/manual resolve, with reroute creating a replacement handoff and terminally closing the original.
