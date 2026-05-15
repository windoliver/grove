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
