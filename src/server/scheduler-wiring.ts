import type { AgentRuntime } from "../core/agent-runtime.js";
import type { GroveConfig } from "../core/config.js";
import { type LoadedSchedulerConfig, loadSchedulerConfig } from "../core/scheduler/config.js";
import { Scheduler } from "../core/scheduler/scheduler.js";
import type { AgentTaskStore } from "../core/store.js";

export interface SchedulerWiringDeps {
  readonly config: GroveConfig;
  readonly runtime: AgentRuntime;
  readonly store: Pick<AgentTaskStore, "listAgentTaskEntities">;
}

export function buildSchedulerFromConfig(deps: SchedulerWiringDeps): Scheduler | undefined {
  if (deps.config.scheduler === undefined) return undefined;
  const loaded: LoadedSchedulerConfig = loadSchedulerConfig(deps.config.scheduler, {
    runtime: deps.runtime,
  });
  return new Scheduler({
    profiles: loaded.profiles,
    filters: loaded.filters,
    scores: loaded.scores,
    permits: loaded.permits,
    bindPlugin: loaded.bindPlugin,
    store: deps.store,
  });
}
