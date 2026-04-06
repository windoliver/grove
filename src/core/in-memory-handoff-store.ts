import { NotFoundError } from "./errors.js";
import {
  type Handoff,
  type HandoffInput,
  type HandoffQuery,
  HandoffStatus,
  type HandoffStore,
} from "./handoff.js";

function toHandoff(input: HandoffInput): Handoff {
  return {
    handoffId: input.handoffId ?? crypto.randomUUID(),
    sourceCid: input.sourceCid,
    fromRole: input.fromRole,
    toRole: input.toRole,
    status: HandoffStatus.PendingPickup,
    requiresReply: input.requiresReply ?? false,
    ...(input.replyDueAt !== undefined ? { replyDueAt: input.replyDueAt } : {}),
    createdAt: new Date().toISOString(),
  };
}

export class InMemoryHandoffStore implements HandoffStore {
  private readonly handoffs = new Map<string, Handoff>();

  async create(input: HandoffInput): Promise<Handoff> {
    const handoff = toHandoff(input);
    this.handoffs.set(handoff.handoffId, handoff);
    return handoff;
  }

  async get(id: string): Promise<Handoff | undefined> {
    return this.handoffs.get(id);
  }

  async list(query?: HandoffQuery): Promise<readonly Handoff[]> {
    let handoffs = [...this.handoffs.values()];

    if (query?.toRole !== undefined) {
      handoffs = handoffs.filter((handoff) => handoff.toRole === query.toRole);
    }
    if (query?.fromRole !== undefined) {
      handoffs = handoffs.filter((handoff) => handoff.fromRole === query.fromRole);
    }
    if (query?.sourceCid !== undefined) {
      handoffs = handoffs.filter((handoff) => handoff.sourceCid === query.sourceCid);
    }
    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      const allowed = new Set<HandoffStatus>(statuses);
      handoffs = handoffs.filter((handoff) => allowed.has(handoff.status));
    }
    if (query?.limit !== undefined) {
      handoffs = handoffs.slice(0, query.limit);
    }

    return handoffs;
  }

  async markDelivered(id: string): Promise<void> {
    const handoff = this.handoffs.get(id);
    if (handoff === undefined) {
      throw new NotFoundError({ resource: "Handoff", identifier: id });
    }
    this.handoffs.set(id, { ...handoff, status: HandoffStatus.Delivered });
  }

  async markReplied(id: string, resolvedByCid: string): Promise<void> {
    const handoff = this.handoffs.get(id);
    if (handoff === undefined) {
      throw new NotFoundError({ resource: "Handoff", identifier: id });
    }
    this.handoffs.set(id, {
      ...handoff,
      status: HandoffStatus.Replied,
      resolvedByCid,
    });
  }

  async expireStale(now?: string): Promise<readonly Handoff[]> {
    const cutoff = now ?? new Date().toISOString();
    const expired: Handoff[] = [];

    for (const [handoffId, handoff] of this.handoffs) {
      if (
        handoff.status === HandoffStatus.PendingPickup &&
        handoff.replyDueAt !== undefined &&
        handoff.replyDueAt < cutoff
      ) {
        const next = { ...handoff, status: HandoffStatus.Expired };
        this.handoffs.set(handoffId, next);
        expired.push(next);
      }
    }

    return expired;
  }

  async countPending(toRole: string): Promise<number> {
    let count = 0;
    for (const handoff of this.handoffs.values()) {
      if (handoff.toRole === toRole && handoff.status === HandoffStatus.PendingPickup) {
        count++;
      }
    }
    return count;
  }

  close(): void {
    /* no-op */
  }
}
