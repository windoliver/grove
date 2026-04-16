import { NotFoundError, StateConflictError } from "./errors.js";
import {
  type Handoff,
  type HandoffInput,
  type HandoffQuery,
  HandoffStatus,
  type HandoffStore,
  validateTransition,
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

  /**
   * InMemory is inherently session-scoped: one store instance per session,
   * so every handoff in the map belongs to the current session.
   */
  async listForCurrentSession(query?: HandoffQuery): Promise<readonly Handoff[]> {
    return this.list(query);
  }

  async isInCurrentSession(handoffId: string): Promise<boolean> {
    return this.handoffs.has(handoffId);
  }

  async markDelivered(id: string): Promise<void> {
    const handoff = this.handoffs.get(id);
    if (handoff === undefined) {
      throw new NotFoundError({ resource: "Handoff", identifier: id });
    }
    validateTransition(id, handoff.status, HandoffStatus.Delivered);
    this.handoffs.set(id, { ...handoff, status: HandoffStatus.Delivered });
  }

  async markReplied(id: string, resolvedByCid: string): Promise<void> {
    const handoff = this.handoffs.get(id);
    if (handoff === undefined) {
      throw new NotFoundError({ resource: "Handoff", identifier: id });
    }
    // Reject late replies in the store itself, so correctness does not
    // depend on the DeadlineWatcher having already flipped status.
    const now = new Date().toISOString();
    if (
      (handoff.status === HandoffStatus.PendingPickup ||
        handoff.status === HandoffStatus.Delivered) &&
      handoff.replyDueAt !== undefined &&
      handoff.replyDueAt < now
    ) {
      this.handoffs.set(id, { ...handoff, status: HandoffStatus.Expired });
      throw new StateConflictError({
        resource: "Handoff",
        reason: `Reply deadline passed at ${handoff.replyDueAt} (now ${now})`,
      });
    }
    validateTransition(id, handoff.status, HandoffStatus.Replied);
    this.handoffs.set(id, {
      ...handoff,
      status: HandoffStatus.Replied,
      resolvedByCid,
    });
  }

  async markSeen(id: string): Promise<void> {
    const handoff = this.handoffs.get(id);
    if (handoff === undefined) {
      throw new NotFoundError({ resource: "Handoff", identifier: id });
    }
    // No-op if already seen
    if (handoff.seenAt !== undefined) return;
    this.handoffs.set(id, { ...handoff, seenAt: new Date().toISOString() });
  }

  async markAcked(id: string): Promise<void> {
    const handoff = this.handoffs.get(id);
    if (handoff === undefined) {
      throw new NotFoundError({ resource: "Handoff", identifier: id });
    }
    // No-op if already acked
    if (handoff.ackedAt !== undefined) return;
    const now = new Date().toISOString();
    this.handoffs.set(id, {
      ...handoff,
      // Auto-fill seenAt if not already set
      ...(handoff.seenAt === undefined ? { seenAt: now } : {}),
      ackedAt: now,
    });
  }

  async expireStale(now?: string): Promise<readonly Handoff[]> {
    const cutoff = now ?? new Date().toISOString();
    const expired: Handoff[] = [];

    for (const [handoffId, handoff] of this.handoffs) {
      if (
        (handoff.status === HandoffStatus.PendingPickup ||
          handoff.status === HandoffStatus.Delivered) &&
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
