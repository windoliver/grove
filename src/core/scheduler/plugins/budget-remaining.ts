import type { AgentTaskView } from "../../agent-task.js";
import type { FilterPlugin, FilterVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export interface BudgetLedger {
  hasRemaining(profile: RuntimeProfile, task: AgentTaskView): Promise<boolean>;
}

const PERMISSIVE_LEDGER: BudgetLedger = {
  hasRemaining: async () => true,
};

export interface BudgetRemainingFilterOptions {
  readonly ledger?: BudgetLedger | undefined;
}

export class BudgetRemainingFilter implements FilterPlugin {
  readonly name = "BudgetRemaining";
  private readonly ledger: BudgetLedger;

  constructor(options: BudgetRemainingFilterOptions = {}) {
    this.ledger = options.ledger ?? PERMISSIVE_LEDGER;
  }

  async filter(ctx: SchedulerContext, profile: RuntimeProfile): Promise<FilterVerdict> {
    const requestedCost = readBudgetNumber(ctx.task.spec.budget, "maxCostUsd");
    if (
      requestedCost !== undefined &&
      profile.budget?.maxCostUsd !== undefined &&
      requestedCost > profile.budget.maxCostUsd
    ) {
      return {
        admit: false,
        reason: "budget-exceeds-profile",
        message: `task wants $${requestedCost} but profile '${profile.name}' caps at $${profile.budget.maxCostUsd}`,
      };
    }

    const requestedTurns = ctx.task.spec.maxTurns;
    if (
      requestedTurns !== undefined &&
      profile.budget?.maxTurns !== undefined &&
      requestedTurns > profile.budget.maxTurns
    ) {
      return {
        admit: false,
        reason: "turns-exceeds-profile",
        message: `task wants ${requestedTurns} turns but profile '${profile.name}' caps at ${profile.budget.maxTurns}`,
      };
    }

    const hasRemaining = await this.ledger.hasRemaining(profile, ctx.task);
    if (!hasRemaining) {
      return {
        admit: false,
        reason: "ledger-exhausted",
        message: `ledger reports no remaining budget for profile '${profile.name}'`,
      };
    }

    return { admit: true };
  }
}

function readBudgetNumber(budget: unknown, key: string): number | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const value = (budget as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}
