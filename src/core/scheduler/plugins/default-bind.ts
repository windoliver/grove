import { dirname } from "node:path";
import type { AgentConfig, AgentRuntime } from "../../agent-runtime.js";
import type { AgentTaskView } from "../../agent-task.js";
import { resolveMcpServePath } from "../../resolve-mcp-serve-path.js";
import type { BindPlugin, BindResult, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { buildPromptWithUpstream, type UpstreamSection } from "../upstream-prompt.js";

export interface DefaultBindPluginOptions {
  readonly runtime: Pick<AgentRuntime, "spawn">;
}

export class DefaultBindPlugin implements BindPlugin {
  readonly name = "DefaultBind";
  private readonly runtime: Pick<AgentRuntime, "spawn">;

  constructor(options: DefaultBindPluginOptions) {
    this.runtime = options.runtime;
  }

  async bind(ctx: SchedulerContext, profile: RuntimeProfile): Promise<BindResult> {
    const upstreamSections: UpstreamSection[] = [];
    for (const depId of ctx.task.spec.dependsOn) {
      const dep = await ctx.store.getAgentTask(depId);
      const succeeded = dep?.status.conditions.find(
        (c) => c.type === "Succeeded" && c.status === "True",
      );
      upstreamSections.push({ taskId: depId, summary: succeeded?.message ?? "" });
    }
    const wrappedPrompt = buildPromptWithUpstream(ctx.task.spec.prompt, upstreamSections);

    const model = profile.model ?? readBudgetString(ctx.task.spec.budget, "model");
    const groveMcp = buildGroveMcpServer(ctx.task);
    const config: AgentConfig = {
      role: ctx.task.spec.role,
      command: profile.runtimeCommand,
      cwd: ctx.task.spec.worktree,
      goal: ctx.task.spec.prompt,
      prompt: wrappedPrompt,
      ...(profile.platform === undefined ? {} : { platform: profile.platform }),
      ...(model === undefined ? {} : { model }),
      env: {
        GROVE_AGENT_TASK_ID: ctx.task.spec.id,
        GROVE_AGENT_TASK_GENERATION: String(ctx.task.spec.generation),
        GROVE_AGENT_TASK_RUNTIME: profile.runtimeCommand,
        ...(process.env.GROVE_SERVER_URL === undefined
          ? {}
          : { GROVE_SERVER_URL: process.env.GROVE_SERVER_URL }),
        ...(process.env.GROVE_API_TOKEN === undefined
          ? {}
          : { GROVE_API_TOKEN: process.env.GROVE_API_TOKEN }),
      },
      ...(groveMcp === undefined ? {} : { mcpServers: [groveMcp] }),
    };
    const session = await this.runtime.spawn(ctx.task.spec.role, config);
    return { session };
  }
}

function readBudgetString(budget: unknown, key: string): string | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const value = (budget as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function buildGroveMcpServer(
  task: AgentTaskView,
): NonNullable<AgentConfig["mcpServers"]>[number] | undefined {
  const groveDir = process.env.GROVE_DIR;
  if (groveDir === undefined) return undefined;
  const projectRoot = dirname(groveDir);
  const env: Record<string, string> = {
    GROVE_DIR: groveDir,
    GROVE_AGENT_ROLE: task.spec.role,
    GROVE_AGENT_TASK_ID: task.spec.id,
    GROVE_AGENT_TASK_GENERATION: String(task.spec.generation),
  };
  if (process.env.GROVE_SERVER_URL !== undefined)
    env.GROVE_SERVER_URL = process.env.GROVE_SERVER_URL;
  if (process.env.GROVE_API_TOKEN !== undefined) env.GROVE_API_TOKEN = process.env.GROVE_API_TOKEN;
  if (process.env.GROVE_NEXUS_URL !== undefined) env.GROVE_NEXUS_URL = process.env.GROVE_NEXUS_URL;
  if (process.env.NEXUS_API_KEY !== undefined) env.NEXUS_API_KEY = process.env.NEXUS_API_KEY;
  return {
    name: "grove",
    command: "bun",
    args: ["run", resolveMcpServePath(projectRoot)],
    env,
  };
}
