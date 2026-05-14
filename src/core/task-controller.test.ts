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
