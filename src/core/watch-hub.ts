/**
 * WatchHub — per-(namespace, kind) monotonic resourceVersion counter and
 * ring buffer for the watch protocol (#292).
 * See docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md.
 */

import type { EntityWriteEvent, WatchEvent, WatchKind } from "./watch-events.js";

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
    return s.counter;
  }

  currentRv(namespace: string, kind: WatchKind): bigint {
    return this.state.get(this.key(namespace, kind))?.counter ?? 0n;
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
