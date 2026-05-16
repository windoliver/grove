import type { PermitPlugin, PermitVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export interface PermitDecision {
  readonly approved: boolean;
  readonly reason?: string | undefined;
}

export interface PermitDecisionLookup {
  readonly taskId: string;
  readonly profileName: string;
  readonly generation: number;
}

export interface PermitDecisionRecord extends PermitDecisionLookup, PermitDecision {}

export interface PermitDecisionStore {
  lookup(query: PermitDecisionLookup): Promise<PermitDecision | undefined>;
}

export class InMemoryPermitDecisionStore implements PermitDecisionStore {
  private readonly map = new Map<string, PermitDecision>();

  async record(record: PermitDecisionRecord): Promise<void> {
    const { approved } = record;
    const decision: PermitDecision = record.reason === undefined ? { approved } : { approved, reason: record.reason };
    this.map.set(keyOf(record), decision);
  }

  async lookup(query: PermitDecisionLookup): Promise<PermitDecision | undefined> {
    return this.map.get(keyOf(query));
  }
}

export interface UserConfirmPermitOptions {
  readonly store: PermitDecisionStore;
}

export class UserConfirmPermit implements PermitPlugin {
  readonly name = "UserConfirmPermit";
  private readonly store: PermitDecisionStore;

  constructor(options: UserConfirmPermitOptions) {
    this.store = options.store;
  }

  async permit(ctx: SchedulerContext, profile: RuntimeProfile): Promise<PermitVerdict> {
    const decision = await this.store.lookup({
      taskId: ctx.task.spec.id,
      profileName: profile.name,
      generation: ctx.task.spec.generation,
    });
    if (decision === undefined) {
      return {
        status: "wait",
        reason: "awaiting-user-confirmation",
        message: `no decision recorded for task '${ctx.task.spec.id}' / profile '${profile.name}' / generation ${ctx.task.spec.generation}`,
      };
    }
    if (decision.approved) return { status: "granted" };
    return decision.reason === undefined
      ? { status: "denied", reason: "user-denied" }
      : { status: "denied", reason: decision.reason };
  }
}

function keyOf(query: PermitDecisionLookup): string {
  return `${query.taskId}::${query.profileName}::${query.generation}`;
}
