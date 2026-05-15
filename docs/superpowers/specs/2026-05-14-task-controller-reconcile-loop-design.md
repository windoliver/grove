# Task Controller Reconcile Loop Design

## Summary

Issue #299 adds a Kubernetes-style `AgentTask` controller that owns task status convergence. The controller watches `AgentTask` records, enqueues task keys, runs an idempotent `syncHandler(taskId)`, and performs one durable step per reconcile: catch up observed generation, block on dependencies, bind/spawn ready tasks, reattach live sessions after restart, or mark missing/crashed sessions failed.

This PR should be a full vertical slice for #299. It includes controller logic, local watch/informer support for `AgentTask`, server watch fan-out for task writes, runtime binding through `AgentRuntime`, and failure-injected convergence tests. It intentionally does not implement the configurable scheduler plugin framework from #300; the bind decision is kept behind a narrow interface so #300 can replace it without rewriting the controller.

## Goals

- Add a `TaskController` with a rate-limited keyed work queue and exponential retry on reconcile errors.
- Support `AgentTask` informers by extending the watch protocol, local watch client types, and server list/watch routes.
- Keep `syncHandler(taskId)` level-triggered and idempotent: read current world state, compute one next step, persist status, return.
- Spawn ready tasks via `AgentRuntime` and record `status.sessionId` durably.
- Treat restart reattachment as normal reconciliation by comparing `status.sessionId` with `AgentRuntime.listSessions()`.
- Recover automatically after controller crashes or process restarts without manual repair.
- Add unit tests that inject failures at every meaningful reconcile step and verify repeated reconcile converges.
- Preserve the spec/status split from #297: controller writes status only and never mutates task spec.

## Non-Goals

- Do not implement #300's Filter/Score/Permit/Bind plugin framework in this PR.
- Do not add trigger adapters from #379.
- Do not add one-shot termination, output schema validation, or retry policy semantics from #359.
- Do not add plan/shard/merge orchestration from #358.
- Do not change TUI task creation flows beyond what is needed for the new watch kind to be observable.
- Do not add cross-process leader election. This controller is safe and idempotent, but active-active deployment coordination belongs in a later scheduler/controller-manager issue.

## Current State

`AgentTask` already has split spec/status records in `src/core/agent-task.ts` and `AgentTaskStore` exposes:

- `putAgentTaskSpec`
- `getAgentTask`
- `listAgentTasks`
- `patchAgentTaskStatus`
- `listAgentTaskEntities`

The HTTP API has `PUT /api/agent-tasks/:id` for spec writes and `PATCH /api/agent-tasks/:id/status` for controller-owned status writes guarded by `X-Grove-Controller-Token`.

The codebase also already has reusable controller infrastructure:

- `KeyedWorkQueue` in `src/core/workqueue.ts`
- `ClaimReconciliationController` in `src/core/claim-controller.ts`
- `Informer` and `InformerFactory` in `src/core/informer.ts`

The watch protocol currently supports `Contribution`, `Claim`, and `AgentSession`. `AgentTask` can be projected as an entity through `agentTaskViewToEntity`, but the watch API and informer type mapping do not yet include it.

## Architecture

Add `src/core/task-controller.ts` as the core controller module. It should follow the shape of `ClaimReconciliationController`:

- constructor-injected stores, runtime, queue, clock, callbacks, and options
- `enqueue(taskId)`
- `enqueueFromEntity(entity)`
- `resync()`
- `syncHandler(taskId)` or `reconcileTask(taskId)` public test hook
- `start()`
- `stop()`

The controller depends on a narrow store/runtime surface:

```ts
export type TaskControllerStore = Pick<
  AgentTaskStore,
  "getAgentTask" | "listAgentTaskEntities" | "patchAgentTaskStatus"
>;

export type TaskControllerRuntime = Pick<
  AgentRuntime,
  "spawn" | "listSessions" | "close"
>;
```

Add an injectable binder boundary:

```ts
export interface TaskBindRequest {
  readonly task: AgentTaskView;
}

export interface TaskBindResult {
  readonly session: AgentSession;
}

export interface TaskBinder {
  bind(request: TaskBindRequest): Promise<TaskBindResult>;
}
```

The default binder maps `AgentTaskSpecRecord` into `AgentRuntime.spawn()`:

- `role` from `task.spec.role`
- `cwd` from `task.spec.worktree`
- `command` and `platform` from `task.spec.runtime` using the same runtime/platform conventions already used by Grove agent spawning
- `prompt` and `goal` from `task.spec.prompt`
- `model` from `task.spec.budget.model` only if the value is a string
- `maxTurns` and richer budget policy are recorded on the task but not enforced in this PR

#300 can later replace this simple binder with scheduler Filter/Score/Permit/Bind plugins.

## Reconcile State Machine

Each reconcile reads the latest task and current sessions before deciding. Stale informer payloads are never trusted for status writes.

### Missing Task

If `getAgentTask(taskId)` returns `undefined`, reconciliation succeeds with no patch. This handles delete races and stale queue items.

### Terminal Tasks

For `Succeeded` and `Failed`, the controller does not regress phase. If `status.observedGeneration < spec.generation`, it may patch only `observedGeneration` and a condition explaining that the terminal task observed a later spec generation without reopening.

### Dependency Blocking

If `spec.dependsOn` contains task IDs whose current phase is not terminal success, the controller keeps the task in `Pending`, sets `observedGeneration` to the current spec generation, and upserts a `Blocked` condition:

- `type: "Blocked"`
- `status: "True"`
- `reason: "depends-on"`
- `message: "Waiting for task-a, task-b"`

When all dependencies are satisfied, the controller clears or flips the `Blocked` condition to `False` as part of the next transition.

The first implementation can resolve dependencies through the same `TaskControllerStore.getAgentTask` method. It should treat missing dependencies as blocked, not failed, because trigger adapters may create tasks out of order.

### Pending Bind

For ready tasks in `Pending`, the controller should perform one durable pre-bind step:

- phase: `PendingBind`
- observedGeneration: current spec generation
- condition `Scheduled=True`, reason `ready-to-bind`
- `lastTransitionAt`: now

This phase is the crash recovery marker. If the controller dies after deciding a task is ready but before spawn, the restarted controller sees `PendingBind` and continues with bind.

### Binding And Spawn

For `PendingBind` tasks without `status.sessionId`, the controller calls the binder. On success it patches:

- phase: `Running`
- sessionId: returned session ID
- observedGeneration: current spec generation
- condition `Bound=True`, reason `session-bound`
- condition `Running=True`, reason `session-running`
- `lastTransitionAt`: now

If binder/spawn throws, the worker retries the task through `KeyedWorkQueue.retry()`. It should not patch `Failed` for transient spawn errors in the first failed attempt. The queue retry backoff handles transient runtime availability problems.

### Running Reattach

For `Running` tasks with `status.sessionId`, the controller compares the ID with `runtime.listSessions()`.

Live session states:

- `running`
- `idle`

For live sessions, reconciliation succeeds. If conditions are stale or `observedGeneration` lags, the controller patches only status metadata and conditions. This is the primary restart behavior: after `kill -9`, a new controller lists live ACP sessions, sees that `status.sessionId` is still present, and reattaches by doing nothing destructive.

Missing or dead session states:

- missing from `listSessions()`
- `stopped`
- `crashed`

For missing/dead sessions, the controller patches:

- phase: `Failed`
- condition `Running=False`, reason `session-lost`
- condition `Failed=True`, reason `session-lost`
- `lastTransitionAt`: now

This closes the gap where a task claims to be running but the runtime no longer has the process.

### Contributions And Success

This PR should not invent one-shot completion semantics. The controller preserves `status.contributions` and does not mark `Succeeded` based solely on runtime idleness. Completion will be driven later by explicit task completion paths from one-shot execution (#359), trigger adapters (#379), or MCP/tool events.

The controller may keep a `completeTask(taskId, contributions)` helper out of scope unless an existing route/tool already writes task success.

## Conditions

Use the condition types already declared in `AgentTaskConditionType`:

- `Blocked`
- `Scheduled`
- `Bound`
- `Running`
- `Failed`

Condition writes must preserve unknown condition types. Controller-owned condition updates should upsert by `type`, update `lastTransitionTime` only when status/reason/message changes, and keep previous timestamps when the condition is unchanged.

Reason strings should be stable:

- `depends-on`
- `ready-to-bind`
- `session-bound`
- `session-running`
- `session-lost`
- `observed-generation-current`
- `terminal-observed-generation`

## Watch And Informer Support

Extend `WatchKind` and `WatchEntity` to include `AgentTask`.

Update `EntityForKind<K>` in `src/core/informer.ts` so `Informer<"AgentTask">` returns `AgentTaskEntity`.

Update server watch routes:

- include `AgentTask` in `KIND_VALUES`
- include `AgentTask` in `SUPPORTED_KINDS`
- make `listForKind` call `deps.agentTaskStore.listAgentTaskEntities()`
- return `501` when `agentTaskStore` is absent
- support `POST /api/watch/notify` hydration for `AgentTask` if cross-process task writes need fan-out

Update `agent-tasks` HTTP routes so spec and status writes call `watchHub.recordWrite()` with `AgentTask` entities after successful store writes.

Update local runtime watch recorder so SQLite task writes can fan out to a local watch hub. Add an `onAgentTaskWrite` callback to `SqliteAgentTaskStore`, mirroring contribution and claim write hooks.

The controller can be wired directly to an informer when available:

- event handler enqueues the task ID for all add/modify/delete events
- sync handler triggers `resync()` after relist completion

When no informer is available, periodic `resync()` still gives convergence.

## Server And Runtime Wiring

Server startup should enable the controller by default when `agentTaskStore` is configured. Operators can disable it with `GROVE_TASK_CONTROLLER=0` for diagnostics or deployments that only want the HTTP task API.

`server/serve.ts` should create one shared `AgentRuntime` with `selectRuntime()` and the existing `TmuxRuntime` fallback. That runtime is reused by both `TaskController` and `SessionService` when both are enabled, so the process has one authoritative `listSessions()` view.

In local in-process mode, the controller uses the store directly instead of calling HTTP status routes. The controller token remains required for external HTTP status writes.

The controller exposes a clean `stop()` path and is included in server shutdown cleanup.

Recommended options:

```ts
export interface TaskControllerOptions {
  readonly taskStore: TaskControllerStore;
  readonly runtime: TaskControllerRuntime;
  readonly binder?: TaskBinder | undefined;
  readonly queue?: KeyedWorkQueue | undefined;
  readonly resyncIntervalMs?: number | undefined;
  readonly workerCount?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onError?: ((error: unknown, taskId: string) => void) | undefined;
  readonly onTransition?: ((transition: AgentTaskStatusTransition) => void) | undefined;
}
```

Defaults should match the claim controller unless a task-specific value is needed:

- `resyncIntervalMs`: 30 seconds
- `workerCount`: 1
- queue defaults from `KeyedWorkQueue`

## Crash Recovery

The important invariant is "persist before external ambiguity where possible, and reconcile after ambiguity."

Crash windows:

1. Before `Pending -> PendingBind` patch: restart sees `Pending` and repeats readiness checks.
2. After `PendingBind` patch but before spawn: restart sees `PendingBind` without `sessionId` and spawns.
3. After spawn but before `Running/sessionId` patch: this is the one non-atomic external side effect. The default binder includes `GROVE_AGENT_TASK_ID`, `GROVE_AGENT_TASK_GENERATION`, and `GROVE_AGENT_TASK_RUNTIME` in `AgentConfig.env` so runtimes and diagnostics can correlate the child process to the task. If a runtime cannot rediscover that metadata after a process restart, the controller may spawn a duplicate in this narrow window. Full exactly-once spawn is deferred to #300/#305 reservation and CAS work.
4. After `Running/sessionId` patch: restart lists sessions and reattaches if live.
5. While reconciling running task: restart repeats the same session comparison and converges.

The acceptance criterion "kill -9 controller mid-sync -> restart reattaches all live sessions" is satisfied for tasks that reached the durable `Running/sessionId` state before the kill, and for runtimes whose `listSessions()` can rediscover task-associated sessions. The tests cover durable reattach and injected failures around each store/runtime call.

## Testing

Add `src/core/task-controller.test.ts` with fake store, fake runtime, fake binder, fake queue/clock helpers. Follow the style of `claim-controller.test.ts`.

Core cases:

- rejects invalid `resyncIntervalMs` and `workerCount`
- missing task is a no-op
- terminal tasks do not regress
- stale observed generation is patched without spec mutation
- dependencies block pending tasks
- satisfied dependencies move `Pending -> PendingBind`
- `PendingBind` binds/spawns and patches `Running` with `sessionId`
- running task with live session is a no-op or metadata catch-up
- running task with missing session becomes `Failed`
- running task with crashed/stopped session becomes `Failed`
- `resync()` enqueues all task entity IDs
- worker retry re-reads fresh state after a failed reconcile
- throwing `onError` does not prevent retry
- `stop()` cancels queue workers

Failure-injection convergence:

- Build a fake store/runtime that can throw once at each named step:
  - read task
  - read dependencies
  - patch `PendingBind`
  - spawn/bind
  - patch `Running`
  - list sessions
  - patch `Failed`
- For each injection point, call reconcile or run the worker until the injected error is observed, then clear the failure and re-enqueue. Assert final task status converges.

Watch/informer tests:

- `AgentTask` appears in watch list responses when store is configured.
- spec writes emit `ADDED`/`MODIFIED` AgentTask watch events.
- status writes emit `MODIFIED` AgentTask watch events.
- `InformerFactory.informerFor("AgentTask")` caches and lists task entities.

Integration-style local test:

- create a task, run controller to `Running`, create a second controller with the same store/runtime, call `resync()`, and verify it reattaches by leaving the live `sessionId` untouched.

## Risks

- The spawn call cannot be made fully atomic with the status patch. This PR reduces the risk with `PendingBind`, durable `sessionId`, and reattach checks, but exactly-once spawn needs later reservation/CAS work.
- Adding `AgentTask` to watch increases the typed surface area for `WatchKind`; all exhaustive switch statements must be updated.
- Direct in-process controller writes bypass the HTTP controller-token check by design. The security boundary remains at HTTP routes; in-process code already has direct store authority.
- Completion semantics are intentionally conservative. A running session becoming idle does not automatically mean the task succeeded.

## Implementation Decisions

- The controller starts by default in `grove-server`; `GROVE_TASK_CONTROLLER=0` disables it.
- The server uses one shared `AgentRuntime` for task control and WebSocket `SessionService`.
- The default binder stamps task correlation into `AgentConfig.env`; exact-once recovery for spawn-before-status-patch crashes remains deferred to reservation/CAS work.
- `PendingBind` remains a real API phase and the TUI may render it with the existing AgentTask phase chip vocabulary.
