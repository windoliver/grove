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
