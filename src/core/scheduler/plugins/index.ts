import type { AgentRuntime } from "../../agent-runtime.js";
import type { BindPlugin, FilterPlugin, PermitPlugin, ScorePlugin } from "../framework.js";
import { AutoPermit } from "./auto-permit.js";
import { BudgetRemainingFilter, type BudgetLedger } from "./budget-remaining.js";
import { DefaultBindPlugin } from "./default-bind.js";
import { RuntimeCapabilityFilter } from "./runtime-capability.js";
import { TaskAffinityScore } from "./task-affinity.js";
import {
  InMemoryPermitDecisionStore,
  type PermitDecisionStore,
  UserConfirmPermit,
} from "./user-confirm-permit.js";
import { WorktreeExclusivityFilter } from "./worktree-exclusivity.js";

export interface FilterFactoryArgs {
  readonly ledger?: BudgetLedger | undefined;
}

export interface ScoreFactoryArgs {
  readonly weight?: number | undefined;
}

export interface PermitFactoryArgs {
  readonly permitDecisionStore?: PermitDecisionStore | undefined;
}

export interface BindFactoryArgs {
  readonly runtime: AgentRuntime;
}

export const BUILTIN_FILTER_FACTORIES: Readonly<
  Record<string, (args: FilterFactoryArgs) => FilterPlugin>
> = Object.freeze({
  RuntimeCapability: () => new RuntimeCapabilityFilter(),
  BudgetRemaining: (args) =>
    new BudgetRemainingFilter(args.ledger === undefined ? {} : { ledger: args.ledger }),
  WorktreeExclusivity: () => new WorktreeExclusivityFilter(),
});

export const BUILTIN_SCORE_FACTORIES: Readonly<
  Record<string, (args: ScoreFactoryArgs) => ScorePlugin>
> = Object.freeze({
  TaskAffinity: () => new TaskAffinityScore(),
});

export const BUILTIN_PERMIT_FACTORIES: Readonly<
  Record<string, (args: PermitFactoryArgs) => PermitPlugin>
> = Object.freeze({
  AutoPermit: () => new AutoPermit(),
  UserConfirmPermit: (args) =>
    new UserConfirmPermit({ store: args.permitDecisionStore ?? new InMemoryPermitDecisionStore() }),
});

export const BUILTIN_BIND_FACTORIES: Readonly<
  Record<string, (args: BindFactoryArgs) => BindPlugin>
> = Object.freeze({
  DefaultBind: (args) => new DefaultBindPlugin({ runtime: args.runtime }),
});

export function builtinPluginNames(): readonly string[] {
  return [
    ...Object.keys(BUILTIN_FILTER_FACTORIES),
    ...Object.keys(BUILTIN_SCORE_FACTORIES),
    ...Object.keys(BUILTIN_PERMIT_FACTORIES),
    ...Object.keys(BUILTIN_BIND_FACTORIES),
  ];
}

export {
  AutoPermit,
  BudgetRemainingFilter,
  DefaultBindPlugin,
  InMemoryPermitDecisionStore,
  RuntimeCapabilityFilter,
  TaskAffinityScore,
  UserConfirmPermit,
  WorktreeExclusivityFilter,
};
export type { BudgetLedger, PermitDecisionStore };
