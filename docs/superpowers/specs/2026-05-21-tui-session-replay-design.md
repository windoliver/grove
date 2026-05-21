# TUI Session Replay on Resume

## Context

Issue #184 reports that choosing Resume can land an operator in `RunningView`
without the prior session context they expect. The trace pane may only show live
tail output, and the contribution feed may show only the current refresh window
instead of the selected session's full history.

The predecessor issue #183 is already mostly present in the codebase:

- the welcome fast path lists sessions and resumes the focused session id;
- `ScreenManager` scopes providers to the resumed session;
- the trace pane can render historical lines dimmed;
- `SpawnManager` saves and loads per-session JSONL trace files under
  `.grove/agent-logs/{sessionId}/{role}.jsonl`.

The remaining design work is to make resume deterministic across local,
Nexus-backed, and remote HTTP providers without depending on a Nexus
time-travel API that is not currently exposed in Grove.

## Goals

- On Resume, pre-populate agent traces for the selected session before live log
  polling appends new lines.
- On Resume, display all contributions linked to the selected session, not only
  the default or capped contribution list page.
- Preserve the existing session selector behavior on the welcome screen.
- Keep the implementation compatible with future Nexus `versioning` and
  `snapshot` replay APIs by isolating replay behind narrow provider/data-store
  boundaries.
- Avoid cross-session data leaks when history loading fails or a selected
  session id is stale.

## Non-Goals

- Implement Nexus `VersionService`, `TimeTravelService`, or snapshot APIs in
  Grove.
- Replace the trace pane UI from #183.
- Change session creation, archive, or delete semantics.
- Load unbounded global contribution history outside the selected session.

## Recommended Approach

Ship a Grove-side replay path first, using APIs and stores already present in
this repository:

1. Read full session contribution history from session contribution links.
2. Batch-load the linked contributions in session order.
3. Seed `RunningView` with that historical baseline.
4. Keep live watch, event, and poll refresh paths as the mechanism for new
   contributions after resume.
5. Keep trace history loading through `AgentLogBuffer` and `trace-persistence`,
   but shape the call site so a later Nexus-backed trace history store can be
   substituted.

This is lower risk than blocking on Nexus time travel. It directly fixes the
operator-visible resume behavior and creates an adapter seam for the Nexus
bricks described in the issue comment.

## Architecture

Add a narrow session-history capability to the TUI provider layer. The provider
contract is a dedicated method:

```ts
getSessionContributions(sessionId: string): Promise<readonly Contribution[]>;
```

The method contract is:

- the caller supplies a session id;
- results include all contributions linked to that session;
- results preserve session link order or stable creation order;
- implementations must not fall back to unscoped contribution lists.

Provider implementations:

- Local provider: use the SQLite session contribution junction table, then
  batch-load contributions from the contribution store.
- Nexus in-process provider: use `NexusSessionStore.getContributions(sessionId)`
  or the session-scoped `NexusContributionStore`, then batch-load contributions.
- Remote provider: call a dedicated server endpoint such as
  `GET /api/sessions/:id/contributions` that returns all linked contributions
  or pages them with an explicit completion signal. It must not rely on
  `/api/contributions` without pagination because the route defaults to 20 and
  caps a single page at 100.

Trace history remains owned by `SpawnManager` for now:

- `ScreenManager` sets the resumed session id on `SpawnManager`;
- it ensures log buffers exist for topology roles;
- it calls `spawnManager.loadTraces(sessionId)`;
- loaded lines enter `AgentLogBuffer` with `historical: true`, so `TracePane`
  renders them dimmed;
- live log polling starts only after history is loaded or skipped.

A future Nexus trace adapter can implement the same trace load/save boundary and
source historical lines from Nexus versioning/snapshot data.

## Resume Data Flow

1. `WelcomeScreen` passes the selected `sessionId` to `TuiApp.handleResume`.
2. `main.ts` starts services and pre-scopes the provider before informer/watch
   wiring begins.
3. `ScreenManager` starts directly on `running` with the selected `sessionId`.
4. `ScreenManager` writes `current-session.json`, sets provider scope, sets
   `SpawnManager.sessionId`, ensures role log buffers, and loads trace history.
5. `RunningView` performs one session-history load for the selected session and
   uses it as the initial contribution feed.
6. Live EventBus/watch/poll refreshes continue to update the feed after the
   historical baseline.
7. The trace pane displays historical lines dimmed and live lines normally.

## Error Handling

- If contribution history loading fails, `RunningView` remains usable and the
  existing live refresh path continues. The UI should surface the error through
  existing stale/error status plumbing rather than silently substituting
  unscoped data.
- If trace history loading fails, resume continues with empty historical traces
  and live log polling.
- If the selected session no longer exists in the startup list, existing
  best-effort scoping remains valid, but history loaders must return empty or an
  error rather than falling back to another session.
- If remote pagination partially fails before a complete session history is
  assembled, discard the incomplete baseline, surface the error, and continue
  with live session-scoped refresh. Do not merge in global contribution results.
- Malformed trace JSONL lines continue to be skipped, matching the current
  `AgentLogBuffer.loadFromJsonl` behavior.

## Testing Plan

- Provider tests:
  - local session history returns all linked contributions in deterministic
    order;
  - Nexus/mock session history reads all linked contribution ids and batch-loads
    them;
  - remote session history paginates beyond the single-route page cap;
  - history methods do not fall back to unscoped contribution lists on failure.
- Resume orchestration tests:
  - `ScreenManager` scopes to the selected session and invokes trace load for
    that exact session id;
  - selected-session resume does not auto-pick another active session.
- Running view or hook-level tests:
  - a resumed session with more than 100 contributions renders all historical
    contributions before live refreshes;
  - subsequent live contributions append/update without duplicating the
    historical baseline.
- Trace tests:
  - loaded JSONL lines are marked historical;
  - newly polled log lines are not historical;
  - missing trace files are non-fatal.

## Implementation Notes

- Keep changes scoped to TUI provider/session-history surfaces, server session
  endpoints if needed, and focused tests.
- Prefer batch contribution loading over N individual reads when the backing
  store supports `getMany`.
- Keep the existing `setSessionScope` behavior; session history is an initial
  replay read, not a replacement for provider scoping.
- Avoid increasing `/api/contributions`' general cap just to satisfy resume.
  A dedicated session-history route or helper is more explicit and avoids
  accidental large global reads.
- The Nexus time-travel comment on #184 should be documented as a future
  adapter source, not as a hard dependency for this fix.
