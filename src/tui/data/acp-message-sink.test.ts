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
