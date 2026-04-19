# Bounded Channel Backpressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a bounded, per-event-kind drop-policy channel between `AcpParser` and `AcpxTurn.messages` consumers so a slow consumer never stalls the parser nor causes unbounded memory growth.

**Architecture:** A generic `BoundedEventChannel<T>` ring buffer with a parallel `policyAt: Policy[]` ring (records each slot's classification at push time). Push is synchronous and never blocks: chunked text/thinking deltas coalesce into the most recent same-kind buffered event via a per-kind tail-index map; semantic events (`tool_call`, `permission_request`, terminal text) evict the oldest drop-eligible slot to fit; cosmetic events (`token_usage`, `raw`) evict the oldest. Single consumer per channel. `AcpxTurnImpl` constructs one channel per turn, drains the existing `parser.messages` subscriber into it, and exposes the channel as its `messages` iterable.

**Tech Stack:** TypeScript, Bun test runner (`bun:test`), Node `Readable` streams. No new runtime deps.

**Design spec:** `docs/superpowers/specs/2026-04-18-bounded-channel-backpressure-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/acp/bounded-channel.ts` | **create** | Generic `BoundedEventChannel<T>`: ring buffer, policy resolver, async iterator, stats. Zero ACP coupling. |
| `src/acp/bounded-channel.test.ts` | **create** | Unit tests for the generic primitive. Uses a synthetic `TestEvent` type. |
| `src/acp/turn.ts` | **modify** | `AcpxTurnImpl` constructs channel with ACP-specific `classify`/`coalesceKey`/`coalesce`/`invalidatesCoalesceKey` callbacks. Exposes channel as `this.messages`. |
| `src/acp/turn.test.ts` | **modify** | Add 4 integration tests: default capacity 256, Infinity bypass, kind classification, slow-consumer simulation. Existing 8 tests stay green. |

---

## Task 1: Scaffold BoundedEventChannel module + first failing test

**Files:**
- Create: `src/acp/bounded-channel.ts`
- Create: `src/acp/bounded-channel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/acp/bounded-channel.test.ts
import { expect, test } from "bun:test";
import { BoundedEventChannel, type Policy } from "./bounded-channel.js";

interface TestEvent {
  kind: "drop" | "keep" | "delta_a" | "delta_b" | "terminal_a";
  text?: string;
  id: number;
}

function classify(e: TestEvent): Policy {
  if (e.kind === "keep" || e.kind === "terminal_a") return "never";
  if (e.kind === "delta_a" || e.kind === "delta_b") return "coalesce_text_deltas";
  return "drop_oldest_on_full";
}

function coalesceKey(e: TestEvent): string | null {
  if (e.kind === "delta_a" || e.kind === "delta_b") return e.kind;
  return null;
}

function coalesce(existing: TestEvent, incoming: TestEvent): TestEvent {
  return { ...existing, text: (existing.text ?? "") + (incoming.text ?? "") };
}

function invalidatesCoalesceKey(e: TestEvent): string | null {
  if (e.kind === "terminal_a") return "delta_a";
  return null;
}

function makeChannel(capacity = 4) {
  return new BoundedEventChannel<TestEvent>({
    capacity,
    classify,
    coalesceKey,
    coalesce,
    invalidatesCoalesceKey,
  });
}

test("push 3 then drain returns 3 in FIFO order", async () => {
  const ch = makeChannel();
  ch.push({ kind: "drop", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  ch.push({ kind: "drop", id: 3 });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([1, 2, 3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/acp/bounded-channel.test.ts -t "push 3 then drain"`
Expected: FAIL with module not found / `BoundedEventChannel` undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/acp/bounded-channel.ts
export type Policy = "never" | "coalesce_text_deltas" | "drop_oldest_on_full";

export interface ChannelOptions<T> {
  capacity: number;
  classify: (event: T) => Policy;
  coalesceKey?: (event: T) => string | null;
  coalesce?: (existing: T, incoming: T) => T;
  invalidatesCoalesceKey?: (event: T) => string | null;
  onDrop?: (event: T, reason: "evicted" | "coalesced" | "no_capacity") => void;
}

export interface ChannelStats {
  pushed: number;
  coalesced: number;
  evicted: number;
  droppedByPolicy: Map<Policy, number>;
}

export class BoundedEventChannel<T> {
  private readonly opts: ChannelOptions<T>;
  private readonly buffer: (T | undefined)[];
  private readonly policyAt: (Policy | undefined)[];
  private head = 0;
  private tail = 0;
  private size = 0;
  private readonly coalesceTails = new Map<string, number>();
  private pendingResolver: ((value: IteratorResult<T>) => void) | null = null;
  private closed = false;
  private readonly _stats: ChannelStats = {
    pushed: 0,
    coalesced: 0,
    evicted: 0,
    droppedByPolicy: new Map(),
  };
  private readonly unbounded: boolean;

  constructor(opts: ChannelOptions<T>) {
    this.opts = opts;
    this.unbounded = !Number.isFinite(opts.capacity);
    // For unbounded, allocate a small initial array and grow on push.
    const initial = this.unbounded ? 16 : opts.capacity;
    this.buffer = new Array(initial);
    this.policyAt = new Array(initial);
  }

  push(event: T): void {
    if (this.closed) {
      this.opts.onDrop?.(event, "no_capacity");
      return;
    }
    this._stats.pushed++;
    // Minimal: append-only. Policy logic added in later tasks.
    this._appendTail(event, this.opts.classify(event));
  }

  close(): void {
    this.closed = true;
    if (this.pendingResolver && this.size === 0) {
      const r = this.pendingResolver;
      this.pendingResolver = null;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  stats(): ChannelStats {
    return {
      pushed: this._stats.pushed,
      coalesced: this._stats.coalesced,
      evicted: this._stats.evicted,
      droppedByPolicy: new Map(this._stats.droppedByPolicy),
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const self = this;
    return {
      async next(): Promise<IteratorResult<T>> {
        if (self.size > 0) {
          const ev = self.buffer[self.head] as T;
          self.buffer[self.head] = undefined;
          self.policyAt[self.head] = undefined;
          // Clear coalesce tail if this index was a tail.
          for (const [k, idx] of self.coalesceTails) {
            if (idx === self.head) self.coalesceTails.delete(k);
          }
          self.head = (self.head + 1) % self.buffer.length;
          self.size--;
          return { value: ev, done: false };
        }
        if (self.closed) return { value: undefined as unknown as T, done: true };
        return new Promise<IteratorResult<T>>((resolve) => {
          self.pendingResolver = resolve;
        });
      },
      async return(): Promise<IteratorResult<T>> {
        self.closed = true;
        return { value: undefined as unknown as T, done: true };
      },
    };
  }

  private _appendTail(event: T, policy: Policy): void {
    if (this.pendingResolver) {
      const r = this.pendingResolver;
      this.pendingResolver = null;
      r({ value: event, done: false });
      return;
    }
    if (this.unbounded && this.size === this.buffer.length) {
      this._grow();
    }
    this.buffer[this.tail] = event;
    this.policyAt[this.tail] = policy;
    this.tail = (this.tail + 1) % this.buffer.length;
    this.size++;
  }

  private _grow(): void {
    const oldCap = this.buffer.length;
    const newCap = oldCap * 2;
    const newBuf: (T | undefined)[] = new Array(newCap);
    const newPol: (Policy | undefined)[] = new Array(newCap);
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head + i) % oldCap;
      newBuf[i] = this.buffer[idx];
      newPol[i] = this.policyAt[idx];
    }
    // Replace via index assignment to preserve readonly-ish array refs.
    this.buffer.length = 0;
    this.policyAt.length = 0;
    for (let i = 0; i < newCap; i++) {
      this.buffer.push(newBuf[i]);
      this.policyAt.push(newPol[i]);
    }
    this.head = 0;
    this.tail = this.size;
    this.coalesceTails.clear(); // indices invalid after rehome — safe-loss
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/acp/bounded-channel.test.ts -t "push 3 then drain"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/bounded-channel.ts src/acp/bounded-channel.test.ts
git commit -m "feat(acp): scaffold BoundedEventChannel with FIFO drain (#274)"
```

---

## Task 2: drop_oldest_on_full evicts oldest when buffer full

**Files:**
- Modify: `src/acp/bounded-channel.ts`
- Modify: `src/acp/bounded-channel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/acp/bounded-channel.test.ts`:

```ts
test("drop_oldest_on_full: cap+10 pushes, drain returns last `cap` in order", async () => {
  const cap = 4;
  const evicted: TestEvent[] = [];
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: cap,
    classify,
    onDrop: (e, reason) => {
      if (reason === "evicted") evicted.push(e);
    },
  });
  for (let i = 1; i <= cap + 10; i++) ch.push({ kind: "drop", id: i });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([11, 12, 13, 14]);
  expect(evicted.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(ch.stats().evicted).toBe(10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/acp/bounded-channel.test.ts -t "drop_oldest_on_full"`
Expected: FAIL — buffer overruns or ordering wrong because eviction is unimplemented.

- [ ] **Step 3: Implement eviction in push for drop_oldest_on_full**

Replace the body of `push()` in `src/acp/bounded-channel.ts`:

```ts
push(event: T): void {
  if (this.closed) {
    this.opts.onDrop?.(event, "no_capacity");
    return;
  }
  this._stats.pushed++;
  const policy = this.opts.classify(event);

  if (policy === "drop_oldest_on_full") {
    if (!this.unbounded && this.size === this.buffer.length) {
      const victim = this.buffer[this.head] as T;
      this._evictAt(this.head);
      this._stats.evicted++;
      this.opts.onDrop?.(victim, "evicted");
    }
    this._appendTail(event, policy);
    return;
  }

  // never + coalesce policies handled in later tasks; for now, append.
  this._appendTail(event, policy);
}
```

Add `_evictAt` helper to the class:

```ts
private _evictAt(idx: number): void {
  this.buffer[idx] = undefined;
  this.policyAt[idx] = undefined;
  for (const [k, i] of this.coalesceTails) {
    if (i === idx) this.coalesceTails.delete(k);
  }
  if (idx === this.head) {
    this.head = (this.head + 1) % this.buffer.length;
    this.size--;
    return;
  }
  // Mid-ring eviction: shift tail-side elements one slot toward head to keep
  // the ring contiguous. Cheap because cap is small (256).
  const cap = this.buffer.length;
  let cur = idx;
  while (true) {
    const next = (cur + 1) % cap;
    if (next === this.tail) break;
    this.buffer[cur] = this.buffer[next];
    this.policyAt[cur] = this.policyAt[next];
    // Update coalesceTails entries that pointed at `next` → now `cur`.
    for (const [k, i] of this.coalesceTails) {
      if (i === next) this.coalesceTails.set(k, cur);
    }
    cur = next;
  }
  this.tail = (this.tail - 1 + cap) % cap;
  this.buffer[this.tail] = undefined;
  this.policyAt[this.tail] = undefined;
  this.size--;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/acp/bounded-channel.test.ts -t "drop_oldest_on_full"`
Expected: PASS. Also re-run prior test:
Run: `bun test src/acp/bounded-channel.test.ts`
Expected: 2/2 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/bounded-channel.ts src/acp/bounded-channel.test.ts
git commit -m "feat(acp): drop_oldest_on_full eviction in BoundedEventChannel (#274)"
```

---

## Task 3: coalesce_text_deltas merges into per-kind tail

**Files:**
- Modify: `src/acp/bounded-channel.ts`
- Modify: `src/acp/bounded-channel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
test("coalesce hot path: 100 deltas merge into one buffered event", async () => {
  const ch = makeChannel(8);
  for (let i = 0; i < 100; i++) ch.push({ kind: "delta_a", id: i, text: "x" });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got).toHaveLength(1);
  expect(got[0]?.text).toBe("x".repeat(100));
  expect(ch.stats().coalesced).toBe(99);
});

test("coalesce key isolation: delta_a and delta_b coalesce independently", async () => {
  const ch = makeChannel(8);
  for (let i = 0; i < 5; i++) {
    ch.push({ kind: "delta_a", id: i, text: "a" });
    ch.push({ kind: "delta_b", id: i, text: "b" });
  }
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got).toHaveLength(2);
  const byKind = Object.fromEntries(got.map((e) => [e.kind, e.text]));
  expect(byKind["delta_a"]).toBe("aaaaa");
  expect(byKind["delta_b"]).toBe("bbbbb");
});

test("coalesce tail invalidated on consume: next delta starts new entry", async () => {
  const ch = makeChannel(8);
  ch.push({ kind: "delta_a", id: 1, text: "a" });
  ch.push({ kind: "delta_a", id: 2, text: "b" }); // coalesces → "ab"
  // Drain manually so we control timing; iterator drains both as one event "ab".
  const it = ch[Symbol.asyncIterator]();
  const first = await it.next();
  expect(first.value.text).toBe("ab");
  // Tail consumed → next delta must NOT merge into it.
  ch.push({ kind: "delta_a", id: 3, text: "c" });
  ch.close();
  const second = await it.next();
  expect(second.value.text).toBe("c");
  const third = await it.next();
  expect(third.done).toBe(true);
});

test("coalesce tail invalidated by terminal: next delta starts new entry", async () => {
  const ch = makeChannel(8);
  ch.push({ kind: "delta_a", id: 1, text: "a" });
  ch.push({ kind: "delta_a", id: 2, text: "b" });
  ch.push({ kind: "terminal_a", id: 3 }); // invalidates delta_a tail
  ch.push({ kind: "delta_a", id: 4, text: "c" }); // must NOT merge into id=1/2
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got).toHaveLength(3);
  expect(got[0]?.text).toBe("ab");
  expect(got[1]?.kind).toBe("terminal_a");
  expect(got[2]?.text).toBe("c");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/acp/bounded-channel.test.ts -t "coalesce"`
Expected: FAIL — coalesce not implemented; events accumulate without merging.

- [ ] **Step 3: Implement coalesce in push**

Update `push()` in `src/acp/bounded-channel.ts` to handle `coalesce_text_deltas` and the terminal-invalidation case for `never`:

```ts
push(event: T): void {
  if (this.closed) {
    this.opts.onDrop?.(event, "no_capacity");
    return;
  }
  this._stats.pushed++;
  const policy = this.opts.classify(event);

  if (policy === "coalesce_text_deltas") {
    const key = this.opts.coalesceKey?.(event) ?? null;
    if (key !== null && this.coalesceTails.has(key) && this.opts.coalesce) {
      const idx = this.coalesceTails.get(key) as number;
      this.buffer[idx] = this.opts.coalesce(this.buffer[idx] as T, event);
      this._stats.coalesced++;
      this.opts.onDrop?.(event, "coalesced");
      return;
    }
    // Fall through to append; record tail after.
    const tailIdxBefore = this.tail;
    this._appendTail(event, policy);
    // Only record tail if event was actually buffered (not fast-pathed).
    if (this.size > 0 && this.policyAt[tailIdxBefore] === policy && key !== null) {
      this.coalesceTails.set(key, tailIdxBefore);
    }
    return;
  }

  if (policy === "never") {
    const invKey = this.opts.invalidatesCoalesceKey?.(event) ?? null;
    if (invKey !== null) this.coalesceTails.delete(invKey);
    // Eviction-to-fit handled in Task 4. For now, just append.
    this._appendTail(event, policy);
    return;
  }

  if (policy === "drop_oldest_on_full") {
    if (!this.unbounded && this.size === this.buffer.length) {
      const victim = this.buffer[this.head] as T;
      this._evictAt(this.head);
      this._stats.evicted++;
      this.opts.onDrop?.(victim, "evicted");
    }
    this._appendTail(event, policy);
    return;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/acp/bounded-channel.test.ts`
Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/bounded-channel.ts src/acp/bounded-channel.test.ts
git commit -m "feat(acp): coalesce_text_deltas with per-kind tail invalidation (#274)"
```

---

## Task 4: never policy evicts drop-eligible to fit

**Files:**
- Modify: `src/acp/bounded-channel.ts`
- Modify: `src/acp/bounded-channel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
test("never policy evicts oldest drop-eligible to make room", async () => {
  const cap = 4;
  const ch = new BoundedEventChannel<TestEvent>({ capacity: cap, classify });
  // Fill with drop-eligible.
  for (let i = 1; i <= cap; i++) ch.push({ kind: "drop", id: i });
  // Push semantic event — must evict the OLDEST drop-eligible (id=1).
  ch.push({ kind: "keep", id: 99 });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([2, 3, 4, 99]);
  expect(ch.stats().evicted).toBe(1);
});

test("never policy with no drop-eligible: incoming dropped, counter increments", async () => {
  const cap = 3;
  const dropped: TestEvent[] = [];
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: cap,
    classify,
    onDrop: (e, reason) => {
      if (reason === "no_capacity") dropped.push(e);
    },
  });
  // Fill with never-policy events.
  for (let i = 1; i <= cap; i++) ch.push({ kind: "keep", id: i });
  // Push another never-policy → no drop-eligible victim → drop incoming.
  ch.push({ kind: "keep", id: 99 });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([1, 2, 3]);
  expect(dropped.map((e) => e.id)).toEqual([99]);
  expect(ch.stats().droppedByPolicy.get("never")).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/acp/bounded-channel.test.ts -t "never policy"`
Expected: FAIL — `never` branch in push currently calls `_appendTail` which lacks bounded-eviction support, so semantic events overflow or wedge silently.

- [ ] **Step 3: Implement evict-to-fit in never branch**

Add helper to the class:

```ts
private _findOldestDropEligibleIdx(): number {
  // Walk head → tail in ring order; return first slot whose policy is drop_oldest_on_full.
  const cap = this.buffer.length;
  for (let i = 0; i < this.size; i++) {
    const idx = (this.head + i) % cap;
    if (this.policyAt[idx] === "drop_oldest_on_full") return idx;
  }
  return -1;
}
```

Replace the `never` branch of `push()`:

```ts
if (policy === "never") {
  const invKey = this.opts.invalidatesCoalesceKey?.(event) ?? null;
  if (invKey !== null) this.coalesceTails.delete(invKey);

  if (!this.unbounded && this.size === this.buffer.length) {
    const victimIdx = this._findOldestDropEligibleIdx();
    if (victimIdx === -1) {
      // All slots are never-policy → preserve bounded mem; drop incoming.
      const prev = this._stats.droppedByPolicy.get("never") ?? 0;
      this._stats.droppedByPolicy.set("never", prev + 1);
      this.opts.onDrop?.(event, "no_capacity");
      return;
    }
    const victim = this.buffer[victimIdx] as T;
    this._evictAt(victimIdx);
    this._stats.evicted++;
    this.opts.onDrop?.(victim, "evicted");
  }
  this._appendTail(event, policy);
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/acp/bounded-channel.test.ts`
Expected: 8/8 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/acp/bounded-channel.ts src/acp/bounded-channel.test.ts
git commit -m "feat(acp): never-policy evicts drop-eligible victim, drops incoming if none (#274)"
```

---

## Task 5: Iterator awaiting empty + close drains then EOFs

**Files:**
- Modify: `src/acp/bounded-channel.test.ts`
- (No source changes needed — fast-path resolver already implemented in Task 1; this task verifies it.)

- [ ] **Step 1: Write the failing tests**

Append:

```ts
test("iterator awaiting empty: push resolves directly without buffering", async () => {
  const ch = makeChannel(4);
  const it = ch[Symbol.asyncIterator]();
  // Start consuming before any push — iterator is now pending.
  const nextP = it.next();
  ch.push({ kind: "drop", id: 1 });
  const r = await nextP;
  expect(r.value.id).toBe(1);
  // Verify the event did NOT pass through the ring (size never grew).
  // Indirect check: stats.pushed === 1, but no eviction needed even at cap=1.
  // Construct a cap=1 channel and push twice with consumer awaiting:
  const ch2 = new BoundedEventChannel<TestEvent>({ capacity: 1, classify });
  const it2 = ch2[Symbol.asyncIterator]();
  const p1 = it2.next();
  ch2.push({ kind: "drop", id: 1 });
  expect((await p1).value.id).toBe(1);
  const p2 = it2.next();
  ch2.push({ kind: "drop", id: 2 });
  expect((await p2).value.id).toBe(2);
  expect(ch2.stats().evicted).toBe(0); // never buffered, never evicted
});

test("close drains buffered then signals done", async () => {
  const ch = makeChannel(8);
  ch.push({ kind: "drop", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  ch.push({ kind: "drop", id: 3 });
  ch.close();
  const it = ch[Symbol.asyncIterator]();
  expect((await it.next()).value.id).toBe(1);
  expect((await it.next()).value.id).toBe(2);
  expect((await it.next()).value.id).toBe(3);
  expect((await it.next()).done).toBe(true);
});

test("close while iterator pending resolves it as done", async () => {
  const ch = makeChannel(8);
  const it = ch[Symbol.asyncIterator]();
  const nextP = it.next();
  ch.close();
  const r = await nextP;
  expect(r.done).toBe(true);
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/acp/bounded-channel.test.ts -t "iterator awaiting empty|close drains|close while iterator pending"`
Expected: FAIL on "close while iterator pending" — current `close()` only resolves pending if `size === 0` AND `closed` is checked correctly, but the existing implementation does this. Verify behavior; if pass, move on.

If any test fails, the most likely fix is in `close()`. Ensure:

```ts
close(): void {
  this.closed = true;
  if (this.pendingResolver) {
    const r = this.pendingResolver;
    this.pendingResolver = null;
    r({ value: undefined as unknown as T, done: true });
  }
}
```

(Drop the `size === 0` guard from Task 1's stub — pending only exists when size was 0 anyway.)

- [ ] **Step 3: Re-run all tests**

Run: `bun test src/acp/bounded-channel.test.ts`
Expected: 11/11 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/acp/bounded-channel.ts src/acp/bounded-channel.test.ts
git commit -m "test(acp): cover fast-path resolver + close-while-pending (#274)"
```

---

## Task 6: Consumer break cleanup + post-close push drops silently

**Files:**
- Modify: `src/acp/bounded-channel.test.ts`
- Possibly modify: `src/acp/bounded-channel.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
test("consumer break: subsequent pushes drop silently and channel marks closed", async () => {
  const dropped: TestEvent[] = [];
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: 4,
    classify,
    onDrop: (e, reason) => {
      if (reason === "no_capacity") dropped.push(e);
    },
  });
  ch.push({ kind: "drop", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  for await (const e of ch) {
    expect(e.id).toBe(1);
    break; // triggers iterator.return() → channel marks closed
  }
  ch.push({ kind: "drop", id: 3 });
  ch.push({ kind: "keep", id: 4 });
  expect(dropped.map((e) => e.id)).toEqual([3, 4]);
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `bun test src/acp/bounded-channel.test.ts -t "consumer break"`
Expected: PASS — `return()` already sets `closed = true` (Task 1). If it fails, check the iterator's `return()`:

```ts
async return(): Promise<IteratorResult<T>> {
  self.closed = true;
  // Drop any pending resolver (no consumer to wake).
  self.pendingResolver = null;
  return { value: undefined as unknown as T, done: true };
},
```

- [ ] **Step 3: Run all tests**

Run: `bun test src/acp/bounded-channel.test.ts`
Expected: 12/12 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/acp/bounded-channel.ts src/acp/bounded-channel.test.ts
git commit -m "test(acp): consumer break closes channel and drops further pushes (#274)"
```

---

## Task 7: Stats accuracy + onDrop reasons under mixed push

**Files:**
- Modify: `src/acp/bounded-channel.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
test("stats accuracy under mixed push: pushed/coalesced/evicted/droppedByPolicy", async () => {
  const cap = 3;
  const reasons: Array<{ id: number; reason: string }> = [];
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: cap,
    classify,
    coalesceKey,
    coalesce,
    invalidatesCoalesceKey,
    onDrop: (e, reason) => reasons.push({ id: e.id, reason }),
  });

  // 3 deltas → 1 buffered, 2 coalesced
  ch.push({ kind: "delta_a", id: 1, text: "a" });
  ch.push({ kind: "delta_a", id: 2, text: "b" });
  ch.push({ kind: "delta_a", id: 3, text: "c" });
  // 2 drop-eligible (cap reached: 1 delta + 2 drop = 3)
  ch.push({ kind: "drop", id: 4 });
  ch.push({ kind: "drop", id: 5 });
  // never → evicts oldest drop-eligible (id=4)
  ch.push({ kind: "keep", id: 6 });
  // another never with no drop-eligible left? buffer = [delta_a-merged, drop-5, keep-6]
  // → drop-5 is the only drop-eligible → evicted
  ch.push({ kind: "keep", id: 7 });
  // now buffer = [delta_a-merged, keep-6, keep-7] → all never-policy
  // next never → no drop-eligible → drop incoming
  ch.push({ kind: "keep", id: 8 });

  const s = ch.stats();
  expect(s.pushed).toBe(8);
  expect(s.coalesced).toBe(2);
  expect(s.evicted).toBe(2); // id=4 and id=5
  expect(s.droppedByPolicy.get("never")).toBe(1); // id=8

  expect(reasons).toEqual([
    { id: 2, reason: "coalesced" },
    { id: 3, reason: "coalesced" },
    { id: 4, reason: "evicted" },
    { id: 5, reason: "evicted" },
    { id: 8, reason: "no_capacity" },
  ]);
});
```

- [ ] **Step 2: Run test**

Run: `bun test src/acp/bounded-channel.test.ts -t "stats accuracy"`
Expected: PASS (counters wired in Tasks 2/3/4). If it fails, the failure message identifies which counter is off.

- [ ] **Step 3: Run all tests**

Run: `bun test src/acp/bounded-channel.test.ts`
Expected: 13/13 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/acp/bounded-channel.test.ts
git commit -m "test(acp): stats and onDrop reasons under mixed push (#274)"
```

---

## Task 8: Wire AcpxTurnImpl through BoundedEventChannel

**Files:**
- Modify: `src/acp/turn.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/acp/turn.test.ts`:

```ts
test("AcpxTurnImpl: default capacity 256, 257th drop_oldest evicts oldest", async () => {
  // Build a stream of 257 raw frames (raw → drop_oldest_on_full policy).
  const lines: string[] = [];
  for (let i = 0; i < 257; i++) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "_unknown_kind", n: i } },
      }),
    );
  }
  // Terminal result so result resolves and parser closes channel.
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } }));

  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  await turn.result;

  // 256 raw events delivered (oldest evicted).
  expect(got.length).toBe(256);
  expect(got[0]?.kind).toBe("raw");
  // First retained should be n=1 (n=0 was evicted).
  const firstParams = (got[0] as { kind: "raw"; params: { n: number } }).params;
  expect(firstParams.n).toBe(1);
});
```

- [ ] **Step 2: Run test**

Run: `bun test src/acp/turn.test.ts -t "default capacity 256"`
Expected: FAIL — without the channel, all 257 events flow through unbuffered (the consumer holds them via the for-await), so `got.length === 257`. The test's assertion of 256 confirms the channel must be wired.

- [ ] **Step 3: Modify AcpxTurnImpl to use BoundedEventChannel**

Replace `src/acp/turn.ts` body:

```ts
/**
 * AcpxTurn — owns a single prompt's message stream and final result.
 * Constructed by AcpxRuntime from the acpx child's stdout Readable.
 */

import type { Readable } from "node:stream";
import { BoundedEventChannel, type Policy } from "./bounded-channel.js";
import { AcpParser } from "./parser.js";
import type { AcpxTurn, Message, Result } from "./types.js";

const DEFAULT_CHANNEL_CAPACITY = 256;

function classifyMessage(m: Message): Policy {
  switch (m.kind) {
    case "tool_call":
    case "permission_request":
      return "never";
    case "text":
    case "thinking":
      return m.chunk ? "coalesce_text_deltas" : "never";
    case "token_usage":
    case "raw":
      return "drop_oldest_on_full";
    default:
      return "drop_oldest_on_full";
  }
}

function coalesceKeyFor(m: Message): string | null {
  if ((m.kind === "text" || m.kind === "thinking") && m.chunk) return m.kind;
  return null;
}

function coalesceMessage(existing: Message, incoming: Message): Message {
  // Both are guaranteed same-kind chunked text/thinking by classify+key contract.
  if (
    (existing.kind === "text" && incoming.kind === "text") ||
    (existing.kind === "thinking" && incoming.kind === "thinking")
  ) {
    return { ...existing, text: existing.text + incoming.text };
  }
  return existing;
}

function invalidatesCoalesceKeyFor(m: Message): string | null {
  if ((m.kind === "text" || m.kind === "thinking") && !m.chunk) return m.kind;
  return null;
}

export class AcpxTurnImpl implements AcpxTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;
  private readonly cancelFn: () => Promise<void>;
  private readonly parser: AcpParser;
  private readonly channel: BoundedEventChannel<Message>;
  private pendingCancel: Promise<void> | null = null;

  constructor(opts: {
    sessionId: string;
    turnId: string;
    stdout: Readable;
    cancelFn: () => Promise<void>;
    /** Override the default 256-event channel capacity. Pass `Infinity` to bypass eviction. */
    channelCapacity?: number;
  }) {
    this.sessionId = opts.sessionId;
    this.turnId = opts.turnId;
    this.cancelFn = opts.cancelFn;
    this.parser = new AcpParser({
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      stream: opts.stdout,
    });
    this.channel = new BoundedEventChannel<Message>({
      capacity: opts.channelCapacity ?? DEFAULT_CHANNEL_CAPACITY,
      classify: classifyMessage,
      coalesceKey: coalesceKeyFor,
      coalesce: coalesceMessage,
      invalidatesCoalesceKey: invalidatesCoalesceKeyFor,
    });
    this.result = this.parser.result;
    this.messages = this.channel;

    // Pump parser messages into the channel; close channel when result settles.
    void (async () => {
      try {
        for await (const m of this.parser.messages) {
          this.channel.push(m);
        }
      } finally {
        this.channel.close();
      }
    })();
  }

  async cancel(): Promise<void> {
    if (this.parser.settled) return;
    if (this.pendingCancel !== null) return this.pendingCancel;
    const attempt = (async () => {
      try {
        await this.cancelFn();
      } finally {
        this.pendingCancel = null;
      }
    })();
    this.pendingCancel = attempt;
    return attempt;
  }

  async close(): Promise<void> {
    // Parser closes when stdout EOFs; nothing extra to release here.
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/acp/turn.test.ts`
Expected: previously-passing 8 tests still PASS, new "default capacity 256" PASS = 9/9 PASS.

If "EOF without result yields acpx_exit error Result" fails: the channel pump still works (parser EOF → for-await exits → channel.close()), and `result` is `parser.result` directly so `acpx_exit` flows through unchanged. If it fails anyway, inspect the test output.

- [ ] **Step 5: Run full acp suite to catch regressions**

Run: `bun test src/acp/`
Expected: all green (channel + turn + parser + compact + types + watch-turn).

- [ ] **Step 6: Commit**

```bash
git add src/acp/turn.ts src/acp/turn.test.ts
git commit -m "feat(acp): wire AcpxTurnImpl through BoundedEventChannel (#274)"
```

---

## Task 9: AcpxTurnImpl integration tests — Infinity bypass + slow consumer

**Files:**
- Modify: `src/acp/turn.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
test("AcpxTurnImpl: channelCapacity Infinity bypasses eviction", async () => {
  const N = 1000;
  const lines: string[] = [];
  for (let i = 0; i < N; i++) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "_unknown_kind", n: i } },
      }),
    );
  }
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));

  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
    channelCapacity: Infinity,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  await turn.result;
  expect(got.length).toBe(N);
});

test("AcpxTurnImpl: chunked text deltas coalesce under default capacity", async () => {
  // 50 chunked agent_message_chunk frames + final result.
  const lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        },
      }),
    );
  }
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));

  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
    channelCapacity: 4, // small cap forces coalescing under contention
  });

  // Slow consumer: yield control between reads so producer fills the buffer.
  const got: Message[] = [];
  for await (const m of turn.messages) {
    got.push(m);
    await new Promise((r) => setImmediate(r));
  }
  await turn.result;

  // With cap=4 and a slow consumer, all 50 chunked text deltas must merge into
  // a small number of buffered events. Cannot assert exact length (depends on
  // scheduling), but must be far fewer than 50 and the concatenated text length
  // must equal 50 (no character loss).
  expect(got.length).toBeLessThan(50);
  const totalText = got
    .filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text")
    .map((m) => m.text)
    .join("");
  expect(totalText.length).toBe(50);
  expect(totalText).toBe("x".repeat(50));
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/acp/turn.test.ts -t "Infinity bypasses|chunked text deltas coalesce"`
Expected: PASS — wiring from Task 8 already supports both paths. If "chunked text deltas coalesce" fails because all 50 events come through individually, check that the parser is emitting `chunk: true` for `agent_message_chunk` (it is — see `src/acp/parser.ts`).

- [ ] **Step 3: Run full acp suite**

Run: `bun test src/acp/`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/acp/turn.test.ts
git commit -m "test(acp): AcpxTurnImpl Infinity bypass + slow-consumer coalesce (#274)"
```

---

## Task 10: Run full repo test suite + tsc

**Files:** none modified.

- [ ] **Step 1: TypeScript check**

Run: `bun run tsc --noEmit`
Expected: clean (no errors).

If errors surface, they are most likely in:
- `src/acp/turn.ts` — the constructor option type changed (added `channelCapacity?`). Existing callers (`src/core/acpx-runtime.ts:423-437`) pass an object literal; the new field is optional, so no change required. Verify.
- `src/acp/bounded-channel.ts` — fix any strict-mode complaints inline.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all green. The new channel is invisible to existing callers; the only behavioral change is upstream-bounded memory and per-policy drops under sustained pressure.

If any non-acp test fails, investigate. Most likely culprits:
- Tests that asserted exact event counts on long sessions — now bounded to 256 per turn.
- Tests that asserted exact ordering of `token_usage` interleaved with text — `token_usage` is now `drop_oldest_on_full` and may be evicted under pressure. Update assertion to allow drop, or pass `channelCapacity: Infinity` in the test.

- [ ] **Step 3: Commit any test fixes (if needed)**

```bash
git add <files>
git commit -m "test: adjust assertions for bounded channel semantics (#274)"
```

- [ ] **Step 4: Push branch**

```bash
git push -u origin HEAD
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Implementing task |
|---|---|
| Architecture (channel between parser + consumer) | Task 1, Task 8 |
| `BoundedEventChannel<T>` interface (push/close/stats/iterator) | Task 1 |
| `policyAt: Policy[]` parallel ring | Task 1 |
| `coalesceTails: Map<string, number>` | Task 3 |
| ACP policy table (kind → Policy) | Task 8 |
| `coalesce` for text concat | Task 8 |
| `invalidatesCoalesceKey` for chunk:false terminal | Task 3 (test) + Task 8 (wiring) |
| Push: drop_oldest_on_full | Task 2 |
| Push: coalesce_text_deltas | Task 3 |
| Push: never w/ evict-to-fit | Task 4 |
| Push: never w/ no drop-eligible → drop incoming | Task 4 |
| Fast-path: pending resolver | Task 1 + Task 5 (test) |
| Consume: clear coalesce tail on consume | Task 1 + Task 3 (test) |
| Close drains then EOFs | Task 5 |
| Consumer break → channel marks closed | Task 6 |
| Stats accuracy | Task 7 |
| `onDrop` callback firing | Task 2/3/4/7 (tests) |
| AcpxTurnImpl integration (default 256) | Task 8 |
| AcpxTurnImpl integration (Infinity bypass) | Task 9 |
| Slow consumer simulation | Task 9 |
| Existing turn.test.ts stays green | Task 8 |
| Full repo regression | Task 10 |

All spec sections covered.

**Placeholder scan:** No "TBD", "TODO", "implement later" strings in this plan. Every step contains exact file paths, exact code, exact commands, and expected output.

**Type consistency:** `Policy`, `ChannelOptions`, `ChannelStats`, `BoundedEventChannel` names consistent across tasks. ACP callbacks (`classifyMessage`, `coalesceKeyFor`, `coalesceMessage`, `invalidatesCoalesceKeyFor`) defined once in Task 8 and reused. `channelCapacity` option spelled consistently in Tasks 8 and 9.
