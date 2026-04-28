/**
 * NexusWatchPublisher — publishes lightweight `entity.changed` envelopes to
 * the Nexus event-bus when entities are written through Nexus stores.
 *
 * The grove-server's NexusWatchSubscriber consumes these, dedupes against
 * the in-process onEntityWrite fast path, fetches the full entity, and
 * calls WatchHub.recordWrite. See spec §RV authority.
 */

import type { EventBus } from "../core/event-bus.js";
import type { WatchKind, WatchOp } from "../core/watch-events.js";

export const ENTITY_CHANGED = "entity.changed";

export interface EntityChangedEnvelope {
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly op: WatchOp;
  readonly entityId: string;
  readonly generation: number;
  readonly emittedAt: string;
}

export class NexusWatchPublisher {
  private readonly bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  async publish(envelope: EntityChangedEnvelope): Promise<void> {
    await this.bus.publish({
      type: ENTITY_CHANGED,
      sourceRole: "grove-store",
      targetRole: "*",
      payload: { ...envelope },
      timestamp: envelope.emittedAt,
    });
  }
}
