/**
 * NexusWatchPublisher — publishes lightweight `entity.changed` envelopes to
 * the Nexus event-bus when entities are written through Nexus stores.
 *
 * The grove-server's NexusWatchSubscriber consumes these, dedupes against
 * the in-process onEntityWrite fast path, fetches the full entity, and
 * calls WatchHub.recordWrite. See spec §RV authority.
 */

import type { EventBus } from "../core/event-bus.js";
import { getProcessInstanceId } from "../core/process-instance.js";
import type { WatchEntity, WatchKind, WatchOp } from "../core/watch-events.js";

export const ENTITY_CHANGED = "entity.changed";

export interface EntityChangedEnvelope {
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly op: WatchOp;
  readonly entityId: string;
  readonly generation: number;
  readonly emittedAt: string;
  /**
   * Stable per-process identifier of the writer. Subscribers running in the
   * same process drop envelopes whose `sourceInstanceId` matches their own —
   * that path is already covered by the in-process onEntityWrite fast path,
   * and accepting both would double-count the RV.
   */
  readonly sourceInstanceId: string;
  /**
   * Optional entity snapshot. Required on DELETED so the subscriber can
   * record the event without fetching a row that has already been removed
   * from the store. Producers MAY also include it for ADDED/MODIFIED to
   * skip the subscriber's hydration round-trip.
   */
  readonly entity?: WatchEntity;
}

export class NexusWatchPublisher {
  private readonly bus: EventBus;
  private readonly instanceId: string;

  constructor(bus: EventBus, instanceId?: string) {
    this.bus = bus;
    this.instanceId = instanceId ?? getProcessInstanceId();
  }

  async publish(envelope: Omit<EntityChangedEnvelope, "sourceInstanceId">): Promise<void> {
    const stamped: EntityChangedEnvelope = {
      ...envelope,
      sourceInstanceId: this.instanceId,
    };
    await this.bus.publish({
      type: ENTITY_CHANGED,
      sourceRole: "grove-store",
      targetRole: "*",
      payload: { ...stamped },
      timestamp: envelope.emittedAt,
    });
  }
}
