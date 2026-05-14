import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentSession } from "./agent-runtime.js";
import {
  type AgentTaskEntity,
  AgentTaskPhase,
  type AgentTaskStatusRecord,
  type AgentTaskView,
  agentTaskViewToEntity,
} from "./agent-task.js";
import type { Condition } from "./entity.js";
import type { AgentTaskStatusPatch } from "./store.js";
import {
  DefaultTaskBinder,
  type TaskBinder,
  TaskController,
  type TaskControllerRuntime,
  type TaskControllerStore,
} from "./task-controller.js";
import { KeyedWorkQueue } from "./workqueue.js";

const FIXED_NOW_MS = Date.parse("2026-05-14T12:00:00.000Z");
const FIXED_NOW_ISO = "2026-05-14T12:00:00.000Z";

interface RecordedPatch {
  readonly taskId: string;
  readonly patch: AgentTaskStatusPatch;
}

class FakeTaskStore implements TaskControllerStore {
  readonly views = new Map<string, AgentTaskView>();
  readonly patches: RecordedPatch[] = [];
  patchError: Error | undefined;

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
    if (this.patchError !== undefined) throw this.patchError;
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
  readonly closeCalls: AgentSession[] = [];
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
    this.closeCalls.push(session);
    this.sessions.delete(session.id);
  };
}

class FakeBinder implements TaskBinder {
  readonly calls: AgentTaskView[] = [];
  session: AgentSession = { id: "bound-session", role: "worker", status: "running" };

  bind = async ({
    task,
  }: {
    readonly task: AgentTaskView;
  }): Promise<{ readonly session: AgentSession }> => {
    this.calls.push(task);
    return { session: this.session };
  };
}

function taskView(
  overrides: {
    readonly id?: string;
    readonly phase?: AgentTaskPhase;
    readonly generation?: number;
    readonly observedGeneration?: number;
    readonly dependsOn?: readonly string[];
    readonly sessionId?: string;
    readonly conditions?: readonly Condition[];
  } = {},
): AgentTaskView {
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

function condition(
  conditions: readonly Condition[] | undefined,
  type: string,
): Condition | undefined {
  return conditions?.find((candidate) => candidate.type === type);
}

function makeCondition(type: string, overrides: Partial<Condition> = {}): Condition {
  return {
    type,
    status: "True",
    observedGeneration: 1,
    lastTransitionTime: FIXED_NOW_ISO,
    reason: "seeded",
    message: "",
    ...overrides,
  };
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
    store.seed(
      taskView({
        phase: AgentTaskPhase.Failed,
        generation: 4,
        observedGeneration: 2,
      }),
    );
    const controller = controllerFor(store);

    const transition = await controller.reconcileTask("task-1");

    expect(transition).toEqual({
      taskId: "task-1",
      fromPhase: AgentTaskPhase.Failed,
      toPhase: AgentTaskPhase.Failed,
      reason: "terminal-observed-generation",
      observedGeneration: 4,
    });
    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBeUndefined();
    expect(patch.observedGeneration).toBe(4);
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

  test("pending tasks that are already blocked do not patch unchanged status", async () => {
    const store = new FakeTaskStore();
    store.seed(
      taskView({
        observedGeneration: 1,
        dependsOn: ["task-a", "task-b"],
        conditions: [
          makeCondition("Blocked", {
            reason: "depends-on",
            message: "Waiting for task-a, task-b",
          }),
        ],
      }),
    );
    const controller = controllerFor(store);

    const transition = await controller.reconcileTask("task-1");

    expect(transition).toBeUndefined();
    expect(store.patches).toEqual([]);
  });

  test("pending tasks with satisfied dependencies move to PendingBind", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ id: "task-a", phase: AgentTaskPhase.Succeeded, observedGeneration: 1 }));
    store.seed(taskView({ dependsOn: ["task-a"] }));
    const controller = controllerFor(store);

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.PendingBind);
    expect(condition(patch.conditions, "Scheduled")).toEqual({
      type: "Scheduled",
      status: "True",
      observedGeneration: 1,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "ready-to-bind",
      message: "",
    });
  });

  test("pending tasks clear stale Blocked condition when dependencies become satisfied", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ id: "task-a", phase: AgentTaskPhase.Succeeded, observedGeneration: 1 }));
    store.seed(
      taskView({
        dependsOn: ["task-a"],
        conditions: [
          makeCondition("Blocked", {
            reason: "depends-on",
            message: "Waiting for task-a",
          }),
        ],
      }),
    );
    const controller = controllerFor(store);

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(condition(patch.conditions, "Blocked")).toEqual({
      type: "Blocked",
      status: "False",
      observedGeneration: 1,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "ready-to-bind",
      message: "",
    });
    expect(condition(patch.conditions, "Scheduled")).toEqual({
      type: "Scheduled",
      status: "True",
      observedGeneration: 1,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "ready-to-bind",
      message: "",
    });
  });

  test("PendingBind tasks bind and become Running", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    const binder = new FakeBinder();
    const controller = controllerFor(store, { binder });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(binder.calls.map((task) => task.spec.id)).toEqual(["task-1"]);
    expect(patch.phase).toBe(AgentTaskPhase.Running);
    expect(patch.sessionId).toBe("bound-session");
    expect(condition(patch.conditions, "Bound")).toEqual({
      type: "Bound",
      status: "True",
      observedGeneration: 1,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "session-bound",
      message: "",
    });
    expect(condition(patch.conditions, "Running")).toEqual({
      type: "Running",
      status: "True",
      observedGeneration: 1,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "session-running",
      message: "",
    });
  });

  test("PendingBind tasks close spawned sessions when Running patch fails", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    store.patchError = new Error("patch failed");
    const runtime = new FakeRuntime();
    const controller = controllerFor(store, { runtime });

    await expect(controller.reconcileTask("task-1")).rejects.toThrow("patch failed");

    expect(runtime.spawnCalls).toHaveLength(1);
    expect(runtime.closeCalls.map((session) => session.id)).toEqual(["session-1"]);
    expect(runtime.sessions.has("session-1")).toBe(false);
  });

  test("running tasks reattach when the session is live", async () => {
    const store = new FakeTaskStore();
    store.seed(
      taskView({
        phase: AgentTaskPhase.Running,
        observedGeneration: 1,
        sessionId: "session-live",
      }),
    );
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
    store.seed(
      taskView({
        phase: AgentTaskPhase.Running,
        observedGeneration: 1,
        sessionId: "session-missing",
      }),
    );
    const controller = controllerFor(store, { runtime: new FakeRuntime() });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Failed);
    expect(condition(patch.conditions, "Failed")).toEqual({
      type: "Failed",
      status: "True",
      observedGeneration: 1,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "session-lost",
      message: "",
    });
  });

  test("running tasks clear stale Running condition when the session is missing", async () => {
    const store = new FakeTaskStore();
    store.seed(
      taskView({
        phase: AgentTaskPhase.Running,
        observedGeneration: 1,
        sessionId: "session-missing",
        conditions: [
          makeCondition("Running", {
            reason: "session-running",
          }),
        ],
      }),
    );
    const controller = controllerFor(store, { runtime: new FakeRuntime() });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(condition(patch.conditions, "Running")).toEqual({
      type: "Running",
      status: "False",
      observedGeneration: 1,
      lastTransitionTime: FIXED_NOW_ISO,
      reason: "session-lost",
      message: "",
    });
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
    expect(queue.pendingKeys()).toEqual(["task-a", "task-b"]);
  });

  test("failed worker reconcile retries and re-reads fresh task state", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    let fail = true;
    const bindCalls: Array<{ readonly prompt: string; readonly generation: number }> = [];
    const binder: TaskBinder = {
      bind: async ({ task }) => {
        bindCalls.push({ prompt: task.spec.prompt, generation: task.spec.generation });
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
    const current = store.views.get("task-1");
    if (current === undefined) throw new Error("expected seeded task");
    store.views.set("task-1", {
      spec: {
        ...current.spec,
        prompt: "Implement the updated task",
        generation: 2,
      },
      status: current.status,
    });
    fail = false;
    await waitFor(() => store.patches.some((patch) => patch.patch.sessionId === "session-retry"));
    await controller.stop();

    expect(bindCalls).toEqual([
      { prompt: "Implement the task", generation: 1 },
      { prompt: "Implement the updated task", generation: 2 },
    ]);
    expect(errors).toEqual([{ taskId: "task-1", message: "spawn unavailable" }]);
  });

  test("start is idempotent while running", async () => {
    const store = new FakeTaskStore();
    store.seed(
      taskView({ id: "task-1", phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }),
    );
    store.seed(
      taskView({ id: "task-2", phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }),
    );
    let releaseBind: (() => void) | undefined;
    let blockNextBind = true;
    const bindCalls: string[] = [];
    const binder: TaskBinder = {
      bind: async ({ task }) => {
        bindCalls.push(task.spec.id);
        if (blockNextBind) {
          blockNextBind = false;
          await new Promise<void>((resolve) => {
            releaseBind = resolve;
          });
        }
        return { session: { id: `session-${task.spec.id}`, role: "worker", status: "running" } };
      },
    };
    const controller = new TaskController({
      taskStore: store,
      runtime: new FakeRuntime(),
      binder,
      queue: new KeyedWorkQueue({ baseDelayMs: 1, maxDelayMs: 1 }),
      now: () => FIXED_NOW_MS,
      workerCount: 1,
    });

    controller.enqueue("task-1");
    controller.enqueue("task-2");
    controller.start();
    controller.start();
    await waitFor(() => bindCalls.length === 1);
    await sleep(10);

    expect(bindCalls).toEqual(["task-1"]);
    releaseBind?.();
    await waitFor(() => store.patches.some((patch) => patch.taskId === "task-1"));
    await controller.stop();
  });

  test("stop cancels workers and rejects new work", async () => {
    const store = new FakeTaskStore();
    const controller = controllerFor(store);

    controller.start();
    await controller.stop();
    await controller.stop();

    expect(() => controller.enqueue("task-1")).toThrow("Work queue is closed");
    expect(() => controller.start()).toThrow("Work queue is closed");
  });
});

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

  test("worker retry closes failed patch session and converges without duplicate live sessions", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    const runtime = new FakeRuntime();
    let failed = false;
    const errors: Array<{ readonly taskId: string; readonly message: string }> = [];
    const originalPatch = store.patchAgentTaskStatus;
    store.patchAgentTaskStatus = async (taskId, patch) => {
      if (patch.phase === AgentTaskPhase.Running && !failed) {
        failed = true;
        throw new Error("injected patch failure");
      }
      return originalPatch(taskId, patch);
    };
    const controller = new TaskController({
      taskStore: store,
      runtime,
      queue: new KeyedWorkQueue({ baseDelayMs: 1, maxDelayMs: 1 }),
      now: () => FIXED_NOW_MS,
      onError: (error, taskId) => {
        errors.push({ taskId, message: error instanceof Error ? error.message : String(error) });
      },
    });

    controller.enqueue("task-1");
    controller.start();
    await waitFor(() => errors.length === 1);
    await waitFor(() => store.views.get("task-1")?.status.sessionId === "session-2");
    await controller.stop();

    expect(errors).toEqual([{ taskId: "task-1", message: "injected patch failure" }]);
    expect(runtime.spawnCalls).toHaveLength(2);
    expect(runtime.closeCalls.map((session) => session.id)).toEqual(["session-1"]);
    expect([...runtime.sessions.keys()]).toEqual(["session-2"]);
    expect(store.views.get("task-1")?.status.phase).toBe(AgentTaskPhase.Running);
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 500) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
