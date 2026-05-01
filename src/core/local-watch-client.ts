/**
 * LocalWatchClient — in-process WatchStream backend (#295).
 *
 * Reads a snapshot from `listFn` and subscribes to a process-local
 * WatchHub for deltas. Emits the same RELIST_BEGIN → RELIST* → RELIST_END
 * → live-delta sequence as the remote WatchClient so consumers (Informer)
 * can be backend-agnostic.
 *
 * Local mode (no Nexus) wires this against per-store snapshots; the stores
 * themselves call `hub.recordWrite` on each write. Remote mode keeps using
 * the HTTP-based WatchClient.
 */

import type { WatchClientEvent } from "./watch-client.js";
import type { WatchEntity, WatchKind } from "./watch-events.js";
import type { WatchHub } from "./watch-hub.js";
import type { WatchStream } from "./watch-stream.js";

export interface LocalWatchClientOptions {
  readonly hub: WatchHub;
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly listFn: () => readonly WatchEntity[];
}

export class LocalWatchClient implements WatchStream {
  private readonly hub: WatchHub;
  private readonly kind: WatchKind;
  private readonly namespace: string;
  private readonly listFn: () => readonly WatchEntity[];

  constructor(opts: LocalWatchClientOptions) {
    this.hub = opts.hub;
    this.kind = opts.kind;
    this.namespace = opts.namespace;
    this.listFn = opts.listFn;
  }

  async run(opts: {
    onEvent: (e: WatchClientEvent) => void | Promise<void>;
    signal: AbortSignal;
  }): Promise<void> {
    const { onEvent, signal } = opts;
    if (signal.aborted) return;

    // Capture the watch RV at the snapshot boundary, BEFORE listFn executes.
    // The hub's subscribe() will replay everything strictly after this RV,
    // so any write that happens after capture is delivered as a live delta.
    const snapshotRv = this.hub.currentRv(this.namespace, this.kind);

    // Subscribe BEFORE emitting RELIST events so we don't miss writes that
    // race the snapshot. The hub buffers events into the subscriber's queue
    // until the consumer iterates.
    const stream = this.hub.subscribe(this.namespace, this.kind, snapshotRv, signal);

    // Emit the snapshot.
    await onEvent({
      op: "RELIST_BEGIN",
      rv: snapshotRv,
      kind: this.kind,
      entity: null,
    });
    if (signal.aborted) return;

    for (const entity of this.listFn()) {
      await onEvent({
        op: "RELIST",
        rv: snapshotRv,
        kind: this.kind,
        entity,
      });
      if (signal.aborted) return;
    }

    await onEvent({
      op: "RELIST_END",
      rv: snapshotRv,
      kind: this.kind,
      entity: null,
    });
    if (signal.aborted) return;

    // Drain live deltas. The async iterator returns when the abort signal fires.
    try {
      for await (const event of stream) {
        if (signal.aborted) return;
        // Re-emit as WatchClientEvent — namespace is dropped (implicit in the subscription).
        await onEvent({
          op: event.op,
          rv: event.rv,
          kind: event.kind,
          entity: event.entity,
        });
      }
    } catch (err) {
      // Buffer overflow or other hub errors during live-delta iteration. Boundary
      // events are already emitted by this point, so the Informer won't see a
      // RELIST_ABORTED — just rethrow so the caller's run loop handles it.
      if (!signal.aborted) throw err;
    }
  }
}
