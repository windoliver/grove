import { expect, test } from "bun:test";
import type { Message, Result } from "../../acp/types.js";
import type { AcpSinkEvent, SessionRecord, TurnRecord } from "./acp-session-store.js";
import { AcpSessionStore } from "./acp-session-store.js";

test("TurnRecord holds ordered messages and optional close metadata", () => {
  const msg: Message = { kind: "text", turnId: "t1", text: "hi", chunk: true };
  const rec: TurnRecord = {
    turnId: "t1",
    sessionId: "s1",
    messages: [msg],
    startedAt: 1,
    droppedMessageCount: 0,
  };
  expect(rec.turnId).toBe("t1");
  expect(rec.closedAt).toBeUndefined();
});

test("SessionRecord groups turns by turnId", () => {
  const sess: SessionRecord = {
    sessionId: "s1",
    registeredAt: 1,
    turns: new Map(),
    droppedTurnCount: 0,
  };
  expect(sess.turns.size).toBe(0);
});

test("AcpSinkEvent discriminates by kind", () => {
  const msgEv: AcpSinkEvent = {
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  };
  const resultEv: AcpSinkEvent = {
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" } satisfies Result,
  };
  expect(msgEv.kind).toBe("message");
  expect(resultEv.kind).toBe("result");
});

test("ingest drops events whose sessionId is not registered", () => {
  const store = new AcpSessionStore();
  store.ingest({
    kind: "message",
    sessionId: "s-unreg",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
  });
  expect(store.getSession("s-unreg")).toBeUndefined();
});

test("ingest appends messages for a registered session", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
  });
  const turn = store.getTurn("s1", "t1");
  expect(turn).toBeDefined();
  expect(turn?.messages).toHaveLength(1);
  expect(store.getSession("s1")?.latestTurnId).toBe("t1");
});

test("ingest closes a turn on result and records stopReason", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "cancelled" },
  });
  const turn = store.getTurn("s1", "t1");
  expect(turn?.closedAt).toBeDefined();
  expect(turn?.stopReason).toBe("cancelled");
});

test("ingest drops messages arriving after the turn's Result", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "late", chunk: true },
  });
  expect(store.getTurn("s1", "t1")?.messages).toHaveLength(0);
});

test("unregister drops the session and its turns", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
  });
  store.unregister("s1");
  expect(store.getSession("s1")).toBeUndefined();
});

test("subscribe notifies listeners when a turn gains a message", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  let notified = 0;
  store.subscribe("s1", () => {
    notified += 1;
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  });
  // Batched flush is 16ms; wait for it to fire.
  await new Promise((r) => setTimeout(r, 25));
  expect(notified).toBeGreaterThanOrEqual(1);
});

test("subscribe batches multiple ingests into a single notification", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  let notified = 0;
  store.subscribe("s1", () => {
    notified += 1;
  });
  for (let i = 0; i < 5; i++) {
    store.ingest({
      kind: "message",
      sessionId: "s1",
      turnId: "t1",
      message: { kind: "text", turnId: "t1", text: String(i), chunk: true },
    });
  }
  await new Promise((r) => setTimeout(r, 25));
  expect(notified).toBe(1);
});

test("subscribe returns an unsubscribe function", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  let notified = 0;
  const unsub = store.subscribe("s1", () => {
    notified += 1;
  });
  unsub();
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  });
  await new Promise((r) => setTimeout(r, 25));
  expect(notified).toBe(0);
});

test("unregister notifies subscribers once before dropping the session", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const calls: string[] = [];
  store.subscribe("s1", (sid) => calls.push(sid));
  store.unregister("s1");
  expect(calls).toEqual(["s1"]);
});

test("ingest preserves Result.error on the closed turn", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: {
      turnId: "t1",
      stopReason: "error",
      error: { code: "publish_failed", message: "nexus 500" },
    },
  });
  const turn = store.getTurn("s1", "t1");
  expect(turn?.stopReason).toBe("error");
  expect(turn?.error).toEqual({ code: "publish_failed", message: "nexus 500" });
  expect(store.getSession("s1")?.latestTurnId).toBe("t1");
});

test("dispose clears timer + maps so scheduled flushes cannot fire", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  let notified = 0;
  store.subscribe("s1", () => {
    notified += 1;
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  });
  store.dispose();
  await new Promise((r) => setTimeout(r, 25));
  expect(notified).toBe(0);
  expect(store.getSession("s1")).toBeUndefined();
  // Calling dispose twice must be idempotent.
  expect(() => store.dispose()).not.toThrow();
});

test("evicts oldest messages once a turn exceeds maxMessagesPerTurn (bounded retention)", () => {
  const store = new AcpSessionStore({ maxMessagesPerTurn: 3 });
  store.register("s1");
  for (let i = 0; i < 5; i++) {
    store.ingest({
      kind: "message",
      sessionId: "s1",
      turnId: "t1",
      message: { kind: "text", turnId: "t1", text: `m${i}`, chunk: true },
    });
  }
  const turn = store.getTurn("s1", "t1");
  expect(turn?.messages).toHaveLength(3);
  expect(turn?.droppedMessageCount).toBe(2);
  // FIFO: the surviving tail is the three most recent messages.
  expect(turn?.messages.map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["m2", "m3", "m4"]);
});

test("evicts oldest CLOSED turns when session exceeds maxTurnsPerSession", () => {
  const store = new AcpSessionStore({ maxTurnsPerSession: 3 });
  store.register("s1");
  // Close three turns so all are eligible for eviction; the fourth is
  // also closed (so the third can evict cleanly). Eviction runs on the
  // insert path so we need a 5th turn to trigger it.
  for (let i = 0; i < 5; i++) {
    const turnId = `t${i}`;
    store.ingest({
      kind: "message",
      sessionId: "s1",
      turnId,
      message: { kind: "text", turnId, text: "x", chunk: true },
    });
    store.ingest({
      kind: "result",
      sessionId: "s1",
      turnId,
      result: { turnId, stopReason: "end_turn" },
    });
  }
  const sess = store.getSession("s1");
  expect(sess?.turns.size).toBeLessThanOrEqual(3);
  expect(sess?.droppedTurnCount).toBeGreaterThanOrEqual(2);
  // Oldest closed turns are the ones dropped — newest survive.
  expect(sess?.turns.has("t4")).toBe(true);
});

test("session eviction never drops the active (still-open) turn", () => {
  const store = new AcpSessionStore({ maxTurnsPerSession: 2 });
  store.register("s1");
  // Close three prior turns.
  for (let i = 0; i < 3; i++) {
    store.ingest({
      kind: "result",
      sessionId: "s1",
      turnId: `closed-${i}`,
      result: { turnId: `closed-${i}`, stopReason: "end_turn" },
    });
  }
  // Add a 4th turn that is still RUNNING (no result). It must not be
  // evicted even though it was just inserted and the cap is 2 — active
  // turns are never candidates for the session-level drop.
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "active",
    message: { kind: "text", turnId: "active", text: "live", chunk: true },
  });
  expect(store.getTurn("s1", "active")).toBeDefined();
});

test("session cap is a HARD cap: evicts oldest OPEN turns when all are running", () => {
  // Under missed result delivery every turn stays open. The cap must
  // still hold — otherwise session.turns.size grows unboundedly.
  const store = new AcpSessionStore({ maxTurnsPerSession: 2 });
  store.register("s1");
  for (let i = 0; i < 5; i++) {
    store.ingest({
      kind: "message",
      sessionId: "s1",
      turnId: `open-${i}`,
      message: { kind: "text", turnId: `open-${i}`, text: "x", chunk: true },
    });
  }
  const sess = store.getSession("s1");
  expect(sess?.turns.size).toBeLessThanOrEqual(2);
  expect(sess?.droppedTurnCount).toBeGreaterThanOrEqual(3);
  // The latest open turn is always preserved even when the cap forces
  // eviction of other open turns.
  expect(sess?.turns.has("open-4")).toBe(true);
});

test("late result for an older turn does NOT rewind latestTurnId", () => {
  // Scenario from Codex Round 7 Finding 1: a stale/duplicate result
  // landing on an older turn must not advance latestTurnId backward,
  // because turn-cap eviction protects latestTurnId — rewinding would
  // let the cap drop the newer in-flight turn.
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t2",
    message: { kind: "text", turnId: "t2", text: "b", chunk: true },
  });
  expect(store.getSession("s1")?.latestTurnId).toBe("t2");
  // Late stale result for t1 — must not rewind.
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(store.getSession("s1")?.latestTurnId).toBe("t2");
});

test("cap does not evict a fresh turn due to late-result latestTurnId rewind", () => {
  // Codex Round 7 Finding 1 direct repro: cap=2, close t1, start t2,
  // late stale t1 result, then create t3. Expected: t2 survives; t1 is
  // evicted (oldest closed). Previously the rewind let t2 be evicted.
  const store = new AcpSessionStore({ maxTurnsPerSession: 2 });
  store.register("s1");
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t2",
    message: { kind: "text", turnId: "t2", text: "live", chunk: true },
  });
  // Late duplicate result for t1 — must not change latestTurnId.
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  // New turn t3 triggers eviction. t2 (the active) must survive.
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t3",
    message: { kind: "text", turnId: "t3", text: "new", chunk: true },
  });
  const sess = store.getSession("s1");
  expect(sess?.turns.has("t2")).toBe(true);
  expect(sess?.turns.has("t3")).toBe(true);
  expect(sess?.latestTurnId).toBe("t3");
});

test("stale result for an UNKNOWN turn does not hijack latestTurnId when a latest already exists", () => {
  // Codex Round 8 Finding 1: a stale or out-of-order result for a
  // never-seen (or long-evicted) turn must not steal latestTurnId from
  // the currently-active turn. Only brand-new sessions promote on a
  // result-first event.
  const store = new AcpSessionStore();
  store.register("s1");
  // Establish two message-driven turns.
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t2",
    message: { kind: "text", turnId: "t2", text: "b", chunk: true },
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t3",
    message: { kind: "text", turnId: "t3", text: "c", chunk: true },
  });
  expect(store.getSession("s1")?.latestTurnId).toBe("t3");
  // A stale result for a turn the store has NEVER seen.
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t0",
    result: { turnId: "t0", stopReason: "end_turn" },
  });
  expect(store.getSession("s1")?.latestTurnId).toBe("t3");
});

test("stale result for an unseen turn cannot evict live turns under cap pressure", () => {
  // Codex Round 9 Finding 2: with cap=2 and two live turns, a stale
  // result for a never-seen turn must not be allowed to create a
  // TurnRecord and trigger cap eviction of a live turn.
  const store = new AcpSessionStore({ maxTurnsPerSession: 2 });
  store.register("s1");
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "live-1",
    message: { kind: "text", turnId: "live-1", text: "a", chunk: true },
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "live-2",
    message: { kind: "text", turnId: "live-2", text: "b", chunk: true },
  });
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "stale-x",
    result: { turnId: "stale-x", stopReason: "end_turn" },
  });
  const sess = store.getSession("s1");
  expect(sess?.turns.has("live-1")).toBe(true);
  expect(sess?.turns.has("live-2")).toBe(true);
  expect(sess?.turns.has("stale-x")).toBe(false);
  expect(sess?.latestTurnId).toBe("live-2");
});
