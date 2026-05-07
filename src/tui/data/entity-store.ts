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

import type { EntityForKind, Informer, InformerFactory, InformerOp } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";

export class EntityStore<K extends WatchKind> {
  private readonly informer: Informer<K>;
  private readonly kind: K;
  private readonly subscribers = new Set<() => void>();
  private readonly unsubscribeFromInformer: Array<() => void> = [];
  private version = 0;
  private writeCounter = 0;
  private flushScheduled = false;
  private snapshotCache: readonly EntityForKind<K>[] | null = null;
  private snapshotVersion = -1;
  private static readonly LAG_RING_SIZE = 1024;
  private readonly lagRing: number[] = [];

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

  list(): readonly EntityForKind<K>[] {
    if (this.snapshotCache !== null && this.snapshotVersion === this.version) {
      return this.snapshotCache;
    }
    this.snapshotCache = Object.freeze(
      Array.from(this.informer.list()) as EntityForKind<K>[],
    ) as readonly EntityForKind<K>[];
    this.snapshotVersion = this.version;
    return this.snapshotCache;
  }

  getById(id: string): EntityForKind<K> | undefined {
    return this.informer.getById(id) as EntityForKind<K> | undefined;
  }

  hasSynced(): boolean {
    return this.informer.hasSynced();
  }

  getStats(): {
    readonly writes: number;
    readonly version: number;
    readonly lagSamples: readonly number[];
  } {
    return {
      writes: this.writeCounter,
      version: this.version,
      lagSamples: [...this.lagRing],
    };
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

  private onEvent = (
    _op: InformerOp,
    _entity: EntityForKind<K>,
    meta?: { readonly emittedAt?: string },
  ): void => {
    this.writeCounter += 1;
    if (meta?.emittedAt !== undefined) {
      const t = Date.parse(meta.emittedAt);
      if (Number.isFinite(t)) {
        const lag = Date.now() - t;
        this.lagRing.push(lag);
        if (this.lagRing.length > EntityStore.LAG_RING_SIZE) {
          this.lagRing.shift();
        }
      }
    }
    this.bumpAndNotify();
  };

  private onSync = (): void => {
    this.bumpAndNotify();
  };

  private bumpAndNotify(): void {
    this.version += 1;
    this.snapshotCache = null;
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

export interface EntityStoreStats {
  readonly writes: number;
  readonly version: number;
  readonly lagSamples: readonly number[];
}

export class EntityStoreFactory {
  private readonly informerFactory: InformerFactory;
  private readonly stores = new Map<WatchKind, EntityStore<WatchKind>>();

  constructor(informerFactory: InformerFactory) {
    this.informerFactory = informerFactory;
  }

  get mode(): "remote" | "local" {
    return this.informerFactory.mode;
  }

  supportsKind(kind: WatchKind): boolean {
    return this.informerFactory.supportsKind(kind);
  }

  storeFor<K extends WatchKind>(kind: K): EntityStore<K> {
    const existing = this.stores.get(kind);
    if (existing) return existing as EntityStore<K>;
    const informer = this.informerFactory.informerFor(kind);
    const store = new EntityStore<K>(informer, kind);
    this.stores.set(kind, store as EntityStore<WatchKind>);
    return store;
  }

  getAllStats(): Record<string, EntityStoreStats> {
    const out: Record<string, EntityStoreStats> = {};
    for (const [kind, store] of this.stores) {
      out[kind] = store.getStats();
    }
    return out;
  }

  dispose(): void {
    for (const store of this.stores.values()) {
      try {
        store.dispose();
      } catch {
        /* idempotent */
      }
    }
    this.stores.clear();
  }
}
