import type { AgentTaskView } from "../agent-task.js";
import type {
  BindPlugin,
  FilterPlugin,
  FilterRejection,
  PermitPlugin,
  ProfileRejection,
  SchedulerContext,
  SchedulingResult,
  ScorePlugin,
} from "./framework.js";
import type { RuntimeProfile } from "./profile.js";
import { synthesizeFallbackProfile } from "./profile.js";

export interface SchedulerOptions {
  readonly profiles: readonly RuntimeProfile[];
  readonly filters: readonly FilterPlugin[];
  readonly scores: readonly ScorePluginEntry[];
  readonly permits: readonly PermitPlugin[];
  readonly bindPlugin: BindPlugin;
  readonly store: SchedulerContext["store"];
  readonly now?: (() => number) | undefined;
}

export interface ScorePluginEntry {
  readonly plugin: ScorePlugin;
  readonly weight?: number | undefined;
}

export class Scheduler {
  private readonly profiles: readonly RuntimeProfile[];
  private readonly filters: readonly FilterPlugin[];
  private readonly scores: readonly ScorePluginEntry[];
  private readonly permits: readonly PermitPlugin[];
  private readonly bindPlugin: BindPlugin;
  private readonly store: SchedulerContext["store"];
  private readonly now: () => number;

  constructor(options: SchedulerOptions) {
    this.profiles = options.profiles;
    this.filters = options.filters;
    this.scores = normalizeScores(options.scores);
    this.permits = options.permits;
    this.bindPlugin = options.bindPlugin;
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  async schedule(task: AgentTaskView): Promise<SchedulingResult> {
    const profiles = this.profiles.length > 0 ? this.profiles : [synthesizeFallbackProfile(task)];
    const ctx: SchedulerContext = {
      task,
      profiles,
      store: this.store,
      now: this.now,
    };

    const filtered = await this.runFilters(ctx);
    const admitted = filtered.filter((entry) => entry.rejections.length === 0);
    if (admitted.length === 0) {
      return { kind: "unschedulable", rejections: filtered };
    }

    // Score/permit/bind are added in later tasks. For Task 4, take the first admitted profile.
    const winner = admitted[0]!.profile;
    const { session } = await this.bindPlugin.bind(ctx, winner);
    return { kind: "bound", profile: winner, session, reservationToken: undefined };
  }

  private async runFilters(ctx: SchedulerContext): Promise<readonly ProfileRejection[]> {
    return Promise.all(
      ctx.profiles.map(async (profile) => {
        const rejections: FilterRejection[] = [];
        for (const plugin of this.filters) {
          const verdict = await plugin.filter(ctx, profile);
          if (!verdict.admit) {
            rejections.push({
              plugin: plugin.name,
              reason: verdict.reason,
              message: verdict.message,
            });
          }
        }
        return { profile, rejections } satisfies ProfileRejection;
      }),
    );
  }
}

function normalizeScores(scores: readonly ScorePluginEntry[]): readonly ScorePluginEntry[] {
  return scores.map((entry) => ({
    plugin: entry.plugin,
    weight: entry.weight ?? 1,
  }));
}
