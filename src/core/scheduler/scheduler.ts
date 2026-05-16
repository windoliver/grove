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

    const winner = await this.pickWinner(ctx, admitted.map((entry) => entry.profile));

    for (const plugin of this.permits) {
      const verdict = await plugin.permit(ctx, winner);
      if (verdict.status === "denied") {
        return {
          kind: "denied",
          plugin: plugin.name,
          reason: verdict.reason,
          message: verdict.message,
        };
      }
      if (verdict.status === "wait") {
        return {
          kind: "wait",
          plugin: plugin.name,
          reason: verdict.reason,
          message: verdict.message,
          profile: winner,
        };
      }
    }

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

  private async pickWinner(
    ctx: SchedulerContext,
    admitted: readonly RuntimeProfile[],
  ): Promise<RuntimeProfile> {
    if (admitted.length === 1) return admitted[0]!;

    const totals = new Map<string, number>();
    for (const profile of admitted) totals.set(profile.name, 0);

    for (const entry of this.scores) {
      const weight = entry.weight ?? 1;
      for (const profile of admitted) {
        const raw = await entry.plugin.score(ctx, profile);
        totals.set(profile.name, (totals.get(profile.name) ?? 0) + raw * weight);
      }
    }

    const orderIndex = (profile: RuntimeProfile): number =>
      ctx.profiles.findIndex((candidate) => candidate.name === profile.name);

    const ranked = [...admitted].sort((a, b) => {
      const diff = (totals.get(b.name) ?? 0) - (totals.get(a.name) ?? 0);
      if (diff !== 0) return diff;
      return orderIndex(a) - orderIndex(b);
    });
    return ranked[0]!;
  }
}

function normalizeScores(scores: readonly ScorePluginEntry[]): readonly ScorePluginEntry[] {
  return scores.map((entry) => ({
    plugin: entry.plugin,
    weight: entry.weight ?? 1,
  }));
}
