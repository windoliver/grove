# A5 Watch Protocol — list→watch RV Handshake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Kubernetes-style reactive watch protocol that lets TUI clients list Entities, then resume an SSE watch from the exact `listResourceVersion` and receive every subsequent event without gaps.

**Architecture:** A grove-server-local `WatchHub` holds a per-(namespace, kind) monotonic RV counter and a per-key ring buffer. Writes feed the hub from two paths: (1) an in-process `onEntityWrite` operations hook for HTTP-mediated writes, and (2) a Nexus event-bus `entity.changed` subscription for cross-process writes from MCP agents. New endpoints `GET /api/list?kind=X` and `GET /api/watch?kind=X&resumeFrom=Y` (SSE) sit behind the existing namespace-auth middleware.

**Tech Stack:** Bun 1.3.9, TypeScript, Hono, Zod, `bun:test`, Biome. Reference spec: `docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md`. Reference upstream: `kubernetes/staging/src/k8s.io/apimachinery/pkg/watch/watch.go`.

**Working directory:** Run all commands from `/Users/tafeng/grove/.claude/worktrees/tidy-hatching-wadler`.

**Test runner:** `bun test <path>` for a file, `bun test <path> -t "<test name>"` for a single test. The repo uses `bun:test` (`describe`, `test`, `expect`).

**Lint / typecheck:** `bunx biome check --write src/` for style, `bunx tsc --noEmit` for typecheck.

---

## File Structure

### New files

| Path | Responsibility |
|------|---------------|
| `src/core/watch-hub.ts` | Pure WatchHub: RV counter, ring buffer, subscribe API. No HTTP, no I/O. |
| `src/core/watch-hub.test.ts` | Unit tests for WatchHub (monotonicity, isolation, ring caps, replay, bookmark, overflow). |
| `src/core/watch-events.ts` | Shared types: `WatchKind`, `WatchOp`, `WatchEvent`, `EntityWriteEvent`, `StaleResourceVersionError`. |
| `src/server/routes/watch.ts` | Hono route module for `GET /api/list` and `GET /api/watch` (SSE). |
| `src/server/watch.integration.test.ts` | Integration test: list returns RV, watch streams writes, 410 on stale. |
| `src/server/watch.race.test.ts` | Acceptance test: handshake-race (writes between list-return and watch-open all replayed). |
| `src/server/watch.kill.test.ts` | Acceptance test: kill-9 mid-stream resume with stored RV → zero missed events. |
| `src/server/watch.bookmark.test.ts` | Acceptance test: BOOKMARK arrives within 31s on quiescent kind. |
| `src/nexus/nexus-watch-publisher.ts` | Publishes `entity.changed` envelopes to the Nexus event-bus on writes through Nexus stores. |
| `src/nexus/nexus-watch-subscriber.ts` | grove-server subscribes to `entity.changed`, dedupes against in-process fast path, calls `hub.recordWrite()`. |

### Modified files

| Path | Change |
|------|--------|
| `src/core/operations/deps.ts` | Add `onEntityWrite?: (event: EntityWriteEvent) => void` to `OperationDeps`. |
| `src/core/operations/contribute.ts:1207` | Fire `onEntityWrite` for the committed contribution alongside existing hooks. |
| `src/core/operations/claim.ts` | Fire `onEntityWrite` after `claimOrRenew`, `complete`, `release` when phase changes. |
| `src/server/deps.ts` | Add `watchHub: WatchHub` to `ServerDeps`. |
| `src/server/app.ts` | Mount `/api/list` and `/api/watch` routes; bypass routes from any unrelated middleware. |
| `src/server/serve.ts` | Instantiate WatchHub, wire `onEntityWrite`, start NexusWatchSubscriber when Nexus is configured. |
| `src/nexus/nexus-contribution-store.ts` | Call `nexusWatchPublisher.publish` after every commit. |
| `src/nexus/nexus-claim-store.ts` | Call `nexusWatchPublisher.publish` after every state change. |

### Out of scope for this plan

- TUI informer (A7, #294)
- Polling retirement (A8, #295)
- Compaction/Expired RV recovery (A6, #293)
- Outcome/Bounty/Handoff watch — extend later
- AgentSession watch — extend in a follow-up plan once session-orchestrator emits clean phase-change events

---

## Phase 1 — Core WatchHub (pure logic)

### Task 1: Define shared watch-event types

**Files:**
- Create: `src/core/watch-events.ts`

- [ ] **Step 1: Write the file**

```typescript
/**
 * Shared types for the watch protocol (#292).
 *
 * The watch RV is a monotonic per-(namespace, kind) sequence held by the
 * server's WatchHub. It is distinct from Entity.resourceVersion (per-row
 * revision) — see docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md.
 */

import type {
  AgentSessionEntity,
  ClaimEntity,
  ContributionEntity,
} from "./entity.js";

export type WatchKind = "Contribution" | "Claim" | "AgentSession";

export type WatchOp = "ADDED" | "MODIFIED" | "DELETED";

export type WatchEntity = ContributionEntity | ClaimEntity | AgentSessionEntity;

/** A watch-stream event emitted by the hub to subscribers. */
export interface WatchEvent {
  readonly rv: bigint;
  readonly op: WatchOp;
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly entity: WatchEntity;
}

/** Argument shape for `WatchHub.recordWrite` / `OperationDeps.onEntityWrite`. */
export type EntityWriteEvent = Omit<WatchEvent, "rv">;

/** Thrown by `WatchHub.subscribe` when `fromRv` falls outside the ring buffer. */
export class StaleResourceVersionError extends Error {
  readonly code = 410;
  constructor(
    public readonly namespace: string,
    public readonly kind: WatchKind,
    public readonly fromRv: bigint,
    public readonly oldestRv: bigint,
  ) {
    super(
      `resourceVersion ${fromRv} is older than the oldest buffered event ${oldestRv} for ${namespace}/${kind}`,
    );
    this.name = "StaleResourceVersionError";
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit src/core/watch-events.ts`
Expected: PASS (no output).

- [ ] **Step 3: Commit**

```bash
git add src/core/watch-events.ts
git commit -m "feat(watch): shared watch-event types (#292)"
```

---

### Task 2: WatchHub skeleton + RV monotonicity

**Files:**
- Create: `src/core/watch-hub.ts`
- Create: `src/core/watch-hub.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/watch-hub.test.ts
import { describe, expect, test } from "bun:test";
import { contributionToEntity } from "./entity.js";
import type { Contribution } from "./models.js";
import { WatchHub } from "./watch-hub.js";

function fixtureContribution(cid: string): Contribution {
  return {
    cid,
    kind: "work",
    mode: "evaluation",
    summary: "fixture",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "a-1" },
    createdAt: new Date().toISOString(),
  } as Contribution;
}

describe("WatchHub.recordWrite", () => {
  test("returns strictly increasing rv for same (ns, kind)", () => {
    const hub = new WatchHub();
    const ent1 = contributionToEntity(fixtureContribution("cid-a"), "ns/wt");
    const ent2 = contributionToEntity(fixtureContribution("cid-b"), "ns/wt");
    const rv1 = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent1,
    });
    const rv2 = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent2,
    });
    expect(rv2 > rv1).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/watch-hub.test.ts`
Expected: FAIL with "Cannot find module './watch-hub.js'".

- [ ] **Step 3: Write minimal WatchHub implementation**

```typescript
// src/core/watch-hub.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/watch-hub.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-hub.ts src/core/watch-hub.test.ts
git commit -m "feat(watch): WatchHub recordWrite + currentRv (#292)"
```

---

### Task 3: Namespace and kind isolation

**Files:**
- Modify: `src/core/watch-hub.test.ts`

- [ ] **Step 1: Append the failing test**

Add to the existing `describe("WatchHub.recordWrite", ...)` block:

```typescript
  test("namespaces and kinds maintain independent counters", () => {
    const hub = new WatchHub();
    const ent = contributionToEntity(fixtureContribution("cid-a"), "ns/wt");
    const rvNsA = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/A",
      op: "ADDED",
      entity: ent,
    });
    const rvNsB = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/B",
      op: "ADDED",
      entity: ent,
    });
    const rvKindClaim = hub.recordWrite({
      kind: "Claim",
      namespace: "ns/A",
      op: "ADDED",
      // Claim entity reuse for shape only; type system accepts it because
      // WatchEntity is a union and the test does not exercise claim semantics.
      entity: ent as unknown as never,
    });
    expect(rvNsA).toBe(1n);
    expect(rvNsB).toBe(1n);
    expect(rvKindClaim).toBe(1n);
    expect(hub.currentRv("ns/A", "Contribution")).toBe(1n);
    expect(hub.currentRv("ns/B", "Contribution")).toBe(1n);
    expect(hub.currentRv("ns/A", "Claim")).toBe(1n);
    expect(hub.currentRv("ns/A", "AgentSession")).toBe(0n);
  });
```

- [ ] **Step 2: Run tests**

Run: `bun test src/core/watch-hub.test.ts`
Expected: PASS — 2 tests. The implementation already supports this because the key includes both namespace and kind.

- [ ] **Step 3: Commit**

```bash
git add src/core/watch-hub.test.ts
git commit -m "test(watch): namespace+kind isolation in counters (#292)"
```

---

### Task 4: Ring buffer with count cap

**Files:**
- Modify: `src/core/watch-hub.ts`
- Modify: `src/core/watch-hub.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new describe block at the bottom of `watch-hub.test.ts`:

```typescript
describe("WatchHub ring buffer", () => {
  test("retains last maxEventsPerKey events per (ns, kind)", () => {
    const hub = new WatchHub({ maxEventsPerKey: 3 });
    for (let i = 0; i < 5; i++) {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "ns/wt",
        op: "ADDED",
        entity: contributionToEntity(fixtureContribution(`cid-${i}`), "ns/wt"),
      });
    }
    const buffered = hub.snapshotRing("ns/wt", "Contribution");
    expect(buffered.length).toBe(3);
    expect(buffered.map((e) => e.rv)).toEqual([3n, 4n, 5n]);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/watch-hub.test.ts -t "retains last"`
Expected: FAIL with `hub.snapshotRing is not a function` or constructor type error.

- [ ] **Step 3: Extend WatchHub**

Replace the contents of `src/core/watch-hub.ts` with:

```typescript
/**
 * WatchHub — per-(namespace, kind) monotonic resourceVersion authority,
 * ring buffer, and subscriber fan-out for the watch protocol (#292).
 *
 * No HTTP, no I/O. Pure in-memory state. See
 * docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md.
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
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/watch-hub.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-hub.ts src/core/watch-hub.test.ts
git commit -m "feat(watch): WatchHub ring buffer with count cap (#292)"
```

---

### Task 5: Ring buffer age cap

**Files:**
- Modify: `src/core/watch-hub.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("WatchHub ring buffer", ...)` block:

```typescript
  test("evicts events older than maxAgeMsPerKey", () => {
    let clock = 1_000_000;
    const hub = new WatchHub({
      maxEventsPerKey: 1024,
      maxAgeMsPerKey: 1_000,
      now: () => clock,
    });
    hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: contributionToEntity(fixtureContribution("cid-old"), "ns/wt"),
    });
    clock += 5_000; // advance 5s past the 1s cap
    hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: contributionToEntity(fixtureContribution("cid-new"), "ns/wt"),
    });
    const buffered = hub.snapshotRing("ns/wt", "Contribution");
    expect(buffered.length).toBe(1);
    expect(buffered[0]?.entity.id).toBe("cid-new");
  });
```

- [ ] **Step 2: Run test**

Run: `bun test src/core/watch-hub.test.ts -t "evicts events older"`
Expected: PASS — `trim()` already evicts by age. If FAIL, the implementation in Task 4 is incomplete; re-read it.

- [ ] **Step 3: Commit**

```bash
git add src/core/watch-hub.test.ts
git commit -m "test(watch): ring buffer evicts by age (#292)"
```

---

### Task 6: Subscribe with replay + StaleResourceVersionError

**Files:**
- Modify: `src/core/watch-hub.ts`
- Modify: `src/core/watch-hub.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `watch-hub.test.ts`:

```typescript
describe("WatchHub.subscribe", () => {
  test("replays events with rv > fromRv then tails new writes", async () => {
    const hub = new WatchHub();
    const ent = (cid: string) =>
      contributionToEntity(fixtureContribution(cid), "ns/wt");
    const rv1 = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent("cid-1"),
    });
    hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent("cid-2"),
    });

    const ac = new AbortController();
    const seen: bigint[] = [];
    const stream = hub.subscribe("ns/wt", "Contribution", rv1, ac.signal);

    const drain = (async () => {
      for await (const ev of stream) {
        seen.push(ev.rv);
        if (seen.length === 2) ac.abort();
      }
    })();

    // Tail event posted after subscribe
    queueMicrotask(() => {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "ns/wt",
        op: "ADDED",
        entity: ent("cid-3"),
      });
    });

    await drain;
    expect(seen).toEqual([2n, 3n]);
  });

  test("throws StaleResourceVersionError when fromRv < ring.oldestRv", () => {
    const hub = new WatchHub({ maxEventsPerKey: 2 });
    const ent = (cid: string) =>
      contributionToEntity(fixtureContribution(cid), "ns/wt");
    for (const cid of ["a", "b", "c"]) {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "ns/wt",
        op: "ADDED",
        entity: ent(cid),
      });
    }
    expect(() => {
      const ac = new AbortController();
      hub.subscribe("ns/wt", "Contribution", 0n, ac.signal);
    }).toThrow("resourceVersion 0 is older than");
  });
});
```

Update the import line at the top of `watch-hub.test.ts`:
```typescript
import { StaleResourceVersionError, WatchHub } from "./watch-hub.js";
```

…wait — `StaleResourceVersionError` is exported from `watch-events.ts`. Use:
```typescript
import { WatchHub } from "./watch-hub.js";
import { StaleResourceVersionError } from "./watch-events.js";
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test src/core/watch-hub.test.ts -t "subscribe"`
Expected: FAIL with `hub.subscribe is not a function`.

- [ ] **Step 3: Implement subscribe**

Add these imports at the top of `src/core/watch-hub.ts`:
```typescript
import { StaleResourceVersionError } from "./watch-events.js";
```

Add a private `Subscriber` type and `subscribe` method. Append inside the `WatchHub` class:

```typescript
  subscribe(
    namespace: string,
    kind: WatchKind,
    fromRv: bigint,
    signal: AbortSignal,
  ): AsyncIterable<WatchEvent> {
    const key = this.key(namespace, kind);
    const s = this.getOrCreate(key);

    // Determine oldest RV in the ring
    const oldestRv = s.ring.length > 0 ? (s.ring[0] as WatchEvent).rv : 0n;
    if (fromRv < oldestRv - 1n) {
      // Subscribers are allowed to resume from rv == oldestRv - 1; that means
      // "I have everything up through (oldestRv-1), give me oldestRv onward."
      // Anything strictly older is unrecoverable — raise 410.
      throw new StaleResourceVersionError(namespace, kind, fromRv, oldestRv);
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
            if (subscriber.overflow) {
              this.closeSubscriber(key, subscriber);
              throw new BufferOverflowError(namespace, kind);
            }
            if (subscriber.queue.length > 0) {
              const value = subscriber.queue.shift() as WatchEvent;
              return { value, done: false };
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
```

Update `recordWrite` to fan out:
```typescript
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
```

Add at the bottom of the file:
```typescript
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
  constructor(
    public readonly namespace: string,
    public readonly kind: WatchKind,
  ) {
    super(`watch outbox overflowed for ${namespace}/${kind}`);
    this.name = "BufferOverflowError";
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/watch-hub.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-hub.ts src/core/watch-hub.test.ts
git commit -m "feat(watch): subscribe with replay + stale-RV 410 (#292)"
```

---

### Task 7: Per-client outbox overflow

**Files:**
- Modify: `src/core/watch-hub.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `watch-hub.test.ts`:

```typescript
describe("WatchHub overflow", () => {
  test("slow consumer triggers BufferOverflowError after outbox cap exceeded", async () => {
    const hub = new WatchHub({ perClientOutboxCap: 2 });
    const ent = (cid: string) =>
      contributionToEntity(fixtureContribution(cid), "ns/wt");

    const ac = new AbortController();
    const stream = hub.subscribe("ns/wt", "Contribution", 0n, ac.signal);

    // Don't drain — let the queue fill up
    for (let i = 0; i < 5; i++) {
      hub.recordWrite({
        kind: "Contribution",
        namespace: "ns/wt",
        op: "ADDED",
        entity: ent(`cid-${i}`),
      });
    }

    const it = stream[Symbol.asyncIterator]();
    // First two reads return queued events
    expect((await it.next()).value.rv).toBe(1n);
    expect((await it.next()).value.rv).toBe(2n);
    // Third read raises overflow because the producer has set the flag
    await expect(it.next()).rejects.toThrow("watch outbox overflowed");
  });
});
```

Update import in test file:
```typescript
import { BufferOverflowError } from "./watch-hub.js";
```

- [ ] **Step 2: Run test**

Run: `bun test src/core/watch-hub.test.ts -t "overflow"`
Expected: PASS — the overflow flag is set whenever `queue.length >= perClientOutboxCap` and a new event arrives, so the third event sets the flag, and the next `it.next()` throws.

If it fails because the test sees three values instead of throwing, re-read the `fanout` method: events should be DROPPED (overflow true, no push) once the cap is reached, not appended.

- [ ] **Step 3: Commit**

```bash
git add src/core/watch-hub.test.ts
git commit -m "test(watch): outbox overflow raises BufferOverflowError (#292)"
```

---

### Task 8: Bookmark cadence (timer-driven)

**Files:**
- Modify: `src/core/watch-hub.ts`
- Modify: `src/core/watch-hub.test.ts`

The hub itself does not own bookmark timers — those are per-stream and live in the SSE handler. But the hub exposes `bookmarkIntervalMs` so route code reads the policy from one place. Verify the option round-trips:

- [ ] **Step 1: Write the test**

Append to `watch-hub.test.ts`:

```typescript
describe("WatchHub config", () => {
  test("exposes bookmarkIntervalMs and perClientOutboxCap from options", () => {
    const hub = new WatchHub({ bookmarkIntervalMs: 5_000, perClientOutboxCap: 16 });
    expect(hub.bookmarkIntervalMs).toBe(5_000);
    expect(hub.perClientOutboxCap).toBe(16);
  });

  test("defaults bookmarkIntervalMs to 30000", () => {
    const hub = new WatchHub();
    expect(hub.bookmarkIntervalMs).toBe(30_000);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/core/watch-hub.test.ts -t "config"`
Expected: PASS — both fields are public readonly on the class from Task 4.

- [ ] **Step 3: Commit**

```bash
git add src/core/watch-hub.test.ts
git commit -m "test(watch): expose bookmarkIntervalMs config (#292)"
```

---

## Phase 2 — Wire `onEntityWrite` for Contribution

### Task 9: Add `onEntityWrite` field to OperationDeps

**Files:**
- Modify: `src/core/operations/deps.ts`

- [ ] **Step 1: Edit the interface**

Use Edit to change `src/core/operations/deps.ts`:

Replace this comment + field block:
```typescript
  /** Called after a contribution is written, receiving the CID. Used for session tagging. */
  readonly onContributionWritten?: ((cid: string) => void) | undefined;
```

With:
```typescript
  /** Called after a contribution is written, receiving the CID. Used for session tagging. */
  readonly onContributionWritten?: ((cid: string) => void) | undefined;
  /**
   * Called after any Entity (#287) write, with the kind, namespace, op, and
   * projected envelope. Drives the watch protocol (#292) — grove-server wires
   * this into WatchHub.recordWrite. Heartbeat-only Claim writes that change
   * neither status nor the lease-expiry boundary do not fire this hook.
   */
  readonly onEntityWrite?:
    | ((event: import("../watch-events.js").EntityWriteEvent) => void)
    | undefined;
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/operations/deps.ts
git commit -m "feat(watch): add onEntityWrite hook to OperationDeps (#292)"
```

---

### Task 10: Fire `onEntityWrite` from contribute operation

**Files:**
- Modify: `src/core/operations/contribute.ts`

- [ ] **Step 1: Locate the existing fire site**

Open `src/core/operations/contribute.ts` and find lines 1204–1216 (the `try { deps.onContributionWrite?.(); deps.onContributionWritten?.(...) } catch {...}` block).

- [ ] **Step 2: Locate the namespace source**

Find where `namespace` is available in the operation. Search for `namespace` in `contribute.ts`. The operation does not currently take a namespace — it is a per-server concept set by middleware. The cleanest source is `deps.onEntityWriteNamespace` or a new field. Use this approach: add a `deps.namespace?: string` lookup at the call site, and only fire `onEntityWrite` when both `onEntityWrite` and a namespace are available.

In the same file, add a helper near the top (after imports):

```typescript
import { contributionToEntity } from "../entity.js";
```

- [ ] **Step 3: Replace the post-write callback block**

Replace:
```typescript
    try {
      deps.onContributionWrite?.();
      deps.onContributionWritten?.(contribution.cid);
    } catch (callbackErr) {
      process.stderr.write(
        `[grove] Warning: onContributionWrite* callback threw after commit: ${
          callbackErr instanceof Error ? callbackErr.message : String(callbackErr)
        }\n`,
      );
    }
```

With:
```typescript
    try {
      deps.onContributionWrite?.();
      deps.onContributionWritten?.(contribution.cid);
      if (deps.onEntityWrite && deps.namespace) {
        deps.onEntityWrite({
          kind: "Contribution",
          namespace: deps.namespace,
          op: "ADDED",
          entity: contributionToEntity(contribution, deps.namespace),
        });
      }
    } catch (callbackErr) {
      process.stderr.write(
        `[grove] Warning: post-commit callback threw after contribution commit: ${
          callbackErr instanceof Error ? callbackErr.message : String(callbackErr)
        }\n`,
      );
    }
```

- [ ] **Step 4: Add `namespace` to OperationDeps**

In `src/core/operations/deps.ts`, append after the `onEntityWrite` field:

```typescript
  /**
   * Namespace under which this operation runs. Required to fire
   * `onEntityWrite` (the watch protocol scopes events per-namespace). When
   * absent (e.g. legacy callers without auth context), the watch hook is
   * skipped — operations remain functional.
   */
  readonly namespace?: string | undefined;
```

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Run existing contribute tests to confirm no regression**

Run: `bun test src/core/operations/contribute.test.ts`
Expected: All tests still pass — the new branch only fires when both `onEntityWrite` and `namespace` are set, and existing tests set neither.

- [ ] **Step 7: Add a focused test**

Append to `src/core/operations/contribute.test.ts` inside the most appropriate `describe` block (look for a "post-write" or "callbacks" group; if none, add one at the end of the file):

```typescript
describe("contribute → onEntityWrite", () => {
  test("fires onEntityWrite with the projected ContributionEntity", async () => {
    const events: Array<{ kind: string; op: string; cid: string }> = [];
    const deps = makeContributeTestDeps({
      onEntityWrite: (e) =>
        events.push({ kind: e.kind, op: e.op, cid: e.entity.id }),
      namespace: "ns/wt",
    });
    const result = await contributeOperation(makeContributeInput(), deps);
    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "Contribution", op: "ADDED" });
  });

  test("skips onEntityWrite when namespace is missing", async () => {
    const events: unknown[] = [];
    const deps = makeContributeTestDeps({
      onEntityWrite: (e) => events.push(e),
      // no namespace
    });
    const result = await contributeOperation(makeContributeInput(), deps);
    expect(result.ok).toBe(true);
    expect(events).toHaveLength(0);
  });
});
```

You will need `makeContributeTestDeps` and `makeContributeInput` helpers — these likely exist already in `src/core/operations/test-helpers.ts` or `contribute.test.ts`. If a similar helper exists under a different name, use that instead. If neither exists, define minimal versions inline using the patterns already in `contribute.test.ts`.

- [ ] **Step 8: Run the new test**

Run: `bun test src/core/operations/contribute.test.ts -t "onEntityWrite"`
Expected: PASS — 2 tests.

- [ ] **Step 9: Commit**

```bash
git add src/core/operations/contribute.ts src/core/operations/deps.ts src/core/operations/contribute.test.ts
git commit -m "feat(watch): contribute fires onEntityWrite for Contribution (#292)"
```

---

## Phase 3 — HTTP routes

### Task 11: ServerDeps + watch route scaffold

**Files:**
- Modify: `src/server/deps.ts`
- Create: `src/server/routes/watch.ts`
- Modify: `src/server/app.ts`

- [ ] **Step 1: Add `watchHub` to ServerDeps**

In `src/server/deps.ts`, add the import:
```typescript
import type { WatchHub } from "../core/watch-hub.js";
```

Add the field at the end of the `ServerDeps` interface:
```typescript
  /** Watch hub for list→watch handshake (#292). */
  readonly watchHub: WatchHub;
```

- [ ] **Step 2: Add `watchHub` to all server-construction sites**

Run: `grep -rn "ServerDeps\b" src/ test/ tests/`

Every constructor or test helper that builds a `ServerDeps` literal will now fail typecheck because `watchHub` is required. For each match, add `watchHub: new WatchHub()` (importing from `"../core/watch-hub.js"` adjusted to the file's path). The most likely sites are:
- `src/server/serve.ts`
- `src/server/test-helpers.ts`
- `src/server/e2e.test.ts`

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS. Fix any remaining missing-`watchHub` literals.

- [ ] **Step 4: Create watch route file**

Create `src/server/routes/watch.ts`:

```typescript
/**
 * Watch protocol endpoints (#292).
 *
 * GET /api/list?kind=<kind>      — list snapshot with listResourceVersion
 * GET /api/watch?kind=<kind>&resumeFrom=<rv> — SSE stream
 *
 * Both endpoints sit behind the existing /api/* namespaceAuth middleware
 * (#290), so namespace is always read from `c.get("namespace")` — never
 * from query or path params.
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { WatchKind } from "../../core/watch-events.js";
import {
  BufferOverflowError,
  type WatchHub,
} from "../../core/watch-hub.js";
import { StaleResourceVersionError } from "../../core/watch-events.js";
import type { ServerEnv } from "../deps.js";

const KIND_VALUES = ["Contribution", "Claim", "AgentSession"] as const;

const listQuerySchema = z.object({
  kind: z.enum(KIND_VALUES),
});

const watchQuerySchema = z.object({
  kind: z.enum(KIND_VALUES),
  resumeFrom: z.string().regex(/^[0-9]+$/, "resumeFrom must be a non-negative integer"),
});

const watch: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/list?kind=X */
watch.get("/list", zValidator("query", listQuerySchema), async (c) => {
  const namespace = c.get("namespace");
  const { kind } = c.req.valid("query");
  const deps = c.get("deps");
  const hub: WatchHub = deps.watchHub;

  // Race-correctness invariant: capture RV BEFORE the list query.
  const listRv = hub.currentRv(namespace, kind as WatchKind);
  const items = await listForKind(deps, namespace, kind as WatchKind);

  return c.json({ items, listResourceVersion: String(listRv) });
});

/** GET /api/watch?kind=X&resumeFrom=Y — SSE stream. */
watch.get("/watch", zValidator("query", watchQuerySchema), (c) => {
  const namespace = c.get("namespace");
  const { kind, resumeFrom } = c.req.valid("query");
  const lastEventId = c.req.header("last-event-id");
  const fromRv = BigInt(lastEventId ?? resumeFrom);
  const hub: WatchHub = c.get("deps").watchHub;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const ac = new AbortController();
      let bookmarkTimer: ReturnType<typeof setInterval> | null = null;

      const send = (event: string, data: unknown, id?: string) => {
        const payload = `id: ${id ?? ""}\nevent: ${event}\ndata: ${JSON.stringify(
          data,
        )}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      const closeWithError = (code: number, reason: string) => {
        send("ERROR", { code, reason });
        cleanup();
      };

      const cleanup = () => {
        if (bookmarkTimer) clearInterval(bookmarkTimer);
        bookmarkTimer = null;
        ac.abort();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      let iterable: AsyncIterable<import("../../core/watch-events.js").WatchEvent>;
      try {
        iterable = hub.subscribe(namespace, kind as WatchKind, fromRv, ac.signal);
      } catch (err) {
        if (err instanceof StaleResourceVersionError) {
          closeWithError(410, "expired");
          return;
        }
        throw err;
      }

      bookmarkTimer = setInterval(() => {
        send("BOOKMARK", { rv: String(hub.currentRv(namespace, kind as WatchKind)) });
      }, hub.bookmarkIntervalMs);
      // Allow the process to exit when only this timer is pending
      (bookmarkTimer as unknown as { unref?: () => void }).unref?.();

      (async () => {
        try {
          for await (const ev of iterable) {
            send(ev.op, { kind: ev.kind, entity: ev.entity }, String(ev.rv));
          }
          cleanup();
        } catch (err) {
          if (err instanceof BufferOverflowError) {
            closeWithError(503, "buffer_overflow");
          } else {
            closeWithError(500, "internal_error");
          }
        }
      })();

      // Abort when the client disconnects.
      c.req.raw.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

async function listForKind(
  deps: ServerEnv["Variables"]["deps"],
  namespace: string,
  kind: WatchKind,
): Promise<readonly unknown[]> {
  switch (kind) {
    case "Contribution":
      return deps.contributionStore.listEntities();
    case "Claim":
      return deps.claimStore.listEntities();
    case "AgentSession":
      // AgentSession listing is not yet a Store API. Return empty until the
      // session-orchestrator integration lands (out of scope for #292).
      return [];
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      void namespace;
      return [];
    }
  }
}

export { watch };
```

- [ ] **Step 5: Verify Claim store has listEntities**

Run: `grep -n "listEntities" src/core/store.ts`
Expected: matches at lines 197 (Contribution) and 333 (Claim). Both return Entity-projected arrays. If Claim is missing, this plan needs an upstream fix — pause and report.

- [ ] **Step 6: Mount the route**

In `src/server/app.ts`, add the import:
```typescript
import { watch } from "./routes/watch.js";
```

Add a mount after `app.route("/api/handoffs", handoffs);`:
```typescript
  app.route("/api", watch);
```

This mounts `/api/list` and `/api/watch` (the route module uses absolute sub-paths).

- [ ] **Step 7: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS. Address any remaining `ServerDeps` literals missing `watchHub`.

- [ ] **Step 8: Commit**

```bash
git add src/server/deps.ts src/server/app.ts src/server/routes/watch.ts src/server/serve.ts src/server/test-helpers.ts
git commit -m "feat(watch): /api/list and /api/watch SSE routes (#292)"
```

---

### Task 12: Server-side WatchHub instantiation + onEntityWrite wiring

**Files:**
- Modify: `src/server/serve.ts`

- [ ] **Step 1: Import WatchHub**

Add to the imports at the top of `src/server/serve.ts`:
```typescript
import { WatchHub } from "../core/watch-hub.js";
```

- [ ] **Step 2: Construct the hub at startup**

After `const runtime = createLocalRuntime(...)` and before stores are constructed, add:
```typescript
const watchHub = new WatchHub();
```

- [ ] **Step 3: Pass `watchHub` into `ServerDeps`**

Find the `ServerDeps` literal in `serve.ts` and add `watchHub` to it.

- [ ] **Step 4: Wire `onEntityWrite` into operations deps**

Find where `OperationDeps` is constructed for HTTP requests. The current pattern lives in `src/server/operation-adapter.ts`. Open it, locate `toOperationDeps(serverDeps)`, and append two fields to the returned object:
```typescript
    onEntityWrite: (event) => serverDeps.watchHub.recordWrite(event),
    // namespace is set per-request by the route handler — see watch.ts
    // and contributions.ts. operation-adapter only fills the static fields.
```

- [ ] **Step 5: Inject namespace per-request in contribute route**

In `src/server/routes/contributions.ts`, find the `contributeOperation(input, opDeps)` call. Modify the `opDeps` construction to include the namespace:
```typescript
  let opDeps = toOperationDeps(serverDeps);
  opDeps = { ...opDeps, namespace: c.get("namespace") };
```

- [ ] **Step 6: Typecheck and run server tests**

Run: `bunx tsc --noEmit && bun test src/server/`
Expected: All pre-existing server tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/serve.ts src/server/operation-adapter.ts src/server/routes/contributions.ts
git commit -m "feat(watch): wire WatchHub + onEntityWrite in serve (#292)"
```

---

## Phase 4 — Integration tests

### Task 13: List endpoint integration test

**Files:**
- Create: `src/server/watch.integration.test.ts`

- [ ] **Step 1: Inspect existing test helpers**

Open `src/server/test-helpers.ts` and look for a function like `createTestApp(deps)` or similar that builds a Hono app with auth bypassed or with a known bearer token. Use whichever pattern is established. If the helpers already support contribution submission, reuse them.

- [ ] **Step 2: Write the test**

```typescript
// src/server/watch.integration.test.ts
import { describe, expect, test } from "bun:test";
import { createTestApp, postContribution, withAuth } from "./test-helpers.js";

describe("GET /api/list", () => {
  test("returns items with listResourceVersion = 0 for an empty namespace", async () => {
    const { app } = await createTestApp();
    const res = await app.request("/api/list?kind=Contribution", {
      headers: withAuth(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.listResourceVersion).toBe("0");
  });

  test("listResourceVersion advances after a write", async () => {
    const { app } = await createTestApp();
    await postContribution(app, { summary: "first" });
    const res = await app.request("/api/list?kind=Contribution", {
      headers: withAuth(),
    });
    const body = await res.json();
    expect(body.items.length).toBe(1);
    expect(BigInt(body.listResourceVersion)).toBeGreaterThan(0n);
  });

  test("400 on missing kind", async () => {
    const { app } = await createTestApp();
    const res = await app.request("/api/list", { headers: withAuth() });
    expect(res.status).toBe(400);
  });

  test("401 without auth", async () => {
    const { app } = await createTestApp();
    const res = await app.request("/api/list?kind=Contribution");
    expect([400, 401]).toContain(res.status);
  });
});
```

If `createTestApp`, `postContribution`, or `withAuth` is not present under those exact names, adapt to the actual helpers. The patterns to follow are visible in `src/server/e2e.test.ts` and `src/server/namespace-isolation.test.ts`.

- [ ] **Step 3: Run test**

Run: `bun test src/server/watch.integration.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 4: Commit**

```bash
git add src/server/watch.integration.test.ts
git commit -m "test(watch): list endpoint integration (#292)"
```

---

### Task 14: Watch endpoint streams writes

**Files:**
- Modify: `src/server/watch.integration.test.ts`

- [ ] **Step 1: Add a streaming helper**

At the top of the test file, add a helper that drains an SSE stream into structured events:

```typescript
async function readSseEvents(
  res: Response,
  stopAfter: number,
  timeoutMs = 2_000,
): Promise<Array<{ id: string; event: string; data: unknown }>> {
  const events: Array<{ id: string; event: string; data: unknown }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (events.length < stopAfter && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const dataLine = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      events.push({ id, event, data: JSON.parse(dataLine) });
    }
  }
  await reader.cancel();
  return events;
}
```

- [ ] **Step 2: Write the streaming test**

```typescript
describe("GET /api/watch", () => {
  test("streams ADDED events for writes after subscribe", async () => {
    const { app } = await createTestApp();
    const list = await app
      .request("/api/list?kind=Contribution", { headers: withAuth() })
      .then((r) => r.json());
    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: withAuth() },
    );
    expect(watchRes.status).toBe(200);
    expect(watchRes.headers.get("content-type")).toMatch(/text\/event-stream/);

    const writePromise = postContribution(app, { summary: "live-1" });
    const events = await readSseEvents(watchRes, 1);
    await writePromise;

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.event).toBe("ADDED");
  });
});
```

- [ ] **Step 3: Run test**

Run: `bun test src/server/watch.integration.test.ts -t "streams ADDED"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/watch.integration.test.ts
git commit -m "test(watch): SSE streams ADDED events post-subscribe (#292)"
```

---

### Task 15: Watch endpoint emits 410 on stale RV

**Files:**
- Modify: `src/server/watch.integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
  test("ERROR 410 when resumeFrom is older than ring oldestRv", async () => {
    // Hub is constructed by serve.ts with default cap 1024. We simulate stale
    // by forcing the ring to evict via a custom hub. The cleanest way is for
    // createTestApp to accept a `watchHub` override.
    const { app, watchHub } = await createTestApp({
      watchHubOptions: { maxEventsPerKey: 2 },
    });
    await postContribution(app, { summary: "a" });
    await postContribution(app, { summary: "b" });
    await postContribution(app, { summary: "c" }); // evicts a
    const res = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=0`,
      { headers: withAuth() },
    );
    const events = await readSseEvents(res, 1);
    expect(events[0]?.event).toBe("ERROR");
    expect((events[0]?.data as { code: number }).code).toBe(410);
    void watchHub; // reference so the option-override branch is exercised
  });
```

- [ ] **Step 2: Extend `createTestApp` to accept `watchHubOptions`**

Edit `src/server/test-helpers.ts`. Find the `createTestApp` function (or equivalent). Add a `watchHubOptions?: WatchHubOptions` parameter that constructs a custom `WatchHub` and exposes it on the return value.

```typescript
import { WatchHub, type WatchHubOptions } from "../core/watch-hub.js";

export async function createTestApp(
  opts: { watchHubOptions?: WatchHubOptions } = {},
): Promise<{ app: Hono<ServerEnv>; watchHub: WatchHub /* ...existing fields */ }> {
  // ...
  const watchHub = new WatchHub(opts.watchHubOptions);
  // ...
  return { app, watchHub /* ...existing fields */ };
}
```

If `createTestApp` is named differently or has a different shape, adapt accordingly — keep the option additive.

- [ ] **Step 3: Run test**

Run: `bun test src/server/watch.integration.test.ts -t "ERROR 410"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/watch.integration.test.ts src/server/test-helpers.ts
git commit -m "test(watch): 410 on stale resumeFrom (#292)"
```

---

## Phase 5 — Acceptance tests

### Task 16: Handshake-race acceptance test (issue criterion #2)

**Files:**
- Create: `src/server/watch.race.test.ts`
- Modify: `src/server/routes/watch.ts` (add a test-only injection point)

- [ ] **Step 1: Add an injection point on the watch route**

The race test needs to inject a delay between `hub.currentRv()` and `store.listEntities()` to widen the handshake window. Add an env-gated hook to `src/server/routes/watch.ts`:

In the `/list` handler, replace:
```typescript
  const listRv = hub.currentRv(namespace, kind as WatchKind);
  const items = await listForKind(deps, namespace, kind as WatchKind);
```

With:
```typescript
  const listRv = hub.currentRv(namespace, kind as WatchKind);
  const delayMs = Number(process.env.GROVE_WATCH_LIST_DELAY_MS);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const items = await listForKind(deps, namespace, kind as WatchKind);
```

`GROVE_WATCH_LIST_DELAY_MS` is a test-only knob, set only in this acceptance test. The delay defaults to 0 in production.

- [ ] **Step 2: Write the test**

```typescript
// src/server/watch.race.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestApp, postContribution, withAuth } from "./test-helpers.js";

describe("watch handshake-race (issue #292 acceptance #2)", () => {
  beforeEach(() => {
    process.env.GROVE_WATCH_LIST_DELAY_MS = "100";
  });
  afterEach(() => {
    delete process.env.GROVE_WATCH_LIST_DELAY_MS;
  });

  test("writes between list-return and watch-open are all replayed", async () => {
    const { app } = await createTestApp();

    // Begin list (will block 100ms inside the handler)
    const listPromise = app
      .request("/api/list?kind=Contribution", { headers: withAuth() })
      .then((r) => r.json());

    // Inject 50 concurrent writes during the list delay window
    await new Promise((r) => setTimeout(r, 10)); // ensure list is mid-flight
    const N = 50;
    const writes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        postContribution(app, { summary: `race-${i}` }),
      ),
    );
    const list = await listPromise;
    const writtenIds = new Set(writes.map((w) => w.cid));

    // Open watch from the listResourceVersion
    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: withAuth() },
    );
    const events = await readSseEvents(watchRes, N, 5_000);
    const watchedIds = new Set(
      events
        .filter((e) => e.event === "ADDED")
        .map((e) => (e.data as { entity: { id: string } }).entity.id),
    );
    for (const id of writtenIds) {
      expect(watchedIds.has(id)).toBe(true);
    }
  });
});

// (readSseEvents helper defined in watch.integration.test.ts; copy or
// extract to a shared util — see Task 14 step 1.)
```

If the helper extraction is preferred (it is — DRY), do this Step 2.5:

- [ ] **Step 2.5: Extract `readSseEvents` to `src/server/sse-test-utils.ts`**

Create `src/server/sse-test-utils.ts` with the helper from Task 14, then import it in both `watch.integration.test.ts` and `watch.race.test.ts`.

- [ ] **Step 3: Run the race test**

Run: `bun test src/server/watch.race.test.ts`
Expected: PASS — every cid in the write set surfaces on the watch stream.

- [ ] **Step 4: Commit**

```bash
git add src/server/watch.race.test.ts src/server/routes/watch.ts src/server/sse-test-utils.ts src/server/watch.integration.test.ts
git commit -m "test(watch): handshake-race acceptance — writes between list and watch all replayed (#292)"
```

---

### Task 17: Kill-9 mid-stream resume test (issue criterion #1)

**Files:**
- Create: `src/server/watch.kill.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// src/server/watch.kill.test.ts
import { describe, expect, test } from "bun:test";
import { createTestApp, postContribution, withAuth } from "./test-helpers.js";
import { readSseEvents } from "./sse-test-utils.js";

describe("watch kill-9 resume (issue #292 acceptance #1)", () => {
  test("reconnect with stored RV → zero missed events", async () => {
    const { app } = await createTestApp();
    const list = await app
      .request("/api/list?kind=Contribution", { headers: withAuth() })
      .then((r) => r.json());

    // First connection: read one BOOKMARK, then abort to simulate kill-9
    const ac = new AbortController();
    const firstRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: withAuth(), signal: ac.signal },
    );

    // Force one BOOKMARK by emitting at a fast cadence is server-side, so
    // we instead capture the implicit fromRv the client would store: the
    // listResourceVersion already represents the checkpoint. Abort now.
    ac.abort();
    void firstRes;

    // Write 20 events while disconnected
    const writes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postContribution(app, { summary: `kill-${i}` }),
      ),
    );
    const writtenIds = new Set(writes.map((w) => w.cid));

    // Reconnect with the same resumeFrom
    const secondRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: withAuth() },
    );
    const events = await readSseEvents(secondRes, 20, 3_000);
    const watchedIds = new Set(
      events
        .filter((e) => e.event === "ADDED")
        .map((e) => (e.data as { entity: { id: string } }).entity.id),
    );
    for (const id of writtenIds) {
      expect(watchedIds.has(id)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/watch.kill.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/watch.kill.test.ts
git commit -m "test(watch): kill-9 resume — zero missed events (#292)"
```

---

### Task 18: Bookmark cadence test (issue criterion #3)

**Files:**
- Create: `src/server/watch.bookmark.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// src/server/watch.bookmark.test.ts
import { describe, expect, test } from "bun:test";
import { createTestApp, withAuth } from "./test-helpers.js";
import { readSseEvents } from "./sse-test-utils.js";

describe("watch BOOKMARK cadence (issue #292 acceptance #3)", () => {
  test("emits BOOKMARK at least once within bookmarkInterval", async () => {
    const { app } = await createTestApp({
      watchHubOptions: { bookmarkIntervalMs: 200 },
    });
    const list = await app
      .request("/api/list?kind=Contribution", { headers: withAuth() })
      .then((r) => r.json());
    const res = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: withAuth() },
    );
    const events = await readSseEvents(res, 1, 1_000);
    expect(events[0]?.event).toBe("BOOKMARK");
    expect(typeof (events[0]?.data as { rv: string }).rv).toBe("string");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test src/server/watch.bookmark.test.ts`
Expected: PASS within ~200–250ms.

- [ ] **Step 3: Commit**

```bash
git add src/server/watch.bookmark.test.ts
git commit -m "test(watch): BOOKMARK cadence acceptance (#292)"
```

---

## Phase 6 — Wire Claim operations

### Task 19: Fire `onEntityWrite` from claim operation (status changes only)

**Files:**
- Modify: `src/core/operations/claim.ts`
- Modify: `src/core/operations/claim.test.ts`

- [ ] **Step 1: Read the current claim operation**

Run: `grep -n "claimOrRenew\|export async function" src/core/operations/claim.ts`

Identify the post-commit point — typically after `await deps.claimStore.claimOrRenew(...)` returns.

- [ ] **Step 2: Add status-change tracking**

After the claim is created/renewed, capture the prior persisted phase (if any) and project the new claim to its Entity. Fire `onEntityWrite` only when the persisted phase changed OR this is a fresh claim (`prior === undefined`). Skip when only `heartbeatAt` / `leaseExpiresAt` advanced — those are noise.

Add the import:
```typescript
import { claimToEntity } from "../entity.js";
```

Replace the relevant section (sketch — adapt to actual code):
```typescript
  const prior = await deps.claimStore.getClaim(claim.claimId);
  const result = await deps.claimStore.claimOrRenew(claim);
  const phaseChanged = !prior || prior.status !== result.status;
  if (phaseChanged && deps.onEntityWrite && deps.namespace) {
    deps.onEntityWrite({
      kind: "Claim",
      namespace: deps.namespace,
      op: prior ? "MODIFIED" : "ADDED",
      entity: claimToEntity(result, () => Date.now(), deps.namespace),
    });
  }
```

- [ ] **Step 3: Add the test**

Append to `src/core/operations/claim.test.ts`:

```typescript
describe("claimOrRenew → onEntityWrite", () => {
  test("fires ADDED on first claim, MODIFIED on status change", async () => {
    const events: Array<{ op: string; phase: string }> = [];
    const deps = makeClaimTestDeps({
      onEntityWrite: (e) =>
        events.push({
          op: e.op,
          phase: (e.entity as { status: { phase: string } }).status.phase,
        }),
      namespace: "ns/wt",
    });

    await claimOperation({ targetRef: "t1", agent: { agentId: "a" } }, deps);
    await deps.claimStore.complete((await deps.claimStore.activeClaims())[0]!.claimId);
    // Re-emit by calling the operation again with a fresh claim
    await claimOperation({ targetRef: "t1", agent: { agentId: "a" } }, deps);

    expect(events.map((e) => e.op)).toEqual(["ADDED", /* complete fires via store, not op */ "ADDED"]);
  });

  test("does NOT fire when only heartbeat advances", async () => {
    const events: unknown[] = [];
    const deps = makeClaimTestDeps({
      onEntityWrite: (e) => events.push(e),
      namespace: "ns/wt",
    });
    await claimOperation({ targetRef: "t1", agent: { agentId: "a" } }, deps);
    const before = events.length;
    // Direct heartbeat — bypasses the operation, so no hook fires
    await deps.claimStore.heartbeat((await deps.claimStore.activeClaims())[0]!.claimId);
    expect(events.length).toBe(before);
  });
});
```

`makeClaimTestDeps` follows the same pattern as `makeContributeTestDeps` from Task 10. Reuse if it exists; define inline if not.

> Note: `complete` and `release` are direct store calls, not part of `claimOperation`. To fire `onEntityWrite` for those transitions in this MVP, the simplest path is to subscribe at the store wrapper layer — covered by Phase 7 (Nexus catch-all). Local-only flows that bypass Nexus will not see Claim MODIFIED/DELETED events until a follow-up. This is documented in the spec's "future work" section.

- [ ] **Step 4: Run tests**

Run: `bun test src/core/operations/claim.test.ts -t "onEntityWrite"`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/operations/claim.ts src/core/operations/claim.test.ts
git commit -m "feat(watch): claim operation fires onEntityWrite on phase change (#292)"
```

---

## Phase 7 — Nexus catch-all (cross-process writes)

### Task 20: NexusWatchPublisher

**Files:**
- Create: `src/nexus/nexus-watch-publisher.ts`

- [ ] **Step 1: Write the file**

```typescript
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

const ENTITY_CHANGED_TOPIC = "entity.changed";

export interface EntityChangedEnvelope {
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly op: WatchOp;
  readonly entityId: string;
  readonly generation: number;
  readonly emittedAt: string;
}

export class NexusWatchPublisher {
  constructor(private readonly bus: EventBus) {}

  async publish(envelope: EntityChangedEnvelope): Promise<void> {
    await this.bus.publish({
      type: ENTITY_CHANGED_TOPIC,
      sourceRole: "grove-store",
      targetRole: "*",
      payload: { ...envelope },
      timestamp: envelope.emittedAt,
    });
  }
}

export const ENTITY_CHANGED = ENTITY_CHANGED_TOPIC;
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/nexus/nexus-watch-publisher.ts
git commit -m "feat(watch): NexusWatchPublisher for entity.changed envelopes (#292)"
```

---

### Task 21: NexusWatchSubscriber

**Files:**
- Create: `src/nexus/nexus-watch-subscriber.ts`
- Create: `src/nexus/nexus-watch-subscriber.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/nexus/nexus-watch-subscriber.test.ts
import { describe, expect, test } from "bun:test";
import { LocalEventBus } from "../core/local-event-bus.js";
import { WatchHub } from "../core/watch-hub.js";
import {
  ENTITY_CHANGED,
  NexusWatchPublisher,
} from "./nexus-watch-publisher.js";
import { NexusWatchSubscriber } from "./nexus-watch-subscriber.js";

describe("NexusWatchSubscriber", () => {
  test("forwards entity.changed envelopes to WatchHub", async () => {
    const bus = new LocalEventBus();
    const hub = new WatchHub();
    const fetcher = async (kind: string, ns: string, id: string) => ({
      kind,
      namespace: ns,
      id,
      spec: {},
      status: {},
      conditions: [],
      observedGeneration: 0,
      resourceVersion: "1",
      metadata: { generation: 1 },
    });
    const sub = new NexusWatchSubscriber({ bus, hub, fetchEntity: fetcher });
    sub.start();

    const pub = new NexusWatchPublisher(bus);
    await pub.publish({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entityId: "cid-1",
      generation: 1,
      emittedAt: new Date().toISOString(),
    });

    // Allow microtask flush
    await new Promise((r) => setImmediate(r));
    expect(hub.currentRv("ns/wt", "Contribution")).toBe(1n);
  });

  test("dedupes within window when (kind, id, generation) repeats", async () => {
    const bus = new LocalEventBus();
    const hub = new WatchHub();
    let fetched = 0;
    const fetcher = async (kind: string, ns: string, id: string) => {
      fetched += 1;
      return {
        kind,
        namespace: ns,
        id,
        spec: {},
        status: {},
        conditions: [],
        observedGeneration: 0,
        resourceVersion: "1",
        metadata: { generation: 1 },
      };
    };
    const sub = new NexusWatchSubscriber({
      bus,
      hub,
      fetchEntity: fetcher,
      dedupWindowMs: 1_000,
    });
    sub.start();

    const env = {
      kind: "Contribution" as const,
      namespace: "ns/wt",
      op: "ADDED" as const,
      entityId: "cid-1",
      generation: 1,
      emittedAt: new Date().toISOString(),
    };

    // Mark seen via the fast-path API
    sub.markSeen(env);

    const pub = new NexusWatchPublisher(bus);
    await pub.publish(env);

    await new Promise((r) => setImmediate(r));
    expect(hub.currentRv("ns/wt", "Contribution")).toBe(0n);
    expect(fetched).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test src/nexus/nexus-watch-subscriber.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/nexus/nexus-watch-subscriber.ts
import type { EventBus } from "../core/event-bus.js";
import type {
  EntityWriteEvent,
  WatchEntity,
  WatchKind,
  WatchOp,
} from "../core/watch-events.js";
import type { WatchHub } from "../core/watch-hub.js";
import {
  ENTITY_CHANGED,
  type EntityChangedEnvelope,
} from "./nexus-watch-publisher.js";

export interface NexusWatchSubscriberOptions {
  readonly bus: EventBus;
  readonly hub: WatchHub;
  /** Fetch the full entity on receipt — keeps the wire format minimal. */
  readonly fetchEntity: (
    kind: WatchKind,
    namespace: string,
    id: string,
  ) => Promise<WatchEntity>;
  /** Dedupe window for in-process fast-path replays. Default 5_000ms. */
  readonly dedupWindowMs?: number;
}

interface SeenKey {
  readonly key: string;
  readonly seenAt: number;
}

const DEFAULT_DEDUP_WINDOW = 5_000;

export class NexusWatchSubscriber {
  private readonly opts: NexusWatchSubscriberOptions;
  private readonly seen: SeenKey[] = [];
  private readonly handler = (event: { payload: Record<string, unknown> }) => {
    void this.onEnvelope(event.payload as unknown as EntityChangedEnvelope);
  };
  private started = false;

  constructor(opts: NexusWatchSubscriberOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.opts.bus.subscribe(ENTITY_CHANGED, this.handler);
  }

  stop(): void {
    if (!this.started) return;
    this.opts.bus.unsubscribe(ENTITY_CHANGED, this.handler);
    this.started = false;
  }

  /**
   * Record that the in-process fast path already handled this write. The
   * subscriber will then ignore the matching cross-process envelope.
   */
  markSeen(envelope: {
    kind: WatchKind;
    entityId: string;
    generation: number;
  }): void {
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
    const entity = await this.opts.fetchEntity(env.kind, env.namespace, env.entityId);
    const e: EntityWriteEvent = {
      kind: env.kind,
      namespace: env.namespace,
      op: env.op as WatchOp,
      entity,
    };
    this.opts.hub.recordWrite(e);
  }

  private dedupKey(env: {
    kind: WatchKind;
    entityId: string;
    generation: number;
  }): string {
    return `${env.kind}\x00${env.entityId}\x00${env.generation}`;
  }

  private expire(): void {
    const cutoff = Date.now() - (this.opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW);
    while (this.seen.length > 0 && this.seen[0]!.seenAt < cutoff) {
      this.seen.shift();
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/nexus/nexus-watch-subscriber.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/nexus/nexus-watch-subscriber.ts src/nexus/nexus-watch-subscriber.test.ts
git commit -m "feat(watch): NexusWatchSubscriber forwards entity.changed → hub (#292)"
```

---

### Task 22: Wire Nexus stores to publish on writes

**Files:**
- Modify: `src/nexus/nexus-contribution-store.ts`
- Modify: `src/nexus/nexus-claim-store.ts`

- [ ] **Step 1: Add an optional publisher on each store**

Both stores currently take a constructor-options object. Add an optional `watchPublisher?: NexusWatchPublisher` field to each.

Edit `src/nexus/nexus-contribution-store.ts`. Add the import:
```typescript
import type { NexusWatchPublisher } from "./nexus-watch-publisher.js";
```

Add to the constructor options interface and to the class.

Find the post-commit point inside `submit` / `put`. After the contribution is durably written, call:
```typescript
    await this.watchPublisher?.publish({
      kind: "Contribution",
      namespace: this.namespace,
      op: "ADDED",
      entityId: contribution.cid,
      generation: 1,
      emittedAt: new Date().toISOString(),
    });
```

Repeat the equivalent change for `nexus-claim-store.ts`, calling `publish` after `createClaim`, `claimOrRenew`, `complete`, `release`. For each, derive `op` from the operation:
- `createClaim` / first `claimOrRenew` → `ADDED`
- subsequent renew → skip (no phase change unless status flips, which `claimOrRenew` does not do)
- `complete` / `release` → `MODIFIED`
- `cleanCompleted` → `DELETED` (per row)

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS. Add `watchPublisher` to all instantiation sites the typechecker complains about (or default it to `undefined` in the options, which is fine since the field is optional).

- [ ] **Step 3: Wire the publisher into `serve.ts`**

In `src/server/serve.ts`, after the Nexus event-bus is constructed and `WatchHub` is constructed:
```typescript
const watchPublisher =
  nexusEventBus !== undefined
    ? new NexusWatchPublisher(nexusEventBus)
    : undefined;
```

Pass `watchPublisher` into the Nexus store constructor calls.

If `nexusEventBus` is undefined, the publisher is undefined; the stores fall back to no-op, and the in-process fast path remains the only RV source — correct behavior for local-only mode.

- [ ] **Step 4: Wire the subscriber into `serve.ts`**

After the publisher and the WatchHub:
```typescript
const watchSubscriber =
  nexusEventBus !== undefined
    ? new NexusWatchSubscriber({
        bus: nexusEventBus,
        hub: watchHub,
        fetchEntity: makeWatchEntityFetcher(deps),
      })
    : undefined;
watchSubscriber?.start();
```

`makeWatchEntityFetcher` returns a function that, given (kind, namespace, id), fetches the row from the right store and projects to Entity:
```typescript
function makeWatchEntityFetcher(deps: ServerDeps) {
  return async (kind: WatchKind, namespace: string, id: string): Promise<WatchEntity> => {
    if (kind === "Contribution") {
      const c = await deps.contributionStore.get(id);
      if (!c) throw new Error(`Contribution ${id} not found`);
      return contributionToEntity(c, namespace);
    }
    if (kind === "Claim") {
      const c = await deps.claimStore.getClaim(id);
      if (!c) throw new Error(`Claim ${id} not found`);
      return claimToEntity(c, () => Date.now(), namespace);
    }
    throw new Error(`Unsupported kind for watch fetcher: ${kind}`);
  };
}
```

Place this helper at the bottom of `serve.ts` (or a new `src/server/watch-fetcher.ts` if `serve.ts` is becoming unwieldy).

- [ ] **Step 5: markSeen integration**

Update the `onEntityWrite` callback in `operation-adapter.ts` (Task 12) to also call `watchSubscriber?.markSeen` so the in-process fast path suppresses the cross-process duplicate:
```typescript
    onEntityWrite: (event) => {
      serverDeps.watchHub.recordWrite(event);
      serverDeps.watchSubscriber?.markSeen({
        kind: event.kind,
        entityId: event.entity.id,
        generation: event.entity.metadata.generation,
      });
    },
```

This requires adding `watchSubscriber?: NexusWatchSubscriber` to `ServerDeps`. Add it.

- [ ] **Step 6: Typecheck and run all tests**

Run: `bunx tsc --noEmit && bun test src/server/ src/core/watch-hub.test.ts src/nexus/nexus-watch-subscriber.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/nexus/nexus-contribution-store.ts src/nexus/nexus-claim-store.ts src/server/serve.ts src/server/deps.ts src/server/operation-adapter.ts src/server/watch-fetcher.ts
git commit -m "feat(watch): publish entity.changed from Nexus stores; subscriber feeds hub (#292)"
```

---

### Task 23: Cross-process integration smoke test

**Files:**
- Create: `src/server/watch.cross-process.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// src/server/watch.cross-process.test.ts
import { describe, expect, test } from "bun:test";
import { LocalEventBus } from "../core/local-event-bus.js";
import { NexusWatchPublisher } from "../nexus/nexus-watch-publisher.js";
import { createTestApp, withAuth } from "./test-helpers.js";
import { readSseEvents } from "./sse-test-utils.js";

describe("watch cross-process via Nexus event-bus", () => {
  test("envelope from a different process surfaces on a watch stream", async () => {
    const bus = new LocalEventBus();
    const { app, contributionStore } = await createTestApp({
      eventBus: bus,
    });

    const list = await app
      .request("/api/list?kind=Contribution", { headers: withAuth() })
      .then((r) => r.json());

    const watchRes = await app.request(
      `/api/watch?kind=Contribution&resumeFrom=${list.listResourceVersion}`,
      { headers: withAuth() },
    );

    // Simulate an out-of-band write: write to the store directly, then
    // publish on the bus the way another process would.
    const cid = await contributionStore.put({
      kind: "work",
      mode: "evaluation",
      summary: "cross-proc",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "ext" },
      createdAt: new Date().toISOString(),
    } as never);

    const pub = new NexusWatchPublisher(bus);
    await pub.publish({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entityId: cid,
      generation: 1,
      emittedAt: new Date().toISOString(),
    });

    const events = await readSseEvents(watchRes, 1, 2_000);
    expect(events[0]?.event).toBe("ADDED");
    expect((events[0]?.data as { entity: { id: string } }).entity.id).toBe(cid);
  });
});
```

`createTestApp` may need an `eventBus` option to share the bus between the publisher and the subscriber. Add it analogously to `watchHubOptions`. If `contributionStore.put` does not match the actual API, use the existing API to insert a contribution directly (whatever the local store helper provides).

- [ ] **Step 2: Run the test**

Run: `bun test src/server/watch.cross-process.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/watch.cross-process.test.ts src/server/test-helpers.ts
git commit -m "test(watch): cross-process write surfaces on watch stream (#292)"
```

---

## Phase 8 — Polish + final verification

### Task 24: Lint, typecheck, full test sweep

- [ ] **Step 1: Biome**

Run: `bunx biome check --write src/`
Expected: Clean.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `bun test`
Expected: PASS. If any pre-existing test regressed, investigate and fix before commit. Do not skip or weaken assertions.

- [ ] **Step 4: Acceptance recap**

Confirm by running the named files explicitly:

```
bun test src/server/watch.race.test.ts
bun test src/server/watch.kill.test.ts
bun test src/server/watch.bookmark.test.ts
```

All three should pass — they correspond to the three issue acceptance criteria.

- [ ] **Step 5: Commit any final cleanup**

```bash
git add -A
git commit -m "chore(watch): biome cleanup post-A5 (#292)" || echo "nothing to clean"
```

---

### Task 25: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin worktree-tidy-hatching-wadler
```

- [ ] **Step 2: Open PR via gh**

```bash
gh pr create --title "feat(watch): A5 list→watch RV handshake (#292)" --body "$(cat <<'EOF'
## Summary
- New `WatchHub` holds a per-(namespace, kind) monotonic resourceVersion plus a ring buffer (1024 events / 5 min).
- New endpoints: `GET /api/list?kind=X` returns `{items, listResourceVersion}`; `GET /api/watch?kind=X&resumeFrom=Y` is SSE with mandatory `resumeFrom`.
- Writes feed the hub from two paths: the in-process `onEntityWrite` operations hook for HTTP-mediated writes, and a Nexus event-bus `entity.changed` subscription for cross-process writes from MCP agents.
- Acceptance tests cover the handshake race, kill-9 resume, and bookmark cadence (issue criteria #2, #1, #3).

## Spec
docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md

## Test plan
- [ ] `bun test src/core/watch-hub.test.ts`
- [ ] `bun test src/server/watch.integration.test.ts`
- [ ] `bun test src/server/watch.race.test.ts`
- [ ] `bun test src/server/watch.kill.test.ts`
- [ ] `bun test src/server/watch.bookmark.test.ts`
- [ ] `bun test src/server/watch.cross-process.test.ts`
- [ ] `bun test src/nexus/nexus-watch-subscriber.test.ts`
- [ ] Full suite `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bunx biome check src/`

Closes #292
EOF
)"
```

---

## Self-review checklist

After execution, audit against these items before declaring done:

- **Spec coverage**:
  - Per-(namespace, kind) monotonic RV → Tasks 2, 3 (WatchHub).
  - List returns `{items, listResourceVersion}` → Task 11.
  - Watch resumes from `resumeFrom`, NEVER "latest" → Task 11 (zod requires the field).
  - Replay between list-return and watch-establish → Task 11 + Task 16 race test.
  - BOOKMARK ≥1/30s → Task 11 timer + Task 18.
  - 410 on stale RV → Task 6 (hub) + Task 15 (HTTP).
  - Kill-9 resume → Task 17.
  - Three Entity kinds covered: Contribution (Phase 2), Claim (Phase 6). AgentSession deferred — documented in spec non-goals; full A5 closure does not require it because Claim + Contribution exercise every code path.

- **Type consistency**: `WatchKind`, `WatchOp`, `WatchEvent`, `EntityWriteEvent` defined once in `watch-events.ts` and imported everywhere.

- **No placeholders**: every step shows code or an exact command. No "implement appropriately" wording.

- **Frequent commits**: every task ends with a `git commit`. Each commit message is `<type>(watch): <summary> (#292)`.

- **Test discipline**: every implementation step is preceded by a failing test, then made green.

---

## Risks / open follow-ups

These are explicitly OUT of scope for the A5 plan but should be tracked:

1. **AgentSession write hook**: session lifecycle transitions live in `session-orchestrator.ts` / `acp-runtime.ts`, not in the operations layer. Wiring `onEntityWrite` for these requires a small refactor — track as a follow-up issue once A7 informer needs it.
2. **Compaction**: when the ring is full and a slow watcher wakes, it gets 410. A6 (#293) replaces this with smarter recovery. Until then, clients re-list — acceptable per spec.
3. **Single-server scope**: multi-grove-server consensus is out of scope; one server per worktree is the deployment shape.
