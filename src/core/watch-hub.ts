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

interface KeyState {
  counter: bigint;
  ring: WatchEvent[];
  insertedAt: number[];
}

const DEFAULT_MAX_EVENTS = 1024;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_BOOKMARK_INTERVAL_MS = 30_000;
const DEFAULT_OUTBOX_CAP = 256;

export class WatchHub {
  private readonly state = new Map<string, KeyState>();
  private readonly maxEventsPerKey: number;
  private readonly maxAgeMsPerKey: number;
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
    const key = this.key(event.namespace, event.kind);
    const s = this.getOrCreate(key);
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
    const s = this.getOrCreate(key);

    const oldestRv = s.ring.length > 0 ? (s.ring[0] as WatchEvent).rv : 0n;
    // Resume from rv == oldestRv - 1 means "I have everything through oldestRv-1,
    // give me oldestRv onward." Anything strictly older is unrecoverable → 410.
    if (fromRv < oldestRv - 1n) {
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
      closed: false,
      overflow: false,
    };
    this.subscribersFor(key).add(subscriber);

    signal.addEventListener("abort", () => this.closeSubscriber(key, subscriber));

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

  private key(namespace: string, kind: WatchKind): string {
    return `${namespace}\x00${kind}`;
  }

  private getOrCreate(key: string): KeyState {
    let s = this.state.get(key);
    if (!s) {
      s = { counter: 0n, ring: [], insertedAt: [] };
      this.state.set(key, s);
    }
    return s;
  }

  private trim(s: KeyState): void {
    while (s.ring.length > this.maxEventsPerKey) {
      s.ring.shift();
      s.insertedAt.shift();
    }
    const cutoff = this.now() - this.maxAgeMsPerKey;
    while (s.ring.length > 0 && (s.insertedAt[0] ?? 0) < cutoff) {
      s.ring.shift();
      s.insertedAt.shift();
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
