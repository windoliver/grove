import { AcpxSupervisor } from "../core/acpx-supervisor.js";
import type { AgentRuntime } from "../core/agent-runtime.js";
import { selectRuntime } from "../core/select-runtime.js";
import type { AgentTaskStore, ClaimStore } from "../core/store.js";
import { TaskController } from "../core/task-controller.js";
import { TmuxRuntime } from "../core/tmux-runtime.js";
import { wireSupervisorToTasks } from "./acpx-supervisor-wiring.js";

export interface ServerAgentRuntimeDeps {
  readonly selectRuntime?: typeof selectRuntime;
  readonly createFallbackRuntime?: () => AgentRuntime;
}

export async function createServerAgentRuntime(
  deps: ServerAgentRuntimeDeps = {},
): Promise<AgentRuntime> {
  const picked = (deps.selectRuntime ?? selectRuntime)();
  if (await picked.isAvailable()) return picked;
  return (deps.createFallbackRuntime ?? (() => new TmuxRuntime()))();
}

export function taskControllerEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.GROVE_TASK_CONTROLLER !== "0";
}

// ---------------------------------------------------------------------------
// createTaskControllerWiring — constructs a TaskController and, when the
// runtime is an AcpxSupervisor, activates respawn→AgentTask wiring.
// ---------------------------------------------------------------------------

export interface TaskControllerWiringOptions {
  readonly taskStore: AgentTaskStore;
  readonly claimStore: ClaimStore;
  readonly runtime?: AgentRuntime | undefined;
  readonly workerCount?: number | undefined;
  readonly resyncIntervalMs?: number | undefined;
}

export interface TaskControllerWiring {
  readonly controller: TaskController;
  readonly runtime: AgentRuntime;
}

export function createTaskControllerWiring(
  options: TaskControllerWiringOptions,
): TaskControllerWiring {
  const runtime = options.runtime ?? selectRuntime();

  const controller = new TaskController({
    taskStore: options.taskStore,
    runtime,
    workerCount: options.workerCount,
    resyncIntervalMs: options.resyncIntervalMs,
  });

  if (runtime instanceof AcpxSupervisor) {
    wireSupervisorToTasks({
      supervisor: runtime,
      taskStore: options.taskStore,
      onDead: async (slotId): Promise<void> => {
        // TODO(#273): Claim↔task linkage not available — there is no Claim field
        // that directly stores the AgentTask id / slotId. Lease release is
        // deferred until the protocol establishes a stable binding (e.g. an
        // ownerRef on the claim pointing to the task). The task-failure patch
        // (phase=Failed) is applied by wireSupervisorToTasks; the stale lease
        // will expire naturally via the claim reconciliation controller.
        void slotId;
      },
    });
  }

  return { controller, runtime };
}
