import { z } from "zod";
import type { AgentRuntime } from "../agent-runtime.js";
import type { BindPlugin, FilterPlugin, PermitPlugin, ScorePlugin } from "./framework.js";
import {
  BUILTIN_BIND_FACTORIES,
  BUILTIN_FILTER_FACTORIES,
  BUILTIN_PERMIT_FACTORIES,
  BUILTIN_SCORE_FACTORIES,
  builtinPluginNames,
  type BudgetLedger,
  type PermitDecisionStore,
} from "./plugins/index.js";
import type { RuntimeProfile } from "./profile.js";
import type { ScorePluginEntry } from "./scheduler.js";

const PlatformSchema = z.enum(["claude-code", "codex", "gemini", "custom"]);

const RuntimeProfileBudgetSchema = z
  .object({
    maxCostUsd: z.number().nonnegative().optional(),
    maxTurns: z.number().int().nonnegative().optional(),
    allowedModels: z.array(z.string().min(1)).optional(),
  })
  .strict();

const RuntimeProfileSchema = z
  .object({
    name: z.string().min(1).max(128),
    platform: PlatformSchema,
    runtimeCommand: z.string().min(1).max(128),
    model: z.string().min(1).max(128).optional(),
    supportedRoles: z.array(z.string().min(1).max(64)).optional(),
    budget: RuntimeProfileBudgetSchema.optional(),
    labels: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict();

const PipelineSchema = z
  .object({
    filters: z.array(z.string().min(1)).default([]),
    scores: z
      .array(
        z
          .object({
            name: z.string().min(1),
            weight: z.number().nonnegative().default(1),
          })
          .strict(),
      )
      .default([]),
    permits: z.array(z.string().min(1)).default(["AutoPermit"]),
    bind: z.string().min(1).default("DefaultBind"),
  })
  .strict();

export const SchedulerConfigSchema = z
  .object({
    profiles: z.array(RuntimeProfileSchema).default([]),
    pipeline: PipelineSchema.default({
      filters: [],
      scores: [],
      permits: ["AutoPermit"],
      bind: "DefaultBind",
    }),
  })
  .strict();

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

export interface LoadSchedulerConfigDeps {
  readonly runtime: AgentRuntime;
  readonly ledger?: BudgetLedger | undefined;
  readonly permitDecisionStore?: PermitDecisionStore | undefined;
}

export interface LoadedSchedulerConfig {
  readonly profiles: readonly RuntimeProfile[];
  readonly filters: readonly FilterPlugin[];
  readonly scores: readonly ScorePluginEntry[];
  readonly permits: readonly PermitPlugin[];
  readonly bindPlugin: BindPlugin;
}

export function loadSchedulerConfig(
  raw: unknown,
  deps: LoadSchedulerConfigDeps,
): LoadedSchedulerConfig {
  const config = SchedulerConfigSchema.parse(raw);

  const filters = config.pipeline.filters.map((name) => {
    const factory = BUILTIN_FILTER_FACTORIES[name];
    if (factory === undefined) throw unknownPluginError("filter", name);
    return factory(deps.ledger === undefined ? {} : { ledger: deps.ledger });
  });

  const scores: ScorePluginEntry[] = config.pipeline.scores.map((entry) => {
    const factory = BUILTIN_SCORE_FACTORIES[entry.name];
    if (factory === undefined) throw unknownPluginError("score", entry.name);
    return { plugin: factory({}), weight: entry.weight };
  });

  const permits = config.pipeline.permits.map((name) => {
    const factory = BUILTIN_PERMIT_FACTORIES[name];
    if (factory === undefined) throw unknownPluginError("permit", name);
    return factory(
      deps.permitDecisionStore === undefined
        ? {}
        : { permitDecisionStore: deps.permitDecisionStore },
    );
  });

  const bindFactory = BUILTIN_BIND_FACTORIES[config.pipeline.bind];
  if (bindFactory === undefined) throw unknownPluginError("bind", config.pipeline.bind);
  const bindPlugin = bindFactory({ runtime: deps.runtime });

  const profiles: readonly RuntimeProfile[] = config.profiles.map((profile) => ({
    name: profile.name,
    platform: profile.platform,
    runtimeCommand: profile.runtimeCommand,
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.supportedRoles === undefined ? {} : { supportedRoles: profile.supportedRoles }),
    ...(profile.budget === undefined ? {} : { budget: profile.budget }),
    ...(profile.labels === undefined ? {} : { labels: profile.labels }),
  }));

  return { profiles, filters, scores, permits, bindPlugin };
}

function unknownPluginError(kind: string, name: string): Error {
  const known = builtinPluginNames().sort().join(", ");
  return new Error(
    `unknown scheduler ${kind} plugin '${name}'. Known plugins: ${known}.`,
  );
}
