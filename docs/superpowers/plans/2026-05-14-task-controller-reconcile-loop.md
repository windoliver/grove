# Task Controller Reconcile Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full issue #299 vertical slice: an `AgentTask` controller that watches tasks, binds/spawns ready work, retries failures, and reattaches live sessions after restart.

**Architecture:** Add a core `TaskController` modeled after `ClaimReconciliationController`, with a keyed retry queue and an injectable `TaskBinder`. Extend the watch/informer pipeline to support `AgentTask`, wire SQLite and HTTP task writes into `WatchHub`, and start the controller from `grove-server` with a shared `AgentRuntime`.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, Hono routes, SQLite local store, Grove `AgentRuntime`, Grove `KeyedWorkQueue`, Grove watch/informer primitives.

---

## File Structure

- Create `src/core/task-controller.ts`: controller types, default binder, status transition logic, condition helpers, worker loop.
- Create `src/core/task-controller.test.ts`: fake store/runtime/binder tests for transitions, retries, restart reattach, and failure injection.
- Modify `src/core/watch-events.ts`: add `AgentTask` to watch kind/entity unions.
- Modify `src/core/informer.ts`: map `AgentTask` entities and include the kind in remote/local factory support.
- Modify `src/core/index.ts`: export task controller types/classes.
- Modify `src/local/watch-hub-recorder.ts`: add `agentTask()` fan-out.
- Modify `src/local/runtime.ts`: wire `SqliteAgentTaskStore.onAgentTaskWrite` when a local watch hub is present.
- Modify `src/local/sqlite-store.ts`: add task write callback support for spec and status writes.
- Modify `src/local/sqlite-agent-task-store.test.ts`: verify callback operations and entities.
- Modify `src/server/routes/watch.ts`: list/watch/notify support for `AgentTask`.
- Modify `src/server/routes/agent-tasks.ts`: emit task watch events after spec/status writes.
- Modify `tests/server/agent-tasks.test.ts`: verify task route fan-out.
- Modify `src/server/serve.ts`: create shared runtime, start/stop task controller by default, reuse runtime for `SessionService`.

## Task 1: Core Controller Transitions

**Files:**
- Create: `src/core/task-controller.ts`
- Create: `src/core/task-controller.test.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write failing transition tests**

Create `src/core/task-controller.test.ts` with this starting fixture and transition tests:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentSession } from "./agent-runtime.js";
import {
  AgentTaskPhase,
  type AgentTaskEntity,
  type AgentTaskStatusRecord,
  type AgentTaskView,
  agentTaskViewToEntity,
} from "./agent-task.js";
import type { Condition } from "./entity.js";
import type { AgentTaskStatusPatch } from "./store.js";
import {
  DefaultTaskBinder,
  type TaskBinder,
  type TaskControllerStore,
  TaskController,
  type TaskControllerRuntime,
} from "./task-controller.js";

const FIXED_NOW_MS = Date.parse("2026-05-14T12:00:00.000Z");
const FIXED_NOW_ISO = "2026-05-14T12:00:00.000Z";

interface RecordedPatch {
  readonly taskId: string;
  readonly patch: AgentTaskStatusPatch;
}

class FakeTaskStore implements TaskControllerStore {
  readonly views = new Map<string, AgentTaskView>();
  readonly patches: RecordedPatch[] = [];

  seed(view: AgentTaskView): void {
    this.views.set(view.spec.id, view);
  }

  getAgentTask = async (taskId: string): Promise<AgentTaskView | undefined> => {
    return this.views.get(taskId);
  };

  patchAgentTaskStatus = async (
    taskId: string,
    patch: AgentTaskStatusPatch,
  ): Promise<AgentTaskView> => {
    const current = this.views.get(taskId);
    if (current === undefined) throw new Error(`missing task ${taskId}`);
    this.patches.push({ taskId, patch });
    const status: AgentTaskStatusRecord = {
      ...current.status,
      phase: patch.phase ?? current.status.phase,
      sessionId: patch.sessionId ?? current.status.sessionId,
      contributions: patch.contributions ?? current.status.contributions,
      conditions: patch.conditions ?? current.status.conditions,
      observedGeneration: patch.observedGeneration ?? current.status.observedGeneration,
      lastTransitionAt: patch.lastTransitionAt ?? current.status.lastTransitionAt,
      revision: current.status.revision + 1,
    };
    const updated: AgentTaskView = { spec: current.spec, status };
    this.views.set(taskId, updated);
    return updated;
  };

  listAgentTaskEntities = async (): Promise<readonly AgentTaskEntity[]> => {
    return [...this.views.values()].map((view) => agentTaskViewToEntity(view));
  };
}

class FakeRuntime implements TaskControllerRuntime {
  readonly spawnCalls: Array<{ readonly role: string; readonly config: AgentConfig }> = [];
  readonly sessions = new Map<string, AgentSession>();
  private nextId = 1;

  spawn = async (role: string, config: AgentConfig): Promise<AgentSession> => {
    this.spawnCalls.push({ role, config });
    const session: AgentSession = {
      id: `session-${this.nextId}`,
      role,
      status: "running",
      platform: config.platform,
      model: config.model,
    };
    this.nextId += 1;
    this.sessions.set(session.id, session);
    return session;
  };

  listSessions = async (): Promise<readonly AgentSession[]> => [...this.sessions.values()];

  close = async (session: AgentSession): Promise<void> => {
    this.sessions.delete(session.id);
  };
}

class FakeBinder implements TaskBinder {
  readonly calls: AgentTaskView[] = [];
  session: AgentSession = { id: "bound-session", role: "worker", status: "running" };

  bind = async ({ task }: { readonly task: AgentTaskView }): Promise<{ readonly session: AgentSession }> => {
    this.calls.push(task);
    return { session: this.session };
  };
}

function taskView(overrides: {
  readonly id?: string;
  readonly phase?: AgentTaskPhase;
  readonly generation?: number;
  readonly observedGeneration?: number;
  readonly dependsOn?: readonly string[];
  readonly sessionId?: string;
  readonly conditions?: readonly Condition[];
} = {}): AgentTaskView {
  const id = overrides.id ?? "task-1";
  const generation = overrides.generation ?? 1;
  return {
    spec: {
      id,
      worktree: "/tmp/grove-task",
      runtime: "codex",
      role: "worker",
      prompt: "Implement the task",
      dependsOn: overrides.dependsOn ?? [],
      generation,
      createdAt: "2026-05-14T11:00:00.000Z",
    },
    status: {
      id,
      phase: overrides.phase ?? AgentTaskPhase.Pending,
      ...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
      contributions: [],
      conditions: overrides.conditions ?? [],
      observedGeneration: overrides.observedGeneration ?? 0,
      lastTransitionAt: "2026-05-14T11:00:00.000Z",
      revision: 1,
    },
  };
}

function controllerFor(
  store: FakeTaskStore,
  overrides: {
    readonly runtime?: FakeRuntime;
    readonly binder?: TaskBinder;
  } = {},
): TaskController {
  return new TaskController({
    taskStore: store,
    runtime: overrides.runtime ?? new FakeRuntime(),
    binder: overrides.binder,
    now: () => FIXED_NOW_MS,
  });
}

function onlyPatch(store: FakeTaskStore): RecordedPatch {
  expect(store.patches).toHaveLength(1);
  const patch = store.patches[0];
  if (patch === undefined) throw new Error("expected one patch");
  return patch;
}

function condition(conditions: readonly Condition[] | undefined, type: string): Condition | undefined {
  return conditions?.find((candidate) => candidate.type === type);
}

describe("TaskController transitions", () => {
  test("missing tasks are successful no-ops", async () => {
    const store = new FakeTaskStore();
    const controller = controllerFor(store);

    await expect(controller.reconcileTask("missing")).resolves.toBeUndefined();
    expect(store.patches).toEqual([]);
  });

  test("terminal tasks catch up observed generation without reopening", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({
      phase: AgentTaskPhase.Failed,
      generation: 4,
      observedGeneration: 2,
    }));
    const controller = controllerFor(store);

    const transition = await controller.reconcileTask("task-1");

    expect(transition).toEqual({
      taskId: "task-1",
      fromPhase: AgentTaskPhase.Failed,
      toPhase: AgentTaskPhase.Failed,
      reason: "terminal-observed-generation",
      observedGeneration: 4,
    });
    expect(onlyPatch(store).patch.phase).toBeUndefined();
    expect(onlyPatch(store).patch.observedGeneration).toBe(4);
  });

  test("pending tasks with missing dependencies stay blocked", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ dependsOn: ["task-a", "task-b"] }));
    const controller = controllerFor(store);

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Pending);
    expect(patch.observedGeneration).toBe(1);
    expect(condition(patch.conditions, "Blocked")).toEqual({
      type: "Blocked",
      status: "True",
      observedGeneration: 1,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "depends-on",
      message: "Waiting for task-a, task-b",
    });
  });

  test("pending tasks with satisfied dependencies move to PendingBind", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ id: "task-a", phase: AgentTaskPhase.Succeeded, observedGeneration: 1 }));
    store.seed(taskView({ dependsOn: ["task-a"] }));
    const controller = controllerFor(store);

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.PendingBind);
    expect(condition(patch.conditions, "Scheduled")?.reason).toBe("ready-to-bind");
  });

  test("PendingBind tasks bind, spawn, and become Running", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    const binder = new FakeBinder();
    const controller = controllerFor(store, { binder });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(binder.calls.map((task) => task.spec.id)).toEqual(["task-1"]);
    expect(patch.phase).toBe(AgentTaskPhase.Running);
    expect(patch.sessionId).toBe("bound-session");
    expect(condition(patch.conditions, "Bound")?.reason).toBe("session-bound");
    expect(condition(patch.conditions, "Running")?.reason).toBe("session-running");
  });

  test("running tasks reattach when the session is live", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({
      phase: AgentTaskPhase.Running,
      observedGeneration: 1,
      sessionId: "session-live",
    }));
    const runtime = new FakeRuntime();
    runtime.sessions.set("session-live", {
      id: "session-live",
      role: "worker",
      status: "idle",
    });
    const controller = controllerFor(store, { runtime });

    await controller.reconcileTask("task-1");

    expect(store.patches).toEqual([]);
  });

  test("running tasks fail when the session is missing", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({
      phase: AgentTaskPhase.Running,
      observedGeneration: 1,
      sessionId: "session-missing",
    }));
    const controller = controllerFor(store, { runtime: new FakeRuntime() });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Failed);
    expect(condition(patch.conditions, "Failed")?.reason).toBe("session-lost");
  });
});

describe("DefaultTaskBinder", () => {
  test("maps AgentTask spec to AgentRuntime spawn config with task correlation env", async () => {
    const runtime = new FakeRuntime();
    const binder = new DefaultTaskBinder(runtime);
    const view = taskView({ generation: 3 });

    const result = await binder.bind({ task: view });

    expect(result.session.id).toBe("session-1");
    expect(runtime.spawnCalls[0]).toEqual({
      role: "worker",
      config: {
        role: "worker",
        command: "codex",
        cwd: "/tmp/grove-task",
        goal: "Implement the task",
        prompt: "Implement the task",
        platform: "codex",
        env: {
          GROVE_AGENT_TASK_ID: "task-1",
          GROVE_AGENT_TASK_GENERATION: "3",
          GROVE_AGENT_TASK_RUNTIME: "codex",
        },
      },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test src/core/task-controller.test.ts
```

Expected: FAIL with module resolution errors for `./task-controller.js` or missing exported symbols such as `TaskController`.

- [ ] **Step 3: Implement minimal controller and binder**

Create `src/core/task-controller.ts` with these exported shapes and behavior:

```ts
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import {
  AgentTaskConditionType,
  AgentTaskPhase,
  type AgentTaskEntity,
  type AgentTaskView,
} from "./agent-task.js";
import type { Condition } from "./entity.js";
import type { AgentTaskStatusPatch, AgentTaskStore } from "./store.js";
import { KeyedWorkQueue, QueueClosedError, type WorkItemResult } from "./workqueue.js";

export type TaskControllerStore = Pick<
  AgentTaskStore,
  "getAgentTask" | "listAgentTaskEntities" | "patchAgentTaskStatus"
>;

export type TaskControllerRuntime = Pick<AgentRuntime, "spawn" | "listSessions" | "close">;

export interface TaskBindRequest {
  readonly task: AgentTaskView;
}

export interface TaskBindResult {
  readonly session: AgentSession;
}

export interface TaskBinder {
  bind(request: TaskBindRequest): Promise<TaskBindResult>;
}

export interface AgentTaskStatusTransition {
  readonly taskId: string;
  readonly fromPhase: AgentTaskPhase;
  readonly toPhase: AgentTaskPhase;
  readonly reason: string;
  readonly observedGeneration: number;
}

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

const DEFAULT_RESYNC_INTERVAL_MS = 30_000;
const DEFAULT_WORKER_COUNT = 1;
const MAX_RESYNC_INTERVAL_MS = 2_147_483_647;
const MAX_WORKER_COUNT = 1_000;

export class DefaultTaskBinder implements TaskBinder {
  private readonly runtime: TaskControllerRuntime;

  constructor(runtime: TaskControllerRuntime) {
    this.runtime = runtime;
  }

  async bind(request: TaskBindRequest): Promise<TaskBindResult> {
    const task = request.task;
    const modelValue = task.spec.budget?.model;
    const config: AgentConfig = {
      role: task.spec.role,
      command: task.spec.runtime,
      cwd: task.spec.worktree,
      goal: task.spec.prompt,
      prompt: task.spec.prompt,
      platform: runtimeToPlatform(task.spec.runtime),
      ...(typeof modelValue === "string" ? { model: modelValue } : {}),
      env: {
        GROVE_AGENT_TASK_ID: task.spec.id,
        GROVE_AGENT_TASK_GENERATION: String(task.spec.generation),
        GROVE_AGENT_TASK_RUNTIME: task.spec.runtime,
      },
    };
    const session = await this.runtime.spawn(task.spec.role, config);
    return { session };
  }
}

export class TaskController {
  private readonly taskStore: TaskControllerStore;
  private readonly runtime: TaskControllerRuntime;
  private readonly binder: TaskBinder;
  private readonly queue: KeyedWorkQueue;
  private readonly now: () => number;
  private readonly resyncIntervalMs: number;
  private readonly workerCount: number;
  private readonly onError: ((error: unknown, taskId: string) => void) | undefined;
  private readonly onTransition: ((transition: AgentTaskStatusTransition) => void) | undefined;
  private running = false;
  private stopRequested = false;
  private workers: Promise<void>[] = [];
  private resyncTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TaskControllerOptions) {
    this.taskStore = options.taskStore;
    this.runtime = options.runtime;
    this.binder = options.binder ?? new DefaultTaskBinder(options.runtime);
    this.now = options.now ?? Date.now;
    this.queue = options.queue ?? new KeyedWorkQueue({ now: this.now });
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    this.workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
    validateResyncIntervalMs(this.resyncIntervalMs);
    validateWorkerCount(this.workerCount);
    this.onError = options.onError;
    this.onTransition = options.onTransition;
  }

  enqueue(taskId: string): void {
    this.queue.enqueue(taskId);
  }

  enqueueFromEntity(entity: AgentTaskEntity): void {
    this.enqueue(entity.id);
  }

  async resync(): Promise<number> {
    const entities = await this.taskStore.listAgentTaskEntities();
    for (const entity of entities) this.enqueue(entity.id);
    return entities.length;
  }

  async reconcileTask(taskId: string): Promise<AgentTaskStatusTransition | undefined> {
    const task = await this.taskStore.getAgentTask(taskId);
    if (task === undefined) return undefined;
    const transition = await this.computeAndApply(task);
    if (transition !== undefined) this.onTransition?.(transition);
    return transition;
  }

  start(): void {
    if (this.running) return;
    if (this.stopRequested) throw new QueueClosedError();
    this.running = true;
    for (let i = 0; i < this.workerCount; i += 1) this.workers.push(this.workerLoop());
    this.resyncTimer = setInterval(() => {
      void this.resync().catch((error: unknown) => this.reportError(error, "__resync__"));
    }, this.resyncIntervalMs);
    this.resyncTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.running && this.stopRequested) return;
    this.stopRequested = true;
    if (this.resyncTimer !== undefined) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
    this.queue.close();
    const workers = this.workers;
    this.workers = [];
    await Promise.all(workers);
    this.running = false;
  }

  private async workerLoop(): Promise<void> {
    while (!this.stopRequested) {
      let item: WorkItemResult;
      try {
        item = await this.queue.take();
      } catch (error) {
        if (this.stopRequested) return;
        throw error;
      }
      try {
        await this.reconcileTask(item.key);
        this.queue.acknowledge(item.key);
      } catch (error) {
        if (!this.stopRequested) this.queue.retry(item.key);
        this.reportError(error, item.key);
      }
    }
  }

  private async computeAndApply(
    task: AgentTaskView,
  ): Promise<AgentTaskStatusTransition | undefined> {
    if (isTerminal(task.status.phase)) return this.catchUpTerminal(task);
    if (task.status.phase === AgentTaskPhase.Running) return this.reconcileRunning(task);
    if (task.status.phase === AgentTaskPhase.PendingBind) return this.bindPendingTask(task);
    return this.reconcilePending(task);
  }

  private async reconcilePending(
    task: AgentTaskView,
  ): Promise<AgentTaskStatusTransition | undefined> {
    const blockedOn = await this.blockingDependencies(task);
    const nowIso = this.nowIso();
    if (blockedOn.length > 0) {
      const patch: AgentTaskStatusPatch = {
        phase: AgentTaskPhase.Pending,
        observedGeneration: task.spec.generation,
        conditions: upsertCondition(task.status.conditions, {
          type: AgentTaskConditionType.Blocked,
          status: "True",
          observedGeneration: task.spec.generation,
          lastTransitionTime: nowIso,
          reason: "depends-on",
          message: `Waiting for ${blockedOn.join(", ")}`,
        }, nowIso),
      };
      await this.taskStore.patchAgentTaskStatus(task.spec.id, patch);
      return transition(task, AgentTaskPhase.Pending, "depends-on");
    }
    const patch: AgentTaskStatusPatch = {
      phase: AgentTaskPhase.PendingBind,
      observedGeneration: task.spec.generation,
      conditions: upsertCondition(task.status.conditions, {
        type: AgentTaskConditionType.Scheduled,
        status: "True",
        observedGeneration: task.spec.generation,
        lastTransitionTime: nowIso,
        reason: "ready-to-bind",
        message: "",
      }, nowIso),
      lastTransitionAt: nowIso,
    };
    await this.taskStore.patchAgentTaskStatus(task.spec.id, patch);
    return transition(task, AgentTaskPhase.PendingBind, "ready-to-bind");
  }

  private async bindPendingTask(
    task: AgentTaskView,
  ): Promise<AgentTaskStatusTransition | undefined> {
    if (task.status.sessionId !== undefined) return this.reconcileRunning(task);
    const { session } = await this.binder.bind({ task });
    const nowIso = this.nowIso();
    let conditions = upsertCondition(task.status.conditions, {
      type: AgentTaskConditionType.Bound,
      status: "True",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: "session-bound",
      message: `Started ${session.id}`,
    }, nowIso);
    conditions = upsertCondition(conditions, {
      type: AgentTaskConditionType.Running,
      status: "True",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: "session-running",
      message: "",
    }, nowIso);
    await this.taskStore.patchAgentTaskStatus(task.spec.id, {
      phase: AgentTaskPhase.Running,
      sessionId: session.id,
      observedGeneration: task.spec.generation,
      conditions,
      lastTransitionAt: nowIso,
    });
    return transition(task, AgentTaskPhase.Running, "session-bound");
  }

  private async reconcileRunning(
    task: AgentTaskView,
  ): Promise<AgentTaskStatusTransition | undefined> {
    if (task.status.sessionId === undefined) return this.failLostSession(task);
    const sessions = await this.runtime.listSessions();
    const session = sessions.find((candidate) => candidate.id === task.status.sessionId);
    if (session !== undefined && (session.status === "running" || session.status === "idle")) {
      return undefined;
    }
    return this.failLostSession(task);
  }

  private async failLostSession(task: AgentTaskView): Promise<AgentTaskStatusTransition> {
    const nowIso = this.nowIso();
    let conditions = upsertCondition(task.status.conditions, {
      type: AgentTaskConditionType.Running,
      status: "False",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: "session-lost",
      message: "",
    }, nowIso);
    conditions = upsertCondition(conditions, {
      type: AgentTaskConditionType.Failed,
      status: "True",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: "session-lost",
      message: "",
    }, nowIso);
    await this.taskStore.patchAgentTaskStatus(task.spec.id, {
      phase: AgentTaskPhase.Failed,
      observedGeneration: task.spec.generation,
      conditions,
      lastTransitionAt: nowIso,
    });
    return transition(task, AgentTaskPhase.Failed, "session-lost");
  }

  private async catchUpTerminal(
    task: AgentTaskView,
  ): Promise<AgentTaskStatusTransition | undefined> {
    if (task.status.observedGeneration >= task.spec.generation) return undefined;
    await this.taskStore.patchAgentTaskStatus(task.spec.id, {
      observedGeneration: task.spec.generation,
    });
    return transition(task, task.status.phase, "terminal-observed-generation");
  }

  private async blockingDependencies(task: AgentTaskView): Promise<readonly string[]> {
    const blocked: string[] = [];
    for (const dependencyId of task.spec.dependsOn) {
      const dependency = await this.taskStore.getAgentTask(dependencyId);
      if (dependency?.status.phase !== AgentTaskPhase.Succeeded) blocked.push(dependencyId);
    }
    return blocked;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private reportError(error: unknown, taskId: string): void {
    try {
      this.onError?.(error, taskId);
    } catch {
      return;
    }
  }
}

function validateResyncIntervalMs(value: number): void {
  if (!Number.isFinite(value) || value < 1 || value > MAX_RESYNC_INTERVAL_MS) {
    throw new RangeError(
      `resyncIntervalMs must be a finite positive number no greater than ${MAX_RESYNC_INTERVAL_MS}`,
    );
  }
}

function validateWorkerCount(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKER_COUNT) {
    throw new RangeError(`workerCount must be an integer between 1 and ${MAX_WORKER_COUNT}`);
  }
}

function runtimeToPlatform(runtime: string): AgentConfig["platform"] {
  if (runtime === "claude" || runtime === "claude-code") return "claude-code";
  if (runtime === "gemini") return "gemini";
  if (runtime === "codex") return "codex";
  return undefined;
}

function isTerminal(phase: AgentTaskPhase): boolean {
  return phase === AgentTaskPhase.Succeeded || phase === AgentTaskPhase.Failed;
}

function transition(
  task: AgentTaskView,
  toPhase: AgentTaskPhase,
  reason: string,
): AgentTaskStatusTransition {
  return {
    taskId: task.spec.id,
    fromPhase: task.status.phase,
    toPhase,
    reason,
    observedGeneration: task.spec.generation,
  };
}

function upsertCondition(
  existing: readonly Condition[],
  next: Condition,
  nowIso: string,
): readonly Condition[] {
  const current = existing.find((condition) => condition.type === next.type);
  const stableNext =
    current !== undefined &&
    current.status === next.status &&
    current.reason === next.reason &&
    current.message === next.message
      ? { ...next, lastTransitionTime: current.lastTransitionTime }
      : { ...next, lastTransitionTime: nowIso };
  const rest = existing.filter((condition) => condition.type !== next.type);
  return [...rest, stableNext];
}
```

- [ ] **Step 4: Export task controller**

Modify `src/core/index.ts` near the claim-controller exports:

```ts
export type {
  AgentTaskStatusTransition,
  TaskBindRequest,
  TaskBindResult,
  TaskBinder,
  TaskControllerOptions,
  TaskControllerRuntime,
  TaskControllerStore,
} from "./task-controller.js";
export { DefaultTaskBinder, TaskController } from "./task-controller.js";
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
bun test src/core/task-controller.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/task-controller.ts src/core/task-controller.test.ts src/core/index.ts
git commit -m "feat: add agent task controller transitions"
```

## Task 2: Queue Lifecycle And Failure Injection

**Files:**
- Modify: `src/core/task-controller.test.ts`
- Modify: `src/core/task-controller.ts`

- [ ] **Step 1: Add failing worker/retry tests**

Append these tests to `src/core/task-controller.test.ts`:

```ts
import { KeyedWorkQueue } from "./workqueue.js";

describe("TaskController worker lifecycle", () => {
  test("rejects invalid lifecycle options", () => {
    const invalidOptions: ReadonlyArray<{
      readonly resyncIntervalMs?: number;
      readonly workerCount?: number;
    }> = [
      { resyncIntervalMs: 0 },
      { resyncIntervalMs: Number.NaN },
      { workerCount: 0 },
      { workerCount: 1.5 },
    ];

    for (const options of invalidOptions) {
      const store = new FakeTaskStore();
      expect(
        () =>
          new TaskController({
            taskStore: store,
            runtime: new FakeRuntime(),
            now: () => FIXED_NOW_MS,
            ...options,
          }),
      ).toThrow(RangeError);
    }
  });

  test("resync enqueues every AgentTask entity id", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ id: "task-a" }));
    store.seed(taskView({ id: "task-b" }));
    const queue = new KeyedWorkQueue({ now: () => FIXED_NOW_MS });
    const controller = new TaskController({
      taskStore: store,
      runtime: new FakeRuntime(),
      queue,
      now: () => FIXED_NOW_MS,
    });

    const count = await controller.resync();

    expect(count).toBe(2);
    await expect(queue.take()).resolves.toEqual({ key: "task-a", attempt: 0 });
    await expect(queue.take()).resolves.toEqual({ key: "task-b", attempt: 0 });
  });

  test("failed worker reconcile retries and re-reads fresh task state", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    let fail = true;
    const binder: TaskBinder = {
      bind: async () => {
        if (fail) throw new Error("spawn unavailable");
        return { session: { id: "session-retry", role: "worker", status: "running" } };
      },
    };
    const errors: Array<{ readonly taskId: string; readonly message: string }> = [];
    const controller = new TaskController({
      taskStore: store,
      runtime: new FakeRuntime(),
      binder,
      queue: new KeyedWorkQueue({ baseDelayMs: 1, maxDelayMs: 1 }),
      now: () => FIXED_NOW_MS,
      onError: (error, taskId) => {
        errors.push({ taskId, message: error instanceof Error ? error.message : String(error) });
      },
    });

    controller.enqueue("task-1");
    controller.start();
    await waitFor(() => errors.length === 1);
    fail = false;
    await waitFor(() => store.patches.some((patch) => patch.patch.sessionId === "session-retry"));
    await controller.stop();

    expect(errors).toEqual([{ taskId: "task-1", message: "spawn unavailable" }]);
  });

  test("stop cancels workers and rejects new work", async () => {
    const store = new FakeTaskStore();
    const controller = controllerFor(store);

    controller.start();
    await controller.stop();

    expect(() => controller.enqueue("task-1")).toThrow("Work queue is closed");
    expect(() => controller.start()).toThrow("Work queue is closed");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 500) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test src/core/task-controller.test.ts
```

Expected: FAIL if the initial implementation lacks retry, validation, or lifecycle behavior.

- [ ] **Step 3: Fill lifecycle gaps**

Update `src/core/task-controller.ts` so:

```ts
start(): void {
  if (this.running) return;
  if (this.stopRequested) throw new QueueClosedError();
  this.running = true;
  this.stopRequested = false;
  for (let i = 0; i < this.workerCount; i += 1) {
    this.workers.push(this.workerLoop());
  }
  this.resyncTimer = setInterval(() => {
    void this.resync().catch((error: unknown) => this.reportError(error, "__resync__"));
  }, this.resyncIntervalMs);
  this.resyncTimer.unref?.();
}
```

Also confirm `workerLoop()` catches reconcile errors, calls `queue.retry(item.key)`, and calls `reportError(error, item.key)`.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
bun test src/core/task-controller.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failure-injection convergence tests**

Append this focused table test:

```ts
describe("TaskController failure injection", () => {
  test("converges when each bind step fails once", async () => {
    const cases = ["bind", "patch-running"] as const;

    for (const failurePoint of cases) {
      const store = new FakeTaskStore();
      store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
      let failed = false;
      const binder: TaskBinder = {
        bind: async () => {
          if (failurePoint === "bind" && !failed) {
            failed = true;
            throw new Error("injected bind failure");
          }
          return { session: { id: `session-${failurePoint}`, role: "worker", status: "running" } };
        },
      };
      const originalPatch = store.patchAgentTaskStatus;
      store.patchAgentTaskStatus = async (taskId, patch) => {
        if (failurePoint === "patch-running" && patch.phase === AgentTaskPhase.Running && !failed) {
          failed = true;
          throw new Error("injected patch failure");
        }
        return originalPatch(taskId, patch);
      };
      const controller = controllerFor(store, { binder });

      await expect(controller.reconcileTask("task-1")).rejects.toThrow("injected");
      await expect(controller.reconcileTask("task-1")).resolves.toBeDefined();

      expect(store.views.get("task-1")?.status.phase).toBe(AgentTaskPhase.Running);
    }
  });
});
```

- [ ] **Step 6: Run tests to verify GREEN**

Run:

```bash
bun test src/core/task-controller.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/task-controller.ts src/core/task-controller.test.ts
git commit -m "test: cover task controller retry convergence"
```

## Task 3: Watch And Informer AgentTask Support

**Files:**
- Modify: `src/core/watch-events.ts`
- Modify: `src/core/informer.ts`
- Modify: `src/core/informer.test.ts`
- Modify: `src/server/routes/watch.ts`
- Modify: `tests/server/routes.test.ts` or create focused assertions in `tests/server/agent-tasks.test.ts`

- [ ] **Step 1: Write failing informer/watch tests**

Append a focused test to `src/core/informer.test.ts` near factory kind support tests:

```ts
test("InformerFactory supports AgentTask in local and remote modes", () => {
  const localFactory = new InformerFactory({
    mode: "local",
    hub: new WatchHub(),
    namespace: "default",
    listFn: () => [],
  });
  expect(localFactory.supportsKind("AgentTask")).toBe(true);
  expect(localFactory.informerFor("AgentTask")).toBeDefined();

  const remoteFactory = new InformerFactory({
    mode: "remote",
    baseUrl: "http://localhost:4515",
    authHeader: "Bearer test",
  });
  expect(remoteFactory.supportsKind("AgentTask")).toBe(true);
  expect(remoteFactory.informerFor("AgentTask")).toBeDefined();
});
```

Add a server route test in `tests/server/agent-tasks.test.ts`:

```ts
test("GET /api/list supports AgentTask snapshots", async () => {
  await ctx.agentTaskStore.putAgentTaskSpec({
    id: "task-watch-list",
    ...SPEC_BODY,
    generation: 0,
    createdAt: "2026-05-14T12:00:00.000Z",
  });

  const res = await ctx.app.request("/api/list?kind=AgentTask", {
    headers: TEST_AUTH_HEADERS,
  });

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.items[0].kind).toBe("AgentTask");
  expect(data.items[0].id).toBe("task-watch-list");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test src/core/informer.test.ts tests/server/agent-tasks.test.ts
```

Expected: FAIL because `AgentTask` is not assignable to `WatchKind` or the server watch route returns validation/config errors.

- [ ] **Step 3: Extend watch event types**

Modify `src/core/watch-events.ts`:

```ts
import type { AgentTaskEntity } from "./agent-task.js";
import type { AgentSessionEntity, ClaimEntity, ContributionEntity } from "./entity.js";

export type WatchKind = "Contribution" | "Claim" | "AgentSession" | "AgentTask";

export type WatchEntity = ContributionEntity | ClaimEntity | AgentSessionEntity | AgentTaskEntity;
```

- [ ] **Step 4: Extend informer kind mapping and supported sets**

Modify the import and mapping in `src/core/informer.ts`:

```ts
import type { AgentTaskEntity } from "./agent-task.js";
import type { AgentSessionEntity, ClaimEntity, ContributionEntity } from "./entity.js";

export type EntityForKind<K extends WatchKind> = K extends "Contribution"
  ? ContributionEntity
  : K extends "Claim"
    ? ClaimEntity
    : K extends "AgentSession"
      ? AgentSessionEntity
      : K extends "AgentTask"
        ? AgentTaskEntity
        : never;
```

Update kind lists:

```ts
const REMOTE_KINDS: readonly WatchKind[] = ["Contribution", "Claim", "AgentTask"];
const LOCAL_KINDS: readonly WatchKind[] = [
  "Contribution",
  "Claim",
  "AgentSession",
  "AgentTask",
];
```

- [ ] **Step 5: Extend server watch routes**

Modify `src/server/routes/watch.ts` imports:

```ts
import { agentTaskViewToEntity } from "../../core/agent-task.js";
import { claimToEntity, contributionToEntity } from "../../core/entity.js";
```

Update kind constants:

```ts
const KIND_VALUES = ["Contribution", "Claim", "AgentSession", "AgentTask"] as const;
const SUPPORTED_KINDS: ReadonlySet<(typeof KIND_VALUES)[number]> = new Set([
  "Contribution",
  "Claim",
  "AgentTask",
]);
```

Update `hydrateEntity`:

```ts
if (kind === "AgentTask") {
  const view = await deps.agentTaskStore?.getAgentTask(entityId);
  if (view !== undefined) {
    return agentTaskViewToEntity(view, namespace) as MaybeVersioned;
  }
  return undefined;
}
```

Update `listForKind`:

```ts
case "AgentTask":
  if (deps.agentTaskStore === undefined) {
    throw new Error("AgentTask store is not configured");
  }
  return deps.agentTaskStore.listAgentTaskEntities();
```

Before calling `listForKind`, add an explicit configured-store guard so missing task stores return `501`:

```ts
if (kind === "AgentTask" && deps.agentTaskStore === undefined) {
  return c.json(
    {
      error: {
        code: "NOT_CONFIGURED",
        message: "AgentTask store is not configured",
      },
    },
    501,
  );
}
```

Update `makeWatchEntityFetcher` at the bottom of `src/server/serve.ts` so cross-process watch hydration can fetch task entities:

```ts
function makeWatchEntityFetcher(stores: {
  contributionStore: import("../core/store.js").ContributionStore;
  claimStore: import("../core/store.js").ClaimStore;
  agentTaskStore?: import("../core/store.js").AgentTaskStore | undefined;
}): (kind: WatchKind, namespace: string, id: string) => Promise<WatchEntity> {
  return async (kind, namespace, id) => {
    if (kind === "Contribution") {
      const c = await stores.contributionStore.get(id);
      if (!c) throw new Error(`Contribution ${id} not found`);
      return contributionToEntity(c, namespace);
    }
    if (kind === "Claim") {
      const c = await stores.claimStore.getClaim(id);
      if (!c) throw new Error(`Claim ${id} not found`);
      return claimToEntity(c, () => Date.now(), namespace);
    }
    if (kind === "AgentTask") {
      const view = await stores.agentTaskStore?.getAgentTask(id);
      if (!view) throw new Error(`AgentTask ${id} not found`);
      return agentTaskViewToEntity(view, namespace);
    }
    throw new Error(`Unsupported kind for watch fetcher: ${kind}`);
  };
}
```

Update the call site:

```ts
fetchEntity: makeWatchEntityFetcher({
  contributionStore: serverContributionStore,
  claimStore: serverClaimStore,
  agentTaskStore: runtime.agentTaskStore,
}),
```

- [ ] **Step 6: Run tests to verify GREEN**

Run:

```bash
bun test src/core/informer.test.ts tests/server/agent-tasks.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/watch-events.ts src/core/informer.ts src/core/informer.test.ts src/server/routes/watch.ts tests/server/agent-tasks.test.ts
git commit -m "feat: add AgentTask watch informer support"
```

## Task 4: Store And Local Watch Fan-Out

**Files:**
- Modify: `src/local/sqlite-store.ts`
- Modify: `src/local/sqlite-agent-task-store.test.ts`
- Modify: `src/local/watch-hub-recorder.ts`
- Modify: `src/local/runtime.ts`

- [ ] **Step 1: Write failing SQLite callback tests**

Append to `src/local/sqlite-agent-task-store.test.ts`:

```ts
test("emits AgentTask write callbacks for spec create, spec update, and status patch", async () => {
  const seen: Array<{ readonly op: "ADDED" | "MODIFIED"; readonly id: string }> = [];
  stores.agentTaskStore.onAgentTaskWrite = (op, view) => {
    seen.push({ op, id: view.spec.id });
  };

  await stores.agentTaskStore.putAgentTaskSpec({
    id: "task-callback",
    worktree: "/tmp/worktree",
    runtime: "codex",
    role: "worker",
    prompt: "Implement callback",
    dependsOn: [],
    generation: 0,
    createdAt: "2026-05-14T12:00:00.000Z",
  });
  await stores.agentTaskStore.putAgentTaskSpec({
    id: "task-callback",
    worktree: "/tmp/worktree",
    runtime: "codex",
    role: "worker",
    prompt: "Implement callback update",
    dependsOn: [],
    generation: 0,
    createdAt: "2026-05-14T12:00:00.000Z",
  });
  await stores.agentTaskStore.patchAgentTaskStatus("task-callback", {
    phase: AgentTaskPhase.PendingBind,
  });

  expect(seen).toEqual([
    { op: "ADDED", id: "task-callback" },
    { op: "MODIFIED", id: "task-callback" },
    { op: "MODIFIED", id: "task-callback" },
  ]);
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
bun test src/local/sqlite-agent-task-store.test.ts
```

Expected: FAIL because `onAgentTaskWrite` does not exist.

- [ ] **Step 3: Add SQLite callback support**

Modify `SqliteAgentTaskStore` in `src/local/sqlite-store.ts`:

```ts
export class SqliteAgentTaskStore implements AgentTaskStore {
  readonly storeIdentity: string;
  onAgentTaskWrite: ((op: "ADDED" | "MODIFIED", view: AgentTaskView) => void) | undefined;
```

In `putAgentTaskSpec`, track operation and fire after reading the view:

```ts
let op: "ADDED" | "MODIFIED" = "MODIFIED";
const tx = this.db.transaction(() => {
  const existing = this.readAgentTask(spec.id);
  if (existing === null) {
    op = "ADDED";
    // existing insert body
    return;
  }
  op = "MODIFIED";
  // existing update body
});
tx.immediate();

const view = this.readAgentTask(spec.id);
if (view === null) throw new Error(`Failed to read back agent task '${spec.id}'`);
this.fireAgentTaskWrite(op, view);
return view;
```

In `patchAgentTaskStatus`, fire after transaction returns:

```ts
const view = tx.immediate();
this.fireAgentTaskWrite("MODIFIED", view);
return view;
```

Add private helper:

```ts
private fireAgentTaskWrite(op: "ADDED" | "MODIFIED", view: AgentTaskView): void {
  try {
    this.onAgentTaskWrite?.(op, view);
  } catch {
    return;
  }
}
```

- [ ] **Step 4: Extend WatchHubRecorder**

Modify `src/local/watch-hub-recorder.ts`:

```ts
import { agentTaskViewToEntity, type AgentTaskView } from "../core/agent-task.js";

export interface WatchHubRecorder {
  contribution(op: WatchOp, c: Contribution): void;
  claim(op: WatchOp, c: Claim): void;
  agentSession(op: WatchOp, s: AgentSession): void;
  agentTask(op: WatchOp, view: AgentTaskView): void;
}
```

Update `safeRecord` kind union and entity union to include `AgentTask`, then add:

```ts
agentTask(op, view) {
  safeRecord("AgentTask", op, agentTaskViewToEntity(view, namespace));
},
```

- [ ] **Step 5: Wire local runtime**

Modify `src/local/runtime.ts` inside the `if (options.watchHub)` block:

```ts
stores.agentTaskStore.onAgentTaskWrite = (op, view) => recorder.agentTask(op, view);
```

- [ ] **Step 6: Run tests to verify GREEN**

Run:

```bash
bun test src/local/sqlite-agent-task-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/local/sqlite-store.ts src/local/sqlite-agent-task-store.test.ts src/local/watch-hub-recorder.ts src/local/runtime.ts
git commit -m "feat: publish AgentTask local watch events"
```

## Task 5: HTTP AgentTask Watch Fan-Out

**Files:**
- Modify: `src/server/routes/agent-tasks.ts`
- Modify: `tests/server/agent-tasks.test.ts`

- [ ] **Step 1: Write failing route fan-out tests**

Append to `tests/server/agent-tasks.test.ts`:

```ts
test("PUT /api/agent-tasks/:id emits AgentTask watch writes", async () => {
  const events: Array<{ readonly op: string; readonly id: string }> = [];
  const original = ctx.deps.watchHub.recordWrite.bind(ctx.deps.watchHub);
  ctx.deps.watchHub.recordWrite = (event) => {
    if (event.kind === "AgentTask") events.push({ op: event.op, id: event.entity.id });
    return original(event);
  };

  await ctx.app.request("/api/agent-tasks/task-watch-route", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
    body: JSON.stringify(SPEC_BODY),
  });
  await ctx.app.request("/api/agent-tasks/task-watch-route", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
    body: JSON.stringify({ ...SPEC_BODY, prompt: "Updated route task" }),
  });

  expect(events).toEqual([
    { op: "ADDED", id: "task-watch-route" },
    { op: "MODIFIED", id: "task-watch-route" },
  ]);
});

test("PATCH /api/agent-tasks/:id/status emits AgentTask watch writes", async () => {
  const events: Array<{ readonly op: string; readonly id: string }> = [];
  const original = ctx.deps.watchHub.recordWrite.bind(ctx.deps.watchHub);
  ctx.deps.watchHub.recordWrite = (event) => {
    if (event.kind === "AgentTask") events.push({ op: event.op, id: event.entity.id });
    return original(event);
  };
  await ctx.app.request("/api/agent-tasks/task-watch-status", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
    body: JSON.stringify(SPEC_BODY),
  });

  const res = await ctx.app.request("/api/agent-tasks/task-watch-status/status", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...TEST_AUTH_HEADERS,
      ...TEST_CONTROLLER_HEADERS,
    },
    body: JSON.stringify({ phase: AgentTaskPhase.PendingBind }),
  });

  expect(res.status).toBe(200);
  expect(events.at(-1)).toEqual({ op: "MODIFIED", id: "task-watch-status" });
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
bun test tests/server/agent-tasks.test.ts
```

Expected: FAIL because no `AgentTask` watch events are emitted by the route.

- [ ] **Step 3: Emit watch events from routes**

Modify imports in `src/server/routes/agent-tasks.ts`:

```ts
import { AgentTaskPhase, agentTaskViewToEntity } from "../../core/agent-task.js";
```

In `PUT`, after `const view = await store.putAgentTaskSpec(spec);`:

```ts
const namespace = c.get("namespace");
c.get("deps").watchHub.recordWrite({
  kind: "AgentTask",
  namespace,
  op: existing === undefined ? "ADDED" : "MODIFIED",
  entity: agentTaskViewToEntity(view, namespace),
});
return c.json(view, existing === undefined ? 201 : 200);
```

In `PATCH /:id/status`, after status patch:

```ts
const view = await store.patchAgentTaskStatus(c.req.param("id"), patch);
const namespace = c.get("namespace");
c.get("deps").watchHub.recordWrite({
  kind: "AgentTask",
  namespace,
  op: "MODIFIED",
  entity: agentTaskViewToEntity(view, namespace),
});
return c.json(view);
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
bun test tests/server/agent-tasks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/agent-tasks.ts tests/server/agent-tasks.test.ts
git commit -m "feat: emit AgentTask watch events from HTTP routes"
```

## Task 6: Server Startup Controller Wiring

**Files:**
- Modify: `src/server/serve.ts`
- Create: `src/server/task-controller-wiring.test.ts` if route-level testing cannot cover the helper

- [ ] **Step 1: Extract shared runtime helper and write failing test**

If direct testing of `serve.ts` is too expensive, create a small helper in `src/server/task-controller-wiring.ts`:

```ts
import type { AgentRuntime } from "../core/agent-runtime.js";
import { selectRuntime } from "../core/select-runtime.js";
import { TmuxRuntime } from "../core/tmux-runtime.js";

export async function createServerAgentRuntime(): Promise<AgentRuntime> {
  const picked = selectRuntime();
  if (await picked.isAvailable()) return picked;
  return new TmuxRuntime();
}

export function taskControllerEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.GROVE_TASK_CONTROLLER !== "0";
}
```

Create `src/server/task-controller-wiring.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { taskControllerEnabled } from "./task-controller-wiring.js";

describe("task controller server wiring", () => {
  test("enables task controller by default and supports env opt-out", () => {
    expect(taskControllerEnabled({})).toBe(true);
    expect(taskControllerEnabled({ GROVE_TASK_CONTROLLER: "1" })).toBe(true);
    expect(taskControllerEnabled({ GROVE_TASK_CONTROLLER: "0" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
bun test src/server/task-controller-wiring.test.ts
```

Expected: FAIL because `task-controller-wiring.js` does not exist.

- [ ] **Step 3: Implement helper and use it from serve**

Add `src/server/task-controller-wiring.ts` as shown in Step 1.

Modify `src/server/serve.ts` imports:

```ts
import { TaskController } from "../core/task-controller.js";
import { createServerAgentRuntime, taskControllerEnabled } from "./task-controller-wiring.js";
```

Create one shared runtime before the `SessionService` block:

```ts
let sharedAgentRuntime: import("../core/agent-runtime.js").AgentRuntime | undefined;
const getSharedAgentRuntime = async (): Promise<import("../core/agent-runtime.js").AgentRuntime> => {
  sharedAgentRuntime ??= await createServerAgentRuntime();
  return sharedAgentRuntime;
};
```

Start the task controller after `deps` and before server start:

```ts
let taskController: TaskController | undefined;
if (taskControllerEnabled(process.env) && runtime.agentTaskStore !== undefined) {
  taskController = new TaskController({
    taskStore: runtime.agentTaskStore,
    runtime: await getSharedAgentRuntime(),
    onError(error, taskId) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[task-controller] ${taskId}: ${detail}\n`);
    },
  });
  await taskController.resync();
  taskController.start();
  console.log("task-controller enabled");
}
```

Update `SessionService` runtime selection:

```ts
const agentRuntime = await getSharedAgentRuntime();
```

Add task controller shutdown in `shutdown()` before `sessionService.destroy()`:

```ts
await taskController?.stop();
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
bun test src/server/task-controller-wiring.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/serve.ts src/server/task-controller-wiring.ts src/server/task-controller-wiring.test.ts
git commit -m "feat: start task controller in grove server"
```

## Task 7: Final Verification And Issue Sweep

**Files:**
- Modify: files changed by Tasks 1-6 when type, lint, or test verification identifies a concrete defect.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test src/core/task-controller.test.ts src/core/informer.test.ts src/local/sqlite-agent-task-store.test.ts tests/server/agent-tasks.test.ts src/server/task-controller-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run lint/check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Run full test suite if focused checks pass**

Run:

```bash
bun test --timeout 60000
```

Expected: PASS. If this is too slow for the local environment, record the timeout or failing test names in the final handoff.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only intentional files changed and no whitespace errors.

- [ ] **Step 6: Commit final fixes**

```bash
git add src/core src/local src/server tests docs/superpowers/plans/2026-05-14-task-controller-reconcile-loop.md
git commit -m "test: verify task controller integration"
```

## Self-Review Notes

- Spec coverage: Tasks 1-2 cover controller loop, binder, retry, and failure convergence. Tasks 3-5 cover watch/informer and write fan-out. Task 6 covers default server startup and shared runtime. Task 7 covers verification.
- Placeholder scan: no deferred implementation markers are used in the task steps.
- Type consistency: the plan consistently uses `TaskController`, `DefaultTaskBinder`, `TaskControllerStore`, `TaskControllerRuntime`, `AgentTaskStatusTransition`, and `AgentTaskStatusPatch`.
