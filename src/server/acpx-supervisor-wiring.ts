import type { AcpxRespawnEvent } from "../core/acpx-supervisor.js";
import { AgentTaskConditionType, AgentTaskPhase } from "../core/agent-task.js";
import type { AgentTaskStore } from "../core/store.js";
import { upsertCondition } from "../core/task-controller.js";

export interface SupervisorTaskWiringDeps {
  readonly supervisor: { onRespawn(cb: (e: AcpxRespawnEvent) => void): void };
  readonly taskStore: Pick<AgentTaskStore, "patchAgentTaskStatus" | "getAgentTask">;
  readonly now?: (() => number) | undefined;
  readonly onDead?: ((slotId: string) => Promise<void>) | undefined;
}

/**
 * Translate AcpxSupervisor respawn lifecycle events into AgentTask status
 * conditions. A transient blip surfaces as Resuming; a completed respawn marks
 * SessionLost while keeping the task Running; a permanent death fails the task
 * and triggers lease release via onDead. Slot id maps 1:1 to AgentTask id.
 */
export function wireSupervisorToTasks(deps: SupervisorTaskWiringDeps): void {
  const now = deps.now ?? Date.now;

  deps.supervisor.onRespawn((event) => {
    void handle(event).catch(() => {
      /* fire-and-forget; the task controller's resync is the backstop */
    });
  });

  async function handle(event: AcpxRespawnEvent): Promise<void> {
    const slotId = event.key.slotId;
    const task = await deps.taskStore.getAgentTask(slotId);
    if (!task) return;
    const gen = task.spec.generation;
    const ts = new Date(now()).toISOString();
    const conditions = task.status.conditions;

    if (event.kind === "resuming") {
      await deps.taskStore.patchAgentTaskStatus(slotId, {
        conditions: upsertCondition(conditions, {
          type: AgentTaskConditionType.Resuming,
          status: "True",
          observedGeneration: gen,
          lastTransitionTime: ts,
          reason: "acpx-disconnected",
          message: `respawn #${event.respawns + 1}`,
        }),
      });
      return;
    }

    if (event.kind === "resumed") {
      const withResumingCleared = upsertCondition(conditions, {
        type: AgentTaskConditionType.Resuming,
        status: "False",
        observedGeneration: gen,
        lastTransitionTime: ts,
        reason: "respawned",
        message: "",
      });
      await deps.taskStore.patchAgentTaskStatus(slotId, {
        sessionId: event.newSessionId,
        conditions: upsertCondition(withResumingCleared, {
          type: AgentTaskConditionType.SessionLost,
          status: "True",
          observedGeneration: gen,
          lastTransitionTime: ts,
          reason: "respawned",
          message: `new session ${event.newSessionId}`,
        }),
      });
      return;
    }

    // event.kind === "dead"
    const withRunningCleared = upsertCondition(conditions, {
      type: AgentTaskConditionType.Running,
      status: "False",
      observedGeneration: gen,
      lastTransitionTime: ts,
      reason: "session-lost",
      message: event.reason,
    });
    await deps.taskStore.patchAgentTaskStatus(slotId, {
      phase: AgentTaskPhase.Failed,
      lastTransitionAt: ts,
      conditions: upsertCondition(withRunningCleared, {
        type: AgentTaskConditionType.Failed,
        status: "True",
        observedGeneration: gen,
        lastTransitionTime: ts,
        reason: "session-lost",
        message: event.reason,
      }),
    });
    await deps.onDead?.(slotId);
  }
}
