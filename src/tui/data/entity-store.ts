/**
 * EntityStore<K> — reactive store layer over Informer<K> (B1 #296).
 *
 * Wraps a single Informer and adds a microtask-coalesced subscriber set,
 * a monotonic version counter, a write counter, a snapshot ref-cache,
 * and a per-kind grove_store_sse_lag ring. Data writes remain lossless
 * (Informer mutates its Map synchronously before fanning out events);
 * notifications coalesce to one per microtask so React's auto-batch can
 * commit at framework-paced cadence.
 *
 * EntityStore does not own the Informer's lifecycle. Stop/start/relist
 * are still driven by InformerFactory — EntityStore is a passive
 * subscriber that disposes its own subscriptions on `dispose()`.
 *
 * This task lands the minimal shape only — microtask coalescing,
 * snapshot ref-caching, writeCounter, and the lag ring come in later
 * tasks of the B1 plan.
 */

import type { Informer, InformerOp } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";

type EntityFor<K extends WatchKind> = ReturnType<Informer<K>["list"]>[number];

export class EntityStore<K extends WatchKind> {
  private readonly informer: Informer<K>;
  private readonly kind: K;
  private readonly subscribers = new Set<() => void>();
  private readonly unsubscribeFromInformer: Array<() => void> = [];
  private version = 0;
  private flushScheduled = false;

  constructor(informer: Informer<K>, kind: K) {
    this.informer = informer;
    this.kind = kind;
    this.unsubscribeFromInformer.push(
      informer.addEventHandler(this.onEvent),
      informer.addSyncHandler(this.onSync),
    );
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  getVersion(): number {
    return this.version;
  }

  list(): readonly EntityFor<K>[] {
    return this.informer.list() as readonly EntityFor<K>[];
  }

  getById(id: string): EntityFor<K> | undefined {
    return this.informer.getById(id) as EntityFor<K> | undefined;
  }

  hasSynced(): boolean {
    return this.informer.hasSynced();
  }

  dispose(): void {
    for (const u of this.unsubscribeFromInformer) {
      try {
        u();
      } catch {
        /* idempotent */
      }
    }
    this.unsubscribeFromInformer.length = 0;
    this.subscribers.clear();
  }

  private onEvent = (_op: InformerOp, _entity: EntityFor<K>): void => {
    this.bumpAndNotify();
  };

  private onSync = (): void => {
    this.bumpAndNotify();
  };

  private bumpAndNotify(): void {
    this.version += 1;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    // Snapshot before iterating so a subscriber that calls its own
    // unsubscribe (which mutates `subscribers`) doesn't skip the next
    // subscriber by shifting the iterator past it.
    for (const sub of [...this.subscribers]) {
      try {
        sub();
      } catch (err) {
        console.error(`EntityStore[${this.kind}]: subscriber threw, continuing fanout:`, err);
      }
    }
  }
}
