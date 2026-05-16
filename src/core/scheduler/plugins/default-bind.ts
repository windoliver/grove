import type { AgentConfig, AgentRuntime } from "../../agent-runtime.js";
import type { BindPlugin, BindResult, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

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
    const model = profile.model ?? readBudgetString(ctx.task.spec.budget, "model");
    const config: AgentConfig = {
      role: ctx.task.spec.role,
      command: profile.runtimeCommand,
      cwd: ctx.task.spec.worktree,
      goal: ctx.task.spec.prompt,
      prompt: ctx.task.spec.prompt,
      ...(profile.platform === undefined ? {} : { platform: profile.platform }),
      ...(model === undefined ? {} : { model }),
      env: {
        GROVE_AGENT_TASK_ID: ctx.task.spec.id,
        GROVE_AGENT_TASK_GENERATION: String(ctx.task.spec.generation),
        GROVE_AGENT_TASK_RUNTIME: profile.runtimeCommand,
      },
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
