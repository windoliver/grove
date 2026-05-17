import type { FilterPlugin, FilterVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export class RuntimeCapabilityFilter implements FilterPlugin {
  readonly name = "RuntimeCapability";

  async filter(ctx: SchedulerContext, profile: RuntimeProfile): Promise<FilterVerdict> {
    const requestedRuntime = ctx.task.spec.runtime;
    if (
      typeof requestedRuntime === "string" &&
      requestedRuntime.length > 0 &&
      requestedRuntime !== profile.runtimeCommand
    ) {
      return {
        admit: false,
        reason: "runtime-mismatch",
        message: `task pins runtime '${requestedRuntime}' but profile runs '${profile.runtimeCommand}'`,
      };
    }

    if (
      profile.supportedRoles !== undefined &&
      !profile.supportedRoles.includes(ctx.task.spec.role)
    ) {
      return {
        admit: false,
        reason: "role-unsupported",
        message: `profile '${profile.name}' does not support role '${ctx.task.spec.role}'`,
      };
    }

    const requestedModel = readBudgetString(ctx.task.spec.budget, "model");
    const allowedModels = profile.budget?.allowedModels;
    if (
      requestedModel !== undefined &&
      allowedModels !== undefined &&
      !allowedModels.includes(requestedModel)
    ) {
      return {
        admit: false,
        reason: "model-not-allowed",
        message: `profile '${profile.name}' does not allow model '${requestedModel}'`,
      };
    }

    return { admit: true };
  }
}

function readBudgetString(budget: unknown, key: string): string | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const value = (budget as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
