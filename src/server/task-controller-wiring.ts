import type { AgentRuntime } from "../core/agent-runtime.js";
import { selectRuntime } from "../core/select-runtime.js";
import { TmuxRuntime } from "../core/tmux-runtime.js";

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
