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
        const active = await options.claimStore.listClaims({ status: "active" });
        for (const claim of active) {
          if (claim.context?.agentTaskId !== slotId) continue;
          try {
            await options.claimStore.release(claim.claimId);
          } catch (err) {
            // Isolate per-claim failures: one release error must not strand the
            // agent's other leases. The claim reconciler expires the rest.
            process.stderr.write(
              `[grove] supervisor onDead: failed to release claim ${claim.claimId}: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
        }
      },
    });
  }

  return { controller, runtime };
}
