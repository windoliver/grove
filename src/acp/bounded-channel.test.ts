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
  expect(byKind.delta_a).toBe("aaaaa");
  expect(byKind.delta_b).toBe("bbbbb");
});

test("coalesce tail invalidated on consume: next delta starts new entry", async () => {
  const ch = makeChannel(8);
  ch.push({ kind: "delta_a", id: 1, text: "a" });
  ch.push({ kind: "delta_a", id: 2, text: "b" });
  const it = ch[Symbol.asyncIterator]();
  const first = await it.next();
  expect(first.value.text).toBe("ab");
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
  ch.push({ kind: "terminal_a", id: 3 });
  ch.push({ kind: "delta_a", id: 4, text: "c" });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got).toHaveLength(3);
  expect(got[0]?.text).toBe("ab");
  expect(got[1]?.kind).toBe("terminal_a");
  expect(got[2]?.text).toBe("c");
});

test("never policy evicts oldest drop-eligible to make room", async () => {
  const cap = 4;
  const ch = new BoundedEventChannel<TestEvent>({ capacity: cap, classify });
  for (let i = 1; i <= cap; i++) ch.push({ kind: "drop", id: i });
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
  for (let i = 1; i <= cap; i++) ch.push({ kind: "keep", id: i });
  ch.push({ kind: "keep", id: 99 });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([1, 2, 3]);
  expect(dropped.map((e) => e.id)).toEqual([99]);
  expect(ch.stats().droppedByPolicy.get("never")).toBe(1);
});

test("iterator awaiting empty: push resolves directly without buffering", async () => {
  const ch = makeChannel(4);
  const it = ch[Symbol.asyncIterator]();
  const nextP = it.next();
  ch.push({ kind: "drop", id: 1 });
  const r = await nextP;
  expect(r.value.id).toBe(1);
  // Verify fast-path: cap=1 channel can sustain push-while-pending without eviction.
  const ch2 = new BoundedEventChannel<TestEvent>({ capacity: 1, classify });
  const it2 = ch2[Symbol.asyncIterator]();
  const p1 = it2.next();
  ch2.push({ kind: "drop", id: 1 });
  expect((await p1).value.id).toBe(1);
  const p2 = it2.next();
  ch2.push({ kind: "drop", id: 2 });
  expect((await p2).value.id).toBe(2);
  expect(ch2.stats().evicted).toBe(0);
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

test("consumer break: subsequent pushes drop silently and channel marks closed", async () => {
  const dropped: TestEvent[] = [];
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: 4,
    classify,
    onDrop: (e, reason) => {
      if (reason === "closed") dropped.push(e);
    },
  });
  ch.push({ kind: "drop", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  for await (const e of ch) {
    expect(e.id).toBe(1);
    break;
  }
  ch.push({ kind: "drop", id: 3 });
  ch.push({ kind: "keep", id: 4 });
  expect(dropped.map((e) => e.id)).toEqual([3, 4]);
});

test("iterator return() while next() pending resolves the pending promise", async () => {
  const ch = makeChannel(4);
  const it = ch[Symbol.asyncIterator]();
  const nextP = it.next();
  // Trigger return() while next() is pending.
  await it.return?.();
  const r = await nextP;
  expect(r.done).toBe(true);
});

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

  ch.push({ kind: "delta_a", id: 1, text: "a" });
  ch.push({ kind: "delta_a", id: 2, text: "b" });
  ch.push({ kind: "delta_a", id: 3, text: "c" });
  ch.push({ kind: "drop", id: 4 });
  ch.push({ kind: "drop", id: 5 });
  ch.push({ kind: "keep", id: 6 });
  ch.push({ kind: "keep", id: 7 });
  ch.push({ kind: "keep", id: 8 });

  const s = ch.stats();
  expect(s.pushed).toBe(8);
  expect(s.coalesced).toBe(2);
  expect(s.evicted).toBe(2);
  expect(s.droppedByPolicy.get("never")).toBe(1);

  expect(reasons).toEqual([
    { id: 2, reason: "coalesced" },
    { id: 3, reason: "coalesced" },
    { id: 4, reason: "evicted" },
    { id: 5, reason: "evicted" },
    { id: 8, reason: "no_capacity" },
  ]);
});

// --- Codex adversarial-review regressions (#274 round 1) ---

test("REGRESSION: coalesce-new-key on full buffer must not overflow ring", async () => {
  // Cap=2. Fill with two drop_oldest events. Push a coalesce-new-key delta.
  // Without the bounded-full guard, _appendTail would write past tail and
  // size would exceed capacity, leaving an undefined slot.
  const cap = 2;
  const ch = makeChannel(cap);
  ch.push({ kind: "drop", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  // New coalesce key with no existing tail. Must evict drop-eligible (id=1).
  ch.push({ kind: "delta_a", id: 3, text: "x" });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  // Ring must remain bounded: exactly cap=2 events delivered, no undefineds.
  expect(got.length).toBe(2);
  for (const e of got) expect(e).toBeDefined();
  expect(got.map((e) => e.id)).toEqual([2, 3]);
});

test("REGRESSION: coalesce-new-key when no drop-eligible victim drops incoming", async () => {
  // Cap=2. Fill with two never-policy events. Push a coalesce-new-key delta.
  // No drop-eligible victim exists → incoming must be dropped, not buffered.
  const cap = 2;
  const dropped: TestEvent[] = [];
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: cap,
    classify,
    coalesceKey,
    coalesce,
    invalidatesCoalesceKey,
    onDrop: (e, reason) => {
      if (reason === "no_capacity") dropped.push(e);
    },
  });
  ch.push({ kind: "keep", id: 1 });
  ch.push({ kind: "keep", id: 2 });
  ch.push({ kind: "delta_a", id: 99, text: "x" });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([1, 2]);
  expect(dropped.map((e) => e.id)).toEqual([99]);
  expect(ch.stats().droppedByPolicy.get("coalesce_text_deltas")).toBe(1);
});

test("REGRESSION: drop_oldest_on_full must not evict a never-policy event at head", async () => {
  // Cap=2. keep (never) + drop (drop_oldest_on_full). Push another drop.
  // Naive head-eviction would drop `keep`. Policy-aware logic must evict
  // the drop-eligible slot (id=2) and preserve the never event (id=1).
  const cap = 2;
  const evicted: TestEvent[] = [];
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: cap,
    classify,
    onDrop: (e, reason) => {
      if (reason === "evicted") evicted.push(e);
    },
  });
  ch.push({ kind: "keep", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  ch.push({ kind: "drop", id: 3 });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([1, 3]);
  expect(evicted.map((e) => e.id)).toEqual([2]);
});

test("REGRESSION: dropped never-event must NOT invalidate coalesce tail", async () => {
  // cap=2. delta_a + drop. Then push a terminal_a (never-policy) — buffer
  // is full and drop-eligible victim exists, so terminal_a evicts the drop
  // event and IS buffered. That's the happy path. Now contrast: cap=2,
  // delta_a + keep (both never-policy + coalesce-buffered). Push terminal_a:
  // no drop-eligible victim → terminal_a is dropped. The delta_a tail must
  // remain valid so subsequent delta_a chunks coalesce into it.
  const cap = 2;
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: cap,
    classify,
    coalesceKey,
    coalesce,
    invalidatesCoalesceKey,
  });
  ch.push({ kind: "delta_a", id: 1, text: "a" });
  ch.push({ kind: "keep", id: 2 });
  // Buffer = [delta_a-tail, keep]. No drop-eligible. terminal_a is dropped.
  ch.push({ kind: "terminal_a", id: 99 });
  // Subsequent delta_a chunk MUST coalesce into the prior tail (id=1).
  ch.push({ kind: "delta_a", id: 3, text: "b" });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  // 2 events: the merged delta_a "ab" + the keep event.
  expect(got.length).toBe(2);
  const deltaEvent = got.find((e) => e.kind === "delta_a");
  expect(deltaEvent?.text).toBe("ab");
  expect(ch.stats().coalesced).toBe(1);
  expect(ch.stats().droppedByPolicy.get("never")).toBe(1);
});

test("REGRESSION: concurrent next() calls all resolve in FIFO order (no lost wakeups)", async () => {
  const ch = makeChannel(8);
  const it = ch[Symbol.asyncIterator]();
  // Issue 3 next() calls before any push — all must enqueue.
  const p1 = it.next();
  const p2 = it.next();
  const p3 = it.next();
  ch.push({ kind: "drop", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  ch.push({ kind: "drop", id: 3 });
  const r1 = await p1;
  const r2 = await p2;
  const r3 = await p3;
  expect(r1.value.id).toBe(1);
  expect(r2.value.id).toBe(2);
  expect(r3.value.id).toBe(3);
});

test("REGRESSION: return() is an abort fence — discards backlog (no replay via next() or new iterator)", async () => {
  const ch = makeChannel(8);
  ch.push({ kind: "drop", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  ch.push({ kind: "drop", id: 3 });
  // Consume one event, then abort via return().
  const it = ch[Symbol.asyncIterator]();
  const first = await it.next();
  expect(first.value.id).toBe(1);
  await it.return?.();
  // Same iterator: subsequent next() must NOT yield events 2 or 3.
  const after = await it.next();
  expect(after.done).toBe(true);
  // Fresh iterator: must also see channel as drained + closed.
  const it2 = ch[Symbol.asyncIterator]();
  const fresh = await it2.next();
  expect(fresh.done).toBe(true);
});

test("REGRESSION: close() resolves ALL pending next() callers as done", async () => {
  const ch = makeChannel(8);
  const it = ch[Symbol.asyncIterator]();
  const p1 = it.next();
  const p2 = it.next();
  ch.close();
  const r1 = await p1;
  const r2 = await p2;
  expect(r1.done).toBe(true);
  expect(r2.done).toBe(true);
});

test("REGRESSION: drop_oldest_on_full with no drop-eligible victim drops incoming", async () => {
  // Cap=2. Two never events. Incoming drop event has nothing eligible to
  // evict — must drop incoming, never the never events.
  const cap = 2;
  const dropped: TestEvent[] = [];
  const ch = new BoundedEventChannel<TestEvent>({
    capacity: cap,
    classify,
    onDrop: (e, reason) => {
      if (reason === "no_capacity") dropped.push(e);
    },
  });
  ch.push({ kind: "keep", id: 1 });
  ch.push({ kind: "keep", id: 2 });
  ch.push({ kind: "drop", id: 99 });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([1, 2]);
  expect(dropped.map((e) => e.id)).toEqual([99]);
  expect(ch.stats().droppedByPolicy.get("drop_oldest_on_full")).toBe(1);
});
