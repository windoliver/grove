/**
 * NexusWatchSubscriber — consumes `entity.changed` envelopes from the Nexus
 * event-bus, dedupes against in-process onEntityWrite fast-path writes,
 * fetches the full entity, and calls WatchHub.recordWrite (#292).
 *
 * The bus is role-based; the publisher emits with targetRole "*" and
 * type "entity.changed", so this subscriber listens on role "*" and
 * filters by event.type.
 */

import type { EventBus, EventHandler } from "../core/event-bus.js";
import type { EntityWriteEvent, WatchEntity, WatchKind, WatchOp } from "../core/watch-events.js";
import type { WatchHub } from "../core/watch-hub.js";
import { ENTITY_CHANGED, type EntityChangedEnvelope } from "./nexus-watch-publisher.js";

const SUBSCRIBE_ROLE = "*";
const DEFAULT_DEDUP_WINDOW_MS = 5_000;

export interface NexusWatchSubscriberOptions {
  readonly bus: EventBus;
  readonly hub: WatchHub;
  /** Fetch the full entity for an envelope — keeps the wire format minimal. */
  readonly fetchEntity: (kind: WatchKind, namespace: string, id: string) => Promise<WatchEntity>;
  /** Dedupe window for in-process fast-path replays. Default 5_000ms. */
  readonly dedupWindowMs?: number;
}

interface SeenKey {
  readonly key: string;
  readonly seenAt: number;
}

export class NexusWatchSubscriber {
  private readonly opts: NexusWatchSubscriberOptions;
  private readonly seen: SeenKey[] = [];
  private readonly handler: EventHandler = (event) => {
    if (event.type !== ENTITY_CHANGED) return;
    const env = event.payload as unknown as EntityChangedEnvelope;
    void this.onEnvelope(env);
  };
  private started = false;

  constructor(opts: NexusWatchSubscriberOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.opts.bus.subscribe(SUBSCRIBE_ROLE, this.handler);
  }

  stop(): void {
    if (!this.started) return;
    this.opts.bus.unsubscribe(SUBSCRIBE_ROLE, this.handler);
    this.started = false;
  }

  /**
   * Record that the in-process fast path already handled this write. The
   * subscriber will then ignore the matching cross-process envelope that
   * arrives shortly after via the Nexus event-bus.
   */
  markSeen(envelope: { kind: WatchKind; entityId: string; generation: number }): void {
    this.seen.push({
      key: this.dedupKey(envelope),
      seenAt: Date.now(),
    });
    this.expire();
  }

  private async onEnvelope(env: EntityChangedEnvelope): Promise<void> {
    if (!env || !env.kind || !env.namespace || !env.entityId) return;
    this.expire();
    const k = this.dedupKey(env);
    if (this.seen.some((s) => s.key === k)) return;

    let entity: WatchEntity;
    try {
      entity = await this.opts.fetchEntity(env.kind, env.namespace, env.entityId);
    } catch (err) {
      process.stderr.write(
        `[grove] NexusWatchSubscriber: fetchEntity failed for ${env.kind}/${env.entityId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return;
    }

    const e: EntityWriteEvent = {
      kind: env.kind,
      namespace: env.namespace,
      op: env.op as WatchOp,
      entity,
    };
    this.opts.hub.recordWrite(e);
  }

  private dedupKey(env: { kind: WatchKind; entityId: string; generation: number }): string {
    return `${env.kind}\x00${env.entityId}\x00${env.generation}`;
  }

  private expire(): void {
    const cutoff = Date.now() - (this.opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS);
    while (this.seen.length > 0 && (this.seen[0]?.seenAt ?? Infinity) < cutoff) {
      this.seen.shift();
    }
  }
}
