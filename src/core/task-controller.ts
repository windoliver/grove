import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import {
  AgentTaskConditionType,
  type AgentTaskEntity,
  AgentTaskPhase,
  type AgentTaskView,
} from "./agent-task.js";
import type { Condition } from "./entity.js";
import type { AgentTaskStatusPatch, AgentTaskStore } from "./store.js";
import { KeyedWorkQueue, QueueClosedError, type WorkItemResult } from "./workqueue.js";

export type TaskControllerStore = Pick<
  AgentTaskStore,
  "getAgentTask" | "patchAgentTaskStatus" | "listAgentTaskEntities"
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

interface ReconciliationResult {
  readonly patch: AgentTaskStatusPatch;
  readonly transition: AgentTaskStatusTransition;
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
    const model = task.spec.budget?.model;
    const config: AgentConfig = {
      role: task.spec.role,
      command: task.spec.runtime,
      cwd: task.spec.worktree,
      goal: task.spec.prompt,
      prompt: task.spec.prompt,
      platform: runtimeToPlatform(task.spec.runtime),
      ...(typeof model === "string" ? { model } : {}),
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
    for (const entity of entities) {
      this.enqueue(entity.id);
    }
    return entities.length;
  }

  async reconcileTask(taskId: string): Promise<AgentTaskStatusTransition | undefined> {
    const task = await this.taskStore.getAgentTask(taskId);
    if (task === undefined) return undefined;

    const result = await this.computeReconciliation(task);
    if (result === undefined) return undefined;

    await this.taskStore.patchAgentTaskStatus(taskId, result.patch);
    this.onTransition?.(result.transition);
    return result.transition;
  }

  start(): void {
    if (this.running) return;
    if (this.stopRequested) throw new QueueClosedError();
    this.running = true;
    this.stopRequested = false;
    for (let i = 0; i < this.workerCount; i += 1) {
      this.workers.push(this.workerLoop());
    }
    this.resyncTimer = setInterval(() => {
      void this.resync().catch((error: unknown) => {
        this.reportError(error, "__resync__");
      });
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

  private async computeReconciliation(
    task: AgentTaskView,
  ): Promise<ReconciliationResult | undefined> {
    if (isTerminal(task.status.phase)) {
      return terminalObservedGenerationCatchUp(task);
    }

    if (task.status.phase === AgentTaskPhase.Pending) {
      return this.reconcilePending(task);
    }

    if (task.status.phase === AgentTaskPhase.PendingBind) {
      return this.reconcilePendingBind(task);
    }

    if (task.status.phase === AgentTaskPhase.Running) {
      return this.reconcileRunning(task);
    }

    return undefined;
  }

  private async reconcilePending(task: AgentTaskView): Promise<ReconciliationResult> {
    const blockedOn = await this.blockingDependencies(task);
    const nowIso = this.nowIso();

    if (blockedOn.length > 0) {
      return {
        patch: {
          phase: AgentTaskPhase.Pending,
          observedGeneration: task.spec.generation,
          conditions: upsertCondition(task.status.conditions, {
            type: AgentTaskConditionType.Blocked,
            status: "True",
            observedGeneration: task.spec.generation,
            lastTransitionTime: nowIso,
            reason: "depends-on",
            message: `Waiting for ${blockedOn.join(", ")}`,
          }),
        },
        transition: transition(task, AgentTaskPhase.Pending, "depends-on"),
      };
    }

    return {
      patch: {
        phase: AgentTaskPhase.PendingBind,
        observedGeneration: task.spec.generation,
        conditions: upsertCondition(task.status.conditions, {
          type: AgentTaskConditionType.Scheduled,
          status: "True",
          observedGeneration: task.spec.generation,
          lastTransitionTime: nowIso,
          reason: "ready-to-bind",
          message: "",
        }),
        lastTransitionAt: nowIso,
      },
      transition: transition(task, AgentTaskPhase.PendingBind, "ready-to-bind"),
    };
  }

  private async reconcilePendingBind(
    task: AgentTaskView,
  ): Promise<ReconciliationResult | undefined> {
    if (task.status.sessionId !== undefined) {
      return this.reconcileRunning(task);
    }

    const { session } = await this.binder.bind({ task });
    const nowIso = this.nowIso();
    const conditions = upsertCondition(
      upsertCondition(task.status.conditions, {
        type: AgentTaskConditionType.Bound,
        status: "True",
        observedGeneration: task.spec.generation,
        lastTransitionTime: nowIso,
        reason: "session-bound",
        message: "",
      }),
      {
        type: AgentTaskConditionType.Running,
        status: "True",
        observedGeneration: task.spec.generation,
        lastTransitionTime: nowIso,
        reason: "session-running",
        message: "",
      },
    );

    return {
      patch: {
        phase: AgentTaskPhase.Running,
        sessionId: session.id,
        observedGeneration: task.spec.generation,
        conditions,
        lastTransitionAt: nowIso,
      },
      transition: transition(task, AgentTaskPhase.Running, "session-bound"),
    };
  }

  private async reconcileRunning(task: AgentTaskView): Promise<ReconciliationResult | undefined> {
    if (task.status.sessionId === undefined) {
      return failLostSession(task, this.nowIso());
    }

    const sessions = await this.runtime.listSessions();
    const session = sessions.find((candidate) => candidate.id === task.status.sessionId);
    if (session !== undefined && (session.status === "running" || session.status === "idle")) {
      return undefined;
    }

    return failLostSession(task, this.nowIso());
  }

  private async blockingDependencies(task: AgentTaskView): Promise<readonly string[]> {
    const blocked: string[] = [];
    for (const dependencyId of task.spec.dependsOn) {
      const dependency = await this.taskStore.getAgentTask(dependencyId);
      if (dependency?.status.phase !== AgentTaskPhase.Succeeded) {
        blocked.push(dependencyId);
      }
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

function terminalObservedGenerationCatchUp(task: AgentTaskView): ReconciliationResult | undefined {
  if (task.status.observedGeneration >= task.spec.generation) return undefined;
  return {
    patch: { observedGeneration: task.spec.generation },
    transition: transition(task, task.status.phase, "terminal-observed-generation"),
  };
}

function failLostSession(task: AgentTaskView, nowIso: string): ReconciliationResult {
  return {
    patch: {
      phase: AgentTaskPhase.Failed,
      observedGeneration: task.spec.generation,
      conditions: upsertCondition(task.status.conditions, {
        type: AgentTaskConditionType.Failed,
        status: "True",
        observedGeneration: task.spec.generation,
        lastTransitionTime: nowIso,
        reason: "session-lost",
        message: "",
      }),
      lastTransitionAt: nowIso,
    },
    transition: transition(task, AgentTaskPhase.Failed, "session-lost"),
  };
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
  if (runtime === "codex") return "codex";
  if (runtime === "gemini") return "gemini";
  return undefined;
}

function isTerminal(phase: AgentTaskPhase): boolean {
  return phase === AgentTaskPhase.Failed || phase === AgentTaskPhase.Succeeded;
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
  conditions: readonly Condition[],
  desired: Condition,
): readonly Condition[] {
  const index = conditions.findIndex((condition) => condition.type === desired.type);
  if (index === -1) {
    return [...conditions, desired];
  }

  const existing = conditions[index];
  if (existing === undefined) return conditions;
  const next: Condition =
    existing.status === desired.status &&
    existing.reason === desired.reason &&
    existing.message === desired.message
      ? {
          ...desired,
          lastTransitionTime: existing.lastTransitionTime,
        }
      : desired;

  if (conditionEqual(existing, next)) return conditions;

  return conditions.map((condition, conditionIndex) =>
    conditionIndex === index ? next : condition,
  );
}

function conditionEqual(left: Condition, right: Condition): boolean {
  return (
    left.type === right.type &&
    left.status === right.status &&
    left.observedGeneration === right.observedGeneration &&
    left.lastTransitionTime === right.lastTransitionTime &&
    left.reason === right.reason &&
    left.message === right.message
  );
}
