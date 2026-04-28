/**
 * WatchHub — per-(namespace, kind) monotonic resourceVersion authority,
 * ring buffer, and subscriber fan-out for the watch protocol (#292).
 *
 * No HTTP, no I/O. Pure in-memory state. See
 * docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md.
 */

import type { EntityWriteEvent, WatchKind } from "./watch-events.js";

export class WatchHub {
  private readonly counters = new Map<string, bigint>();

  recordWrite(event: EntityWriteEvent): bigint {
    const key = `${event.namespace}\x00${event.kind}`;
    const next = (this.counters.get(key) ?? 0n) + 1n;
    this.counters.set(key, next);
    return next;
  }

  currentRv(namespace: string, kind: WatchKind): bigint {
    return this.counters.get(`${namespace}\x00${kind}`) ?? 0n;
  }
}
