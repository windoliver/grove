/**
 * WatchHub — per-(namespace, kind) monotonic resourceVersion counter and
 * ring buffer for the watch protocol (#292).
 * See docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md.
 */

import type { EntityWriteEvent, WatchEvent, WatchKind } from "./watch-events.js";
import { StaleResourceVersionError } from "./watch-events.js";

export interface WatchHubOptions {
  readonly maxEventsPerKey?: number;
  readonly maxAgeMsPerKey?: number;
  readonly bookmarkIntervalMs?: number;
  readonly perClientOutboxCap?: number;
  readonly now?: () => number;
}

export interface CompactionStats {
  readonly namespace: string;
  readonly kind: WatchKind;
  readonly evictedByAge: number;
  readonly evictedByCapacity: number;
  readonly currentRingSize: number;
  readonly oldestRv: string;
  readonly currentRv: string;
}

interface KeyState {
  readonly namespace: string;
  readonly kind: WatchKind;
  counter: bigint;
  ring: WatchEvent[];
  insertedAt: number[];
  /**
   * Highest rv that has been evicted (by age or capacity). Any client
   * resuming from `fromRv < floorRv` has missed at least one unrecoverable
   * event and must relist. Survives full ring eviction so age-compaction
   * of an idle key still triggers 410.
   */
  floorRv: bigint;
  evictedByAge: number;
  evictedByCapacity: number;
}

const DEFAULT_MAX_EVENTS = 1024;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_BOOKMARK_INTERVAL_MS = 30_000;
const DEFAULT_OUTBOX_CAP = 256;

export class WatchHub {
  private readonly state = new Map<string, KeyState>();
  readonly maxEventsPerKey: number;
  readonly maxAgeMsPerKey: number;
  readonly bookmarkIntervalMs: number;
  readonly perClientOutboxCap: number;
  private readonly now: () => number;

  constructor(opts: WatchHubOptions = {}) {
    this.maxEventsPerKey = opts.maxEventsPerKey ?? DEFAULT_MAX_EVENTS;
    this.maxAgeMsPerKey = opts.maxAgeMsPerKey ?? DEFAULT_MAX_AGE_MS;
    this.bookmarkIntervalMs = opts.bookmarkIntervalMs ?? DEFAULT_BOOKMARK_INTERVAL_MS;
    this.perClientOutboxCap = opts.perClientOutboxCap ?? DEFAULT_OUTBOX_CAP;
    this.now = opts.now ?? (() => Date.now());
  }

  recordWrite(event: EntityWriteEvent): bigint {
    const s = this.getOrCreate(event.namespace, event.kind);
    const key = this.key(event.namespace, event.kind);
    s.counter += 1n;
    const watchEvent: WatchEvent = { ...event, rv: s.counter };
    s.ring.push(watchEvent);
    s.insertedAt.push(this.now());
    this.trim(s);
    this.fanout(key, watchEvent);
    return s.counter;
  }

  currentRv(namespace: string, kind: WatchKind): bigint {
    return this.state.get(this.key(namespace, kind))?.counter ?? 0n;
  }

  subscribe(
    namespace: string,
    kind: WatchKind,
    fromRv: bigint,
    signal: AbortSignal,
  ): AsyncIterable<WatchEvent> {
    const key = this.key(namespace, kind);
    const s = this.getOrCreate(namespace, kind);

    // Apply age compaction at subscribe time. Without this, an idle
    // (namespace, kind) would keep events past maxAgeMs indefinitely and
    // a resuming client could be replayed events the retention contract
    // says are gone.
    this.trim(s);

    // floorRv is the highest evicted rv. Anything ≤ floorRv is unrecoverable;
    // resuming from fromRv == floorRv means "I have everything through
    // floorRv, give me floorRv+1 onward." Survives full ring eviction so
    // age-compaction of idle keys still triggers 410.
    if (fromRv < s.floorRv) {
      const oldestRv = s.ring.length > 0 ? (s.ring[0] as WatchEvent).rv : s.floorRv + 1n;
      throw new StaleResourceVersionError(namespace, kind, fromRv, oldestRv);
    }
    // Reject future RVs. After a server restart the hub resets to 0; a client
    // resuming from rv=100 must re-list rather than receive id=1 next and
    // silently violate watch-RV monotonicity.
    if (fromRv > s.counter) {
      throw new StaleResourceVersionError(namespace, kind, fromRv, s.counter);
    }

    const replay: WatchEvent[] = s.ring.filter((e) => e.rv > fromRv);

    const subscriber: Subscriber = {
      namespace,
      kind,
      queue: [...replay],
      pending: null,
      // Pre-aborted signals never fire their listener (AbortSignal does
      // not invoke retroactively), so a subscriber registered against an
      // already-aborted signal would be stuck in subscribersByKey forever
      // and continue to consume fan-out from every future write. Set
      // `closed` up front so the next() loop terminates immediately and
      // the subscriber is never registered on the live set.
      closed: signal.aborted,
      overflow: false,
    };
    if (!signal.aborted) {
      this.subscribersFor(key).add(subscriber);
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.closeSubscriber(key, subscriber);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (true) {
            // Drain already-queued events first; only signal overflow once
            // the consumer has caught up with what was successfully buffered.
            if (subscriber.queue.length > 0) {
              const value = subscriber.queue.shift() as WatchEvent;
              return { value, done: false };
            }
            if (subscriber.overflow) {
              this.closeSubscriber(key, subscriber);
              throw new BufferOverflowError(namespace, kind);
            }
            if (subscriber.closed) {
              return { value: undefined as unknown as WatchEvent, done: true };
            }
            await new Promise<void>((resolve) => {
              subscriber.pending = resolve;
            });
          }
        },
        return: async () => {
          this.closeSubscriber(key, subscriber);
          return { value: undefined as unknown as WatchEvent, done: true };
        },
      }),
    };
  }

  private subscribersByKey = new Map<string, Set<Subscriber>>();

  private subscribersFor(key: string): Set<Subscriber> {
    let set = this.subscribersByKey.get(key);
    if (!set) {
      set = new Set();
      this.subscribersByKey.set(key, set);
    }
    return set;
  }

  private fanout(key: string, event: WatchEvent): void {
    const set = this.subscribersByKey.get(key);
    if (!set) return;
    for (const sub of set) {
      if (sub.queue.length >= this.perClientOutboxCap) {
        sub.overflow = true;
      } else {
        sub.queue.push(event);
      }
      sub.pending?.();
      sub.pending = null;
    }
  }

  private closeSubscriber(key: string, sub: Subscriber): void {
    sub.closed = true;
    sub.pending?.();
    sub.pending = null;
    this.subscribersByKey.get(key)?.delete(sub);
  }

  /** Test-only inspector. Returns a copy. */
  snapshotRing(namespace: string, kind: WatchKind): readonly WatchEvent[] {
    const s = this.state.get(this.key(namespace, kind));
    return s ? [...s.ring] : [];
  }

  /** Snapshot of compaction counters across all (ns, kind) keys. */
  getCompactionStats(): readonly CompactionStats[] {
    const out: CompactionStats[] = [];
    for (const s of this.state.values()) {
      // Reflect age compaction in metrics even when no writes have arrived
      // since the events expired — otherwise the dashboard hides the fact
      // that the ring is now empty.
      this.trim(s);
      const oldestRv = s.ring.length > 0 ? (s.ring[0] as WatchEvent).rv : s.floorRv + 1n;
      out.push({
        namespace: s.namespace,
        kind: s.kind,
        evictedByAge: s.evictedByAge,
        evictedByCapacity: s.evictedByCapacity,
        currentRingSize: s.ring.length,
        oldestRv: String(oldestRv),
        currentRv: String(s.counter),
      });
    }
    return out;
  }

  private key(namespace: string, kind: WatchKind): string {
    return `${namespace}\x00${kind}`;
  }

  private getOrCreate(namespace: string, kind: WatchKind): KeyState {
    const key = this.key(namespace, kind);
    let s = this.state.get(key);
    if (!s) {
      s = {
        namespace,
        kind,
        counter: 0n,
        ring: [],
        insertedAt: [],
        floorRv: 0n,
        evictedByAge: 0,
        evictedByCapacity: 0,
      };
      this.state.set(key, s);
    }
    return s;
  }

  private trim(s: KeyState): void {
    while (s.ring.length > this.maxEventsPerKey) {
      const evicted = s.ring.shift() as WatchEvent;
      s.insertedAt.shift();
      if (evicted.rv > s.floorRv) s.floorRv = evicted.rv;
      s.evictedByCapacity += 1;
    }
    const cutoff = this.now() - this.maxAgeMsPerKey;
    while (s.ring.length > 0 && (s.insertedAt[0] ?? 0) < cutoff) {
      const evicted = s.ring.shift() as WatchEvent;
      s.insertedAt.shift();
      if (evicted.rv > s.floorRv) s.floorRv = evicted.rv;
      s.evictedByAge += 1;
    }
  }
}

interface Subscriber {
  readonly namespace: string;
  readonly kind: WatchKind;
  queue: WatchEvent[];
  pending: (() => void) | null;
  closed: boolean;
  overflow: boolean;
}

export class BufferOverflowError extends Error {
  readonly code = 503;
  readonly namespace: string;
  readonly kind: WatchKind;

  constructor(namespace: string, kind: WatchKind) {
    super(`watch outbox overflowed for ${namespace}/${kind}`);
    this.name = "BufferOverflowError";
    this.namespace = namespace;
    this.kind = kind;
  }
}
