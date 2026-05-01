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

import { isStaleVersion, type WatchClientEvent } from "./watch-client.js";
import type { WatchEntity, WatchKind } from "./watch-events.js";
import type { WatchHub } from "./watch-hub.js";
import type { WatchStream } from "./watch-stream.js";

export interface LocalWatchClientOptions {
  readonly hub: WatchHub;
  readonly kind: WatchKind;
  readonly namespace: string;
  /**
   * Snapshot source for the local store. Returns either a synchronous array
   * or a Promise resolving to one — the repo's real `ContributionStore` and
   * `ClaimStore` `listEntities()` methods are async, so the contract supports
   * both shapes. The promise (if any) is awaited inside `run()` before the
   * RELIST iteration so an async snapshot can't sneak a Promise into the
   * synchronous iteration loop.
   */
  readonly listFn: () => readonly WatchEntity[] | Promise<readonly WatchEntity[]>;
}

export class LocalWatchClient implements WatchStream {
  private readonly hub: WatchHub;
  private readonly kind: WatchKind;
  private readonly namespace: string;
  private readonly listFn: () => readonly WatchEntity[] | Promise<readonly WatchEntity[]>;

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
    // Cache the iterator so we can call return() on it during cleanup. Without
    // this, an exception thrown between RELIST_BEGIN and the for-await loop
    // would leave the hub subscriber alive (no abort, no iterator return),
    // accumulating fanout until buffer overflow.
    const iterator = stream[Symbol.asyncIterator]();
    const closeStream = async (): Promise<void> => {
      try {
        await iterator.return?.();
      } catch {
        /* iterator already closed */
      }
    };

    // Snapshot dedup window. A write committed after currentRv() but before
    // listFn() reads the store is included in BOTH the snapshot and the
    // subscription replay (rv > snapshotRv). Track {entity.id →
    // resourceVersion} during RELIST so an immediately-following live event
    // with the same (id, rv) tuple is suppressed instead of double-delivered,
    // mirroring WatchClient.snapshotWindow.
    const snapshotWindow = new Map<string, string>();

    // Boundary invariant: once RELIST_BEGIN fires, exactly one of RELIST_END
    // or RELIST_ABORTED follows. Track delivery so a snapshot-phase failure
    // (listFn throw, onEvent throw) emits RELIST_ABORTED before rethrowing
    // and the consumer can roll back staged state.
    let relistOpen = false;
    let primaryError: unknown;
    try {
      await onEvent({
        op: "RELIST_BEGIN",
        rv: snapshotRv,
        kind: this.kind,
        entity: null,
      });
      relistOpen = true;
      if (!signal.aborted) {
        // Resolve sync or async list — real stores expose Promise-based
        // listEntities(). Awaiting before iteration prevents Promise objects
        // leaking into the snapshot loop and short-circuiting RELIST_END.
        const list = await this.listFn();
        for (const entity of list) {
          if (signal.aborted) break;
          snapshotWindow.set(entity.id, entity.resourceVersion);
          await onEvent({
            op: "RELIST",
            rv: snapshotRv,
            kind: this.kind,
            entity,
          });
        }
      }
    } catch (err) {
      primaryError = err;
    }

    if (relistOpen) {
      const interrupted = primaryError !== undefined || signal.aborted;
      const closeOp = interrupted ? "RELIST_ABORTED" : "RELIST_END";
      try {
        await onEvent({
          op: closeOp,
          rv: snapshotRv,
          kind: this.kind,
          entity: null,
        });
      } catch (err) {
        if (closeOp === "RELIST_END" && primaryError === undefined && !signal.aborted) {
          primaryError = err;
        }
      }
    }

    if (primaryError !== undefined) {
      await closeStream();
      throw primaryError;
    }
    if (signal.aborted) {
      await closeStream();
      return;
    }

    // Drain live deltas. The async iterator returns when the abort signal fires.
    try {
      while (!signal.aborted) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value;
        if (signal.aborted) return;
        // Snapshot-dedup with high-water mark. Drop replay frames whose
        // entity version is ≤ the snapshot's version for that id; forward
        // strictly newer versions and DELETED. Treat the window as a
        // high-water mark — never delete on a stale match, since further
        // stale frames could still arrive in the same race window.
        const seenRv = snapshotWindow.get(event.entity.id);
        if (seenRv !== undefined) {
          if (event.op !== "DELETED" && isStaleVersion(event.entity.resourceVersion, seenRv)) {
            continue;
          }
          // Strictly newer real update or DELETED tombstone — clear the
          // entry so subsequent events for this entity bypass dedup.
          snapshotWindow.delete(event.entity.id);
        }
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
      // events were already emitted, so the Informer won't see a RELIST_ABORTED —
      // just rethrow so the caller's run loop handles it.
      if (!signal.aborted) throw err;
    } finally {
      await closeStream();
    }
  }
}
