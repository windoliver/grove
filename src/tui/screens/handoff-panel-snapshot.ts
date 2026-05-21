import type { AgentTaskView } from "../../core/agent-task.js";
import type { Handoff } from "../../core/handoff.js";
import {
  type HandoffHealthSignal,
  healthSignalsFromAgentFailures,
  healthSignalsFromAgentTasks,
} from "../../core/handoff-operator-state.js";
import type { TuiDataProvider } from "../provider.js";
import { isHandoffProvider } from "../provider.js";

export interface HandoffPanelSnapshot {
  readonly handoffs: readonly Handoff[];
  readonly healthSignals: readonly HandoffHealthSignal[];
}

export interface HandoffPanelSnapshotOptions {
  readonly provider: TuiDataProvider;
  readonly sessionId?: string | undefined;
  readonly sessionStartedAt?: string | undefined;
  readonly agentFailures?: ReadonlyMap<string, string> | undefined;
}

export async function loadHandoffPanelSnapshot(
  options: HandoffPanelSnapshotOptions,
): Promise<HandoffPanelSnapshot> {
  if (!isHandoffProvider(options.provider)) {
    return {
      handoffs: [],
      healthSignals: healthSignalsFromAgentFailures(options.agentFailures),
    };
  }

  const [all, tasks] = await Promise.all([
    options.provider.getHandoffs({ limit: 200 }),
    loadAgentTasksForHandoffHealth(options.provider),
  ]);
  const cutoff =
    options.sessionStartedAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const scopedTasks =
    options.sessionId === undefined
      ? tasks
      : tasks.filter((task) => task.status.sessionId === options.sessionId);

  return {
    handoffs: all.filter((h) => h.createdAt >= cutoff),
    healthSignals: [
      ...healthSignalsFromAgentFailures(options.agentFailures),
      ...healthSignalsFromAgentTasks(scopedTasks),
    ],
  };
}

async function loadAgentTasksForHandoffHealth(
  provider: TuiDataProvider,
): Promise<readonly AgentTaskView[]> {
  if (provider.getAgentTasks === undefined) return [];
  try {
    return await provider.getAgentTasks();
  } catch {
    return [];
  }
}
