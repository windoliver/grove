import { expect, test } from "bun:test";
import type { Message, Result } from "../../acp/types.js";
import type { GroveEvent } from "../../core/event-bus.js";
import { createAcpMessageSink } from "./acp-message-sink.js";
import { AcpSessionStore } from "./acp-session-store.js";

function messageEvent(sessionId: string, turnId: string, message: Message): GroveEvent {
  return {
    type: "acp.message",
    sourceRole: "coder",
    targetRole: "tui",
    payload: { sessionId, turnId, message },
    timestamp: new Date().toISOString(),
  };
}

function resultEvent(sessionId: string, turnId: string, result: Result): GroveEvent {
  return {
    type: "acp.result",
    sourceRole: "coder",
    targetRole: "tui",
    payload: { sessionId, turnId, result },
    timestamp: new Date().toISOString(),
  };
}

test("routes acp.message to store.ingest as a message event", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent(
    messageEvent("s1", "t1", { kind: "text", turnId: "t1", text: "hi", chunk: true }),
  );
  expect(store.getTurn("s1", "t1")?.messages).toHaveLength(1);
});

test("routes acp.result to store.ingest as a result event", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent(resultEvent("s1", "t1", { turnId: "t1", stopReason: "end_turn" }));
  expect(store.getTurn("s1", "t1")?.stopReason).toBe("end_turn");
});

test("ignores non-acp event types", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "contribution",
    sourceRole: "coder",
    targetRole: "reviewer",
    payload: { message_id: "x" },
    timestamp: new Date().toISOString(),
  });
  expect(store.getSession("s1")?.turns.size).toBe(0);
});

test("drops malformed acp.message payloads (missing sessionId)", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "acp.message",
    sourceRole: "coder",
    targetRole: "tui",
    payload: { turnId: "t1", message: { kind: "text", turnId: "t1", text: "x", chunk: true } },
    timestamp: new Date().toISOString(),
  });
  expect(store.getSession("s1")?.turns.size).toBe(0);
});

test("drops malformed acp.result payloads (missing result field)", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "acp.result",
    sourceRole: "coder",
    targetRole: "tui",
    payload: { sessionId: "s1", turnId: "t1" },
    timestamp: new Date().toISOString(),
  });
  expect(store.getTurn("s1", "t1")).toBeUndefined();
});

test("rejects acp.message whose message.kind is not a known Message kind", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "acp.message",
    sourceRole: "coder",
    targetRole: "tui",
    // A Result-shaped object leaking into an acp.message envelope must NOT
    // reach the store — downstream projectors switch on message.kind.
    payload: {
      sessionId: "s1",
      turnId: "t1",
      message: { kind: "result", turnId: "t1", stopReason: "end_turn" },
    },
    timestamp: new Date().toISOString(),
  });
  expect(store.getTurn("s1", "t1")).toBeUndefined();
});

test("rejects acp.result whose stopReason is unknown", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "acp.result",
    sourceRole: "coder",
    targetRole: "tui",
    payload: {
      sessionId: "s1",
      turnId: "t1",
      result: { turnId: "t1", stopReason: "not_a_real_reason" },
    },
    timestamp: new Date().toISOString(),
  });
  expect(store.getTurn("s1", "t1")).toBeUndefined();
});

test("drops acp.message with null payload without throwing", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  expect(() =>
    sink.handleGroveEvent({
      type: "acp.message",
      sourceRole: "coder",
      targetRole: "tui",
      payload: null as unknown as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    }),
  ).not.toThrow();
  expect(store.getSession("s1")?.turns.size).toBe(0);
});

test("drops acp.message when envelope turnId disagrees with message.turnId", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "acp.message",
    sourceRole: "coder",
    targetRole: "tui",
    payload: {
      sessionId: "s1",
      turnId: "t1",
      // Envelope turnId is "t1" but message.turnId is "t2" — a malformed
      // event that could close/mutate the wrong turn if ingested.
      message: { kind: "text", turnId: "t2", text: "drift", chunk: true },
    },
    timestamp: new Date().toISOString(),
  });
  expect(store.getSession("s1")?.turns.size).toBe(0);
});

test("drops acp.result when envelope turnId disagrees with result.turnId", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "acp.result",
    sourceRole: "coder",
    targetRole: "tui",
    payload: {
      sessionId: "s1",
      turnId: "t1",
      result: { turnId: "t2", stopReason: "end_turn" },
    },
    timestamp: new Date().toISOString(),
  });
  expect(store.getTurn("s1", "t1")).toBeUndefined();
});
