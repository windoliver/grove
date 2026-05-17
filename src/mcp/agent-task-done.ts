import type { AgentTaskContext } from "./agent-task-context.js";

export interface SignalAgentTaskDoneOptions {
  readonly baseUrl: string | undefined;
  readonly token: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export async function signalAgentTaskDone(
  ctx: AgentTaskContext,
  summary: string,
  options: SignalAgentTaskDoneOptions,
): Promise<void> {
  if (options.baseUrl === undefined || options.baseUrl.length === 0) {
    throw new Error("GROVE_SERVER_URL not set; cannot signal AgentTask done");
  }
  if (options.token === undefined || options.token.length === 0) {
    throw new Error("GROVE_API_TOKEN not set; cannot signal AgentTask done");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const taskIdPath = encodeURIComponent(ctx.taskId);
  const url = `${options.baseUrl}/api/agent-tasks/${taskIdPath}/done`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({ summary }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /done returned ${res.status}: ${text}`);
  }
}
