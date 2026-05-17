import type { FilterPlugin, FilterVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export class WorktreeExclusivityFilter implements FilterPlugin {
  readonly name = "WorktreeExclusivity";

  async filter(ctx: SchedulerContext, _profile: RuntimeProfile): Promise<FilterVerdict> {
    const entities = await ctx.store.listAgentTaskEntities();
    const worktree = ctx.task.spec.worktree;
    const selfId = ctx.task.spec.id;
    const conflict = entities.find(
      (entity) =>
        entity.id !== selfId &&
        entity.spec.worktree === worktree &&
        entity.status.phase === "Running",
    );
    if (conflict !== undefined) {
      return {
        admit: false,
        reason: "worktree-busy",
        message: `running task '${conflict.id}' holds worktree '${worktree}'`,
      };
    }
    return { admit: true };
  }
}
