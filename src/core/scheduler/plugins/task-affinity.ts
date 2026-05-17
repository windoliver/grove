import type { SchedulerContext, ScorePlugin } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

const NEUTRAL_SCORE = 50;

export class TaskAffinityScore implements ScorePlugin {
  readonly name = "TaskAffinity";

  async score(ctx: SchedulerContext, profile: RuntimeProfile): Promise<number> {
    const requested = resolveRequestedLabels(ctx);
    const keys = Object.keys(requested);
    if (keys.length === 0) return NEUTRAL_SCORE;

    const labels = profile.labels ?? {};
    let matched = 0;
    for (const key of keys) {
      if (labels[key] === requested[key]) matched += 1;
    }
    return Math.round((100 * matched) / keys.length);
  }
}

function resolveRequestedLabels(ctx: SchedulerContext): Readonly<Record<string, string>> {
  const fromBudget = readAffinityFromBudget(ctx.task.spec.budget);
  if (fromBudget !== undefined && Object.keys(fromBudget).length > 0) return fromBudget;

  const runtime = ctx.task.spec.runtime;
  if (typeof runtime === "string" && runtime.length > 0) return { runtime };

  return {};
}

function readAffinityFromBudget(budget: unknown): Readonly<Record<string, string>> | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const value = (budget as { affinity?: unknown }).affinity;
  if (value === null || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
