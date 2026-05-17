# Review-Loop → AgentTask Migration Design

## Summary

This design closes the gap left open by PR #439 (scheduler framework, #300): the legacy review-loop (codex submits → claude reviews) still runs on the `SessionOrchestrator` path and never reaches the new `TaskController`/`Scheduler`. This spec adds an opt-in path that routes a full codex→claude review loop through `AgentTask` + the scheduler, with no changes to the existing `grove session start` flow.

The core moves are:

- A new `grove review-loop` CLI command that POSTs two chained `AgentTask` records (coder + reviewer with `dependsOn`) to a running grove-server.
- A `Succeeded` transition in `TaskController` driven by a new `DoneSignaled` condition.
- An MCP-side change to `grove_done` that PATCHes the bound task with `DoneSignaled=True` before writing the legacy contribution.
- A small `DefaultBind` extension that prepends each dependency's `Succeeded` condition message to the new task's prompt, so the reviewer sees what the coder did.

Result: a real codex→claude handoff runs filter → score → permit → bind for each agent, blocks on `dependsOn`, and exits cleanly when both reach `Succeeded`.

## Goals

- Add an opt-in `grove review-loop start` CLI that creates two `AgentTask` records (coder, reviewer with `dependsOn=[coder-id]`).
- Add a `Succeeded` transition path in `TaskController.reconcileRunning` driven by a `DoneSignaled=True` condition.
- Wire `grove_done` MCP tool to PATCH the bound `AgentTask` status when `GROVE_AGENT_TASK_ID` is set in the agent process env.
- Extend `DefaultBind` to prepend each dependency's `Succeeded` summary into the bound task's prompt.
- Provide a tmux E2E that runs a real codex→claude review loop end-to-end against grove-server.
- Preserve back-compat: `grove session start`, `SessionOrchestrator`, the contribution/handoff/bounty pipeline, and the legacy `grove_done` behavior are unchanged for agents not bound to an `AgentTask`.

## Non-Goals

- Replacing `SessionOrchestrator` or migrating `grove session start` to the new path.
- Migrating contribution/bounty/handoff stores or routes to `AgentTask`.
- Multi-reviewer fan-out (one coder, multiple reviewers in parallel).
- Cascade cancellation of dependent tasks when a dependency moves to `Failed`. Today's behavior is "dependent stays Pending forever"; that's a `TaskController` policy gap to revisit in #285's remaining issues (likely #306 GC or a follow-up).
- New metrics / Prometheus endpoint. The existing watch protocol already emits `entity.changed` envelopes for AgentTask writes.
- Dynamic task creation at handoff time (e.g., codex's `grove_submit_work` spawning a new reviewer task). Static `dependsOn` at creation only.

## Current State

`grove session start` constructs a `SessionOrchestrator` (`src/core/session-orchestrator.ts`, 890 LOC) that owns the entire review loop in-process: workspace bootstrap, agent spawn via `runtime.spawn`, topology routing, contribution polling, and session termination on a "done" contribution from a required-terminator role.

`grove_done` MCP tool (`src/mcp/tools/done.ts`) writes a contribution with `context.done=true` via `contributeOperation`. Session ends when a required-terminator role's done marker is observed.

`TaskController` (PR #439) handles `AgentTask` reconciliation: `Pending → PendingBind → Running → Failed`. `reconcileRunning` checks for live session via `runtime.listSessions()` — alive → catch up; gone → `failLostSession`. The `Succeeded` phase exists in the enum and `dependsOn` checks look for it (`task-controller.ts:446`), but no code ever writes `Succeeded`. So `dependsOn` chains never unblock today.

`AgentTaskConditionType` (post-PR #439): `Admitted | Scheduled | Bound | Running | AwaitingReview | Succeeded | Failed | Blocked | Unschedulable | PermitRequired`.

`DefaultBind` (`src/core/scheduler/plugins/default-bind.ts`) reads `task.spec.prompt` verbatim into `AgentConfig.prompt` and injects `GROVE_AGENT_TASK_ID` + `GROVE_AGENT_TASK_GENERATION` into the agent's process env.

`grove-server` already exposes `PUT /api/agent-tasks/:id` (create/update spec) and `PATCH /api/agent-tasks/:id/status` (controller-owned status writes guarded by `X-Grove-Controller-Token`). The MCP server does NOT have controller-token access, so `grove_done`'s PATCH from MCP goes through the bearer-token path used by other agent-task routes — verify route accepts MCP-bearer for `conditions` patches (existing tests in `agent-tasks.test.ts` may already cover this).

## Architecture

### Module map

**New files**

- `src/cli/commands/review-loop.ts` — CLI subcommand handler. ~250 LOC. Mirrors `session.ts` structure.
- `src/cli/commands/review-loop.test.ts` — unit tests for prompt + payload construction.
- `src/core/scheduler/upstream-prompt.ts` — pure function `buildPromptWithUpstream(basePrompt, sections)`.
- `src/core/scheduler/upstream-prompt.test.ts` — unit tests.
- `src/mcp/agent-task-context.ts` — env reader `readAgentTaskContext(env)`.
- `src/mcp/agent-task-context.test.ts` — env-parsing tests.
- `tests/e2e/review-loop-codex-claude-tmux.ts` — full tmux E2E. ~350 LOC.

**Modified files**

- `src/core/agent-task.ts` — add `DoneSignaled` to `AgentTaskConditionType`.
- `src/core/task-controller.ts` — add `Succeeded` transition path in `reconcileRunning`; add `sessionToCloseOnSuccess` field to `ReconciliationResult`.
- `src/core/scheduler/framework.ts` — broaden `SchedulerContext.store` Pick to include `getAgentTask`.
- `src/core/scheduler/plugins/default-bind.ts` — fetch dependency `Succeeded` conditions; wrap prompt.
- `src/core/scheduler/plugins/default-bind.test.ts` — tests for dependency prompt wrapping.
- `src/core/task-controller.test.ts` — tests for `Succeeded` transition + `dependsOn` unblocking chain.
- `src/mcp/tools/done.ts` — PATCH bound AgentTask before writing contribution.
- `src/mcp/tools/done.test.ts` — tests for PATCH branch.
- `src/cli/main.ts` — register `review-loop` subcommand.
- `src/server/routes/agent-tasks.test.ts` — explicit test that status PATCH with conditions+`DoneSignaled` works via bearer auth.

### Coexistence (strangler-fig)

The new `grove review-loop` path runs entirely on top of `AgentTask` + `Scheduler`. The legacy `grove session start` continues to use `SessionOrchestrator` and is untouched. MCP tools work for both paths:

- `grove_done` from an agent bound to an `AgentTask` (env vars present) → PATCH then contribution.
- `grove_done` from an agent spawned by `SessionOrchestrator` (no env vars) → contribution only (today's behavior).

Both `contributeOperation` calls keep firing because contributions still power the TUI contribution view, bounty store, and downstream consumers that the AgentTask system does not yet replace.

### Data flow (codex → claude review)

1. User runs `grove review-loop start --goal "X" --watch`.
2. CLI discovers `.grove/` dir, reads bearer token from `server-keys.yaml`, provisions one shared worktree under `.grove/workspaces/review-loop-<ts>/`.
3. CLI POSTs two tasks via `PUT /api/agent-tasks/<id>`:
   - `task-coder`: `runtime=codex`, `role=coder`, `prompt=goal`, `dependsOn=[]`.
   - `task-reviewer`: `runtime=claude`, `role=reviewer`, `prompt="Review the work completed for: <goal>"`, `dependsOn=[task-coder.id]`.
4. Server's `TaskController` (with `Scheduler` already wired per PR #439) reconciles:
   - `task-coder` advances `Pending → PendingBind`. Scheduler picks codex profile. `DefaultBind` calls `runtime.spawn` with prompt and env vars. `task-coder.status.sessionId` set.
   - `task-reviewer` stays `Pending` (blocked on `dependsOn`).
5. Codex runs. When finished, it calls `grove_done(summary="...")`. The MCP `done.ts` handler:
   - Reads `GROVE_AGENT_TASK_ID` + `GROVE_AGENT_TASK_GENERATION` from env.
   - PATCHes `/api/agent-tasks/<task-coder.id>/status` with a new `DoneSignaled=True` condition carrying `summary` as `message`.
   - Writes the legacy contribution (back-compat).
6. Controller's next reconcile of `task-coder` sees `DoneSignaled=True` and transitions `Running → Succeeded`. Closes the runtime session.
7. Controller's next reconcile of `task-reviewer` finds the dependency satisfied. `Pending → PendingBind`. Scheduler picks claude profile. `DefaultBind` reads `task-coder.status.conditions[DoneSignaled].message` and constructs the reviewer prompt:

   ```
   ## Upstream output

   ### review-loop-<ts>-coder (succeeded)
   <coder's grove_done summary>

   ## Your task

   Review the work completed for: <goal>
   ```

8. Claude reviews same worktree (file changes visible from coder), calls `grove_done(summary)`. Same sequence: `DoneSignaled` → `Succeeded` → session closed.
9. CLI `--watch` sees both tasks Succeeded, exits 0.

## Component Details

### `DoneSignaled` condition

Add to `AgentTaskConditionType`:

```ts
DoneSignaled: "DoneSignaled",
```

Set only by `grove_done` MCP tool. Status `True`, reason `"agent-grove-done"`, message = the agent's `summary` argument. Carried on `AgentTaskStatus.conditions`.

### `TaskController.reconcileRunning` extension

```ts
private async reconcileRunning(task: AgentTaskView): Promise<ReconciliationResult | undefined> {
  if (task.status.sessionId === undefined) return failLostSession(task, this.nowIso());

  // NEW: agent signaled done → Succeeded (checked before session-status to win the race
  // where the agent process exits immediately after grove_done).
  const doneCondition = task.status.conditions.find(
    (c) => c.type === AgentTaskConditionType.DoneSignaled && c.status === "True",
  );
  if (doneCondition !== undefined) {
    const session = (await this.runtime.listSessions()).find(
      (s) => s.id === task.status.sessionId,
    );
    return succeedTask(task, doneCondition.message ?? "", this.nowIso(), session);
  }

  const sessions = await this.runtime.listSessions();
  const session = sessions.find((s) => s.id === task.status.sessionId);
  if (session !== undefined && (session.status === "running" || session.status === "idle")) {
    return runningLiveCatchUp(task, this.nowIso());
  }
  return failLostSession(task, this.nowIso());
}

function succeedTask(
  task: AgentTaskView,
  summary: string,
  nowIso: string,
  session: AgentSession | undefined,
): ReconciliationResult {
  const conditions = upsertCondition(
    upsertCondition(task.status.conditions, {
      type: AgentTaskConditionType.Running,
      status: "False",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: "done-signaled",
      message: "",
    }),
    {
      type: AgentTaskConditionType.Succeeded,
      status: "True",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: "done-signaled",
      message: summary,
    },
  );
  return {
    patch: {
      phase: AgentTaskPhase.Succeeded,
      observedGeneration: task.spec.generation,
      conditions,
      lastTransitionAt: nowIso,
    },
    transition: transition(task, AgentTaskPhase.Succeeded, "done-signaled"),
    ...(session === undefined ? {} : { sessionToCloseOnSuccess: session }),
  };
}
```

Extend `ReconciliationResult`:

```ts
interface ReconciliationResult {
  readonly patch: AgentTaskStatusPatch;
  readonly transition: AgentTaskStatusTransition;
  readonly sessionToCloseOnPatchFailure?: AgentSession | undefined;
  readonly sessionToCloseOnSuccess?: AgentSession | undefined;
}
```

`TaskController.reconcileTask` calls `runtime.close(sessionToCloseOnSuccess)` after a successful status patch. Mirror of `sessionToCloseOnPatchFailure` but on the success path. Errors during close are logged but not rethrown (best-effort cleanup).

### `dependsOn` unblocking

No code change in `reconcilePending`. The existing `blockingDependencies` check at `task-controller.ts:445` already returns blocked when a dependency is not `Succeeded`. Once Section 2's transition lands, dependents unblock automatically on the next reconcile.

### `DefaultBind` prompt wrapping

`SchedulerContext.store` interface changes from `Pick<AgentTaskStore, "listAgentTaskEntities">` to `Pick<AgentTaskStore, "listAgentTaskEntities" | "getAgentTask">`. Backwards-compatible: callers passing the full `AgentTaskStore` auto-satisfy the wider Pick. `Scheduler` constructor and existing tests pass through unchanged.

`DefaultBind.bind`:

```ts
async bind(ctx: SchedulerContext, profile: RuntimeProfile): Promise<BindResult> {
  const upstreamSections: UpstreamSection[] = [];
  for (const depId of ctx.task.spec.dependsOn) {
    const dep = await ctx.store.getAgentTask(depId);
    const succeededCondition = dep?.status.conditions.find(
      (c) => c.type === "Succeeded" && c.status === "True",
    );
    upstreamSections.push({
      taskId: depId,
      summary: succeededCondition?.message ?? "",
    });
  }
  const wrappedPrompt = buildPromptWithUpstream(ctx.task.spec.prompt, upstreamSections);

  const config: AgentConfig = {
    role: ctx.task.spec.role,
    command: profile.runtimeCommand,
    cwd: ctx.task.spec.worktree,
    goal: ctx.task.spec.prompt,    // unwrapped goal kept on `goal` for back-compat
    prompt: wrappedPrompt,         // wrapped prompt is what the agent receives
    ...(profile.platform === undefined ? {} : { platform: profile.platform }),
    ...(model === undefined ? {} : { model }),
    env: {
      GROVE_AGENT_TASK_ID: ctx.task.spec.id,
      GROVE_AGENT_TASK_GENERATION: String(ctx.task.spec.generation),
      GROVE_AGENT_TASK_RUNTIME: profile.runtimeCommand,
    },
  };
  return { session: await this.runtime.spawn(ctx.task.spec.role, config) };
}
```

`buildPromptWithUpstream` is the pure module from `upstream-prompt.ts`.

### `grove_done` MCP-side patch

`src/mcp/agent-task-context.ts`:

```ts
export interface AgentTaskContext {
  readonly taskId: string;
  readonly generation: number;
}

export function readAgentTaskContext(
  env: Readonly<Record<string, string | undefined>>,
): AgentTaskContext | undefined {
  const taskId = env.GROVE_AGENT_TASK_ID;
  const gen = env.GROVE_AGENT_TASK_GENERATION;
  if (taskId === undefined || gen === undefined) return undefined;
  const generation = Number.parseInt(gen, 10);
  if (!Number.isFinite(generation)) return undefined;
  return { taskId, generation };
}
```

`done.ts`:

```ts
const ctx = readAgentTaskContext(process.env);
if (ctx !== undefined) {
  try {
    await patchAgentTaskDoneSignaled(deps, ctx, args.summary);
  } catch (err) {
    process.stderr.write(
      `[grove-done] task=${ctx.taskId} patch failed (${(err as Error).message}); ` +
        `contribution write proceeding\n`,
    );
  }
}
// existing contributeOperation call unchanged
```

`patchAgentTaskDoneSignaled` is a new helper in `src/mcp/agent-task-patch.ts` (or co-located in `done.ts`):

1. `GET /api/agent-tasks/<taskId>` → read current view.
2. Compose patch body: `{ conditions: [...current, { type: "DoneSignaled", status: "True", observedGeneration, lastTransitionTime, reason: "agent-grove-done", message: summary }], observedGeneration }`. Use the existing `upsertCondition` semantics (server-side merges).
3. `PATCH /api/agent-tasks/<taskId>/status` with `If-Match: <resourceVersion>`.
4. On 409 → re-GET once, recompose, retry.
5. On second 409 or other error → throw (caught by outer try/catch in done.ts, which logs and continues with contribution write).

Server URL discovered from `process.env.GROVE_NEXUS_URL` or `process.env.GROVE_SERVER_URL` (whichever the MCP server already uses for HTTP calls — verify existing pattern in `src/mcp/`). Bearer token from existing MCP HTTP helper.

### `grove review-loop` CLI

See Section 5. Subcommands `start`, `status`. Stretch: `cancel`.

Required flags on `start`: `--goal`. Optional: `--coder`, `--reviewer`, `--watch`, `--grove-url`, `--timeout`.

Watch output is line-buffered JSON, one phase-change per line, `{"event":"complete",...}` final line. Exit codes: 0 success, 1 failure (Failed/Unschedulable), 2 timeout.

### Telemetry

- Controller stderr: `[task-controller] <task-id>: <from> → <to> (reason: <r>, gen: <n>)` on every transition.
- MCP stderr: `[grove-done] task=<id> gen=<n> patched DoneSignaled` on success, warning on failure.
- CLI stdout: JSON event stream per phase change + final `complete` event.

No new metrics endpoint, no event-bus changes. Existing `entity.changed` envelopes via watch hub already cover external subscribers.

## Testing

### Unit tests

- `src/core/task-controller.test.ts` — 5 new cases (Succeeded transition, race-free ordering, back-compat, dependent unblocking, session close on success).
- `src/core/scheduler/upstream-prompt.test.ts` — 4 cases (no deps, one dep, multi deps, missing summary fallback).
- `src/core/scheduler/plugins/default-bind.test.ts` — 2 new cases (deps with summary; legacy SchedulerContext shape behavior).
- `src/mcp/agent-task-context.test.ts` — 3 cases (both env vars, one missing, non-numeric gen).
- `src/mcp/tools/done.test.ts` — 4 new cases (PATCH-then-contribution flow, 409 retry, no-env-vars no-PATCH, network error tolerance).
- `src/cli/commands/review-loop.test.ts` — workspace bootstrap, two-task PUT, dependsOn wiring, connection-refused error message.

### Server integration test

- `src/server/routes/agent-tasks.test.ts` — explicit test: bearer-authed PATCH with `conditions: [{type: "DoneSignaled", status: "True", ...}]` is accepted and persisted.

### E2E

- `tests/e2e/review-loop-codex-claude-tmux.ts` — standalone bun script:
  1. `grove init` + write `grove.json` with scheduler block (codex-default + claude-default profiles).
  2. Start grove-server in tmux pane (matches `scheduler-pipeline-tmux.ts` pattern).
  3. Driver process: `grove review-loop start --goal "Print hello and call grove_done" --watch --timeout 120`.
  4. Assert sequenced events: coder Pending→Running→Succeeded, reviewer Pending→PendingBind→Running→Succeeded, exit 0.
  5. Capture pane + final task status as evidence.
  6. Cleanup on `--keep`-aware exit handler.

E2E runs against real `codex` and `claude` binaries (verified installed). Prompts kept trivial; budget 120s.

### Acceptance verification

- "Closes the migration gap": E2E exits 0 with both tasks `Succeeded`.
- "Scheduler runs for both agents": E2E pane shows `[task-controller] <coder-id>: PendingBind → Running` AND same for reviewer, both with scheduler-picked profile names in conditions.
- "Back-compat preserved": existing `bun test src/core/task-controller.test.ts src/mcp/tools/done.test.ts` passes without regression.

## Risks and Open Questions

- **Dependency in Failed state cascades to dependent stuck-forever.** `dependsOn` unblock requires `Succeeded`. A Failed coder leaves the reviewer in Pending forever. Not catastrophic (operator can DELETE the task), but worth a follow-up (cascade-cancel policy or auto-fail of dependents). Logged as risk; revisit in #285.
- **MCP server's URL discovery for grove-server.** This spec assumes `process.env.GROVE_NEXUS_URL` or a similar var the MCP server already uses. Verify during implementation; if absent, add `GROVE_SERVER_URL` to the env injected by `DefaultBind`.
- **Conditions-array PATCH semantics.** Server-side `patchAgentTaskStatus` likely treats `conditions` as a full replacement (per `AgentTaskStatusPatch.conditions`). The MCP helper must therefore include ALL existing conditions plus the new `DoneSignaled` — not just the diff. This is why step 1 GETs the current view first. If the route accepts a partial-merge JSON Patch in the future, this can simplify.
- **Race between `grove_done` PATCH and controller's `runtime.close`.** When the controller reconciles `Succeeded` it closes the session. If the agent process is still executing post-`grove_done`, close kills it mid-cleanup. Acceptable for review loops (agent has signaled done; nothing more to do) but worth noting. Future: add a `grace-period` field on `AgentTask` if needed.
- **Worktree concurrency.** Both tasks share the worktree path. `WorktreeExclusivity` filter rejects two simultaneously-Running tasks on the same worktree, so the reviewer can only start after coder exits — that's exactly the desired sequencing. No conflict, but called out so reviewers understand why exclusivity matters here.
- **`TaskBinder` interface vs scheduler-driven path.** PR #439 kept `TaskBinder` for back-compat. After this migration, both paths still coexist; #305's two-phase reservation work may remove `TaskBinder` as planned. No additional cleanup needed here.
