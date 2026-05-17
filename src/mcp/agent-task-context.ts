export interface AgentTaskContext {
  readonly taskId: string;
  readonly generation: number;
}

export function readAgentTaskContext(
  env: Readonly<Record<string, string | undefined>>,
): AgentTaskContext | undefined {
  const taskId = env.GROVE_AGENT_TASK_ID;
  const gen = env.GROVE_AGENT_TASK_GENERATION;
  if (taskId === undefined || gen === undefined) return undefined;
  const generation = Number.parseInt(gen, 10);
  if (!Number.isFinite(generation)) return undefined;
  return { taskId, generation };
}
