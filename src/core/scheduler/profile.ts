import type { AgentTaskView } from "../agent-task.js";
import type { AgentPlatformType } from "../topology.js";

export interface RuntimeProfileBudget {
  readonly maxCostUsd?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly allowedModels?: readonly string[] | undefined;
}

export interface RuntimeProfile {
  readonly name: string;
  readonly platform: AgentPlatformType | undefined;
  readonly runtimeCommand: string;
  readonly model?: string | undefined;
  readonly supportedRoles?: readonly string[] | undefined;
  readonly budget?: RuntimeProfileBudget | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

export function synthesizeFallbackProfile(task: AgentTaskView): RuntimeProfile {
  const runtime = task.spec.runtime;
  const model = readModelFromBudget(task.spec.budget);
  return {
    name: `fallback-${runtime}`,
    platform: runtimeToPlatform(runtime),
    runtimeCommand: runtime,
    ...(model === undefined ? {} : { model }),
  };
}

function runtimeToPlatform(runtime: string): AgentPlatformType | undefined {
  if (runtime === "claude" || runtime === "claude-code") return "claude-code";
  if (runtime === "codex") return "codex";
  if (runtime === "gemini") return "gemini";
  return undefined;
}

function readModelFromBudget(budget: unknown): string | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const model = (budget as { model?: unknown }).model;
  return typeof model === "string" ? model : undefined;
}
