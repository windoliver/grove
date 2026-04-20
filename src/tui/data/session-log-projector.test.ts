/**
 * SessionLogProjector tests — Message → LogLine projection.
 */

import { expect, test } from "bun:test";
import type { Message, Result } from "../../acp/types.js";
import { AcpSessionStore } from "./acp-session-store.js";
import { AgentLogBuffer } from "./agent-log-buffer.js";
import {
  messageToLogLine,
  projectSessionToBuffer,
  resultToLogLine,
} from "./session-log-projector.js";

// ─── Unit tests ───

test("text message projects to an output LogLine", () => {
  const m: Message = { kind: "text", turnId: "t1", text: "hello", chunk: true };
  const ll = messageToLogLine(m);
  expect(ll).toEqual({ ts: expect.any(Number), line: "hello", type: "output" });
});

test("thinking message projects with a (thinking) prefix", () => {
  const m: Message = { kind: "thinking", turnId: "t1", text: "hmm", chunk: true };
  const ll = messageToLogLine(m);
  expect(ll?.line).toBe("(thinking) hmm");
  expect(ll?.type).toBe("output");
});

test("tool_call projects to a tool-type LogLine with status", () => {
  const m: Message = {
    kind: "tool_call",
    turnId: "t1",
    toolCall: { id: "tc1", name: "bash", status: "completed", input: {} },
  };
  const ll = messageToLogLine(m);
  expect(ll?.line).toBe("[tool] bash (completed)");
  expect(ll?.type).toBe("tool");
});

test("permission_request projects to a [perm] line", () => {
  const m: Message = {
    kind: "permission_request",
    turnId: "t1",
    request: { id: "p1", tool: "bash", input: {} },
  };
  const ll = messageToLogLine(m);
  expect(ll?.line).toBe("[perm] bash");
});

test("token_usage is skipped in the projection", () => {
  const m: Message = {
    kind: "token_usage",
    turnId: "t1",
    usage: { inputTokens: 1, outputTokens: 2 },
  };
  expect(messageToLogLine(m)).toBeUndefined();
});

test("raw messages project with [raw:<acpMethod>]", () => {
  const m: Message = { kind: "raw", turnId: "t1", acpMethod: "session/update:x", params: {} };
  const ll = messageToLogLine(m);
  expect(ll?.line).toBe("[raw:session/update:x]");
});

test("result projects to a turn-type LogLine with stopReason", () => {
  const r: Result = { turnId: "t1", stopReason: "cancelled" };
  const ll = resultToLogLine(r);
  expect(ll.line).toBe("[cancelled]");
  expect(ll.type).toBe("turn");
});

// ─── Integration tests ───

test("projectSessionToBuffer pushes messages as they arrive and emits a turn line on close", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const buffer = new AgentLogBuffer("coder", "s1");
  const unsub = projectSessionToBuffer(store, "s1", buffer);

  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
  });
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  await new Promise((r) => setTimeout(r, 25));

  const lines = buffer.toArray();
  expect(lines.map((l) => l.line)).toEqual(["hi", "[end_turn]"]);
  unsub();
});

test("projectSessionToBuffer does not double-emit on repeated notifications", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const buffer = new AgentLogBuffer("coder", "s1");
  projectSessionToBuffer(store, "s1", buffer);

  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "b", chunk: true },
  });
  await new Promise((r) => setTimeout(r, 25));
  expect(buffer.toArray().map((l) => l.line)).toEqual(["a", "b"]);
});

test("projector cursor survives retention eviction (absolute sequence numbers)", async () => {
  // The projector flush is batched at 16ms, so by the time it first
  // drains, the store has already evicted old messages past the cap.
  // Messages lost before any projection are genuinely gone — but the
  // survivors must be projected exactly once with no misalignment from
  // the shifted array, and subsequent ingests must not double-count or
  // skip the new tail.
  const store = new AcpSessionStore({ maxMessagesPerTurn: 3 });
  store.register("s1");
  const buffer = new AgentLogBuffer("coder", "s1");
  const unsub = projectSessionToBuffer(store, "s1", buffer);
  for (let i = 0; i < 5; i++) {
    store.ingest({
      kind: "message",
      sessionId: "s1",
      turnId: "t1",
      message: { kind: "text", turnId: "t1", text: `m${i}`, chunk: true },
    });
  }
  await new Promise((r) => setTimeout(r, 25));
  // First flush sees the surviving tail [m2, m3, m4] and projects it.
  expect(buffer.toArray().map((l) => l.line)).toEqual(["m2", "m3", "m4"]);

  // New ingest triggers another eviction: the tail becomes [m3, m4, m5].
  // The projector must push only m5 — not re-push m3/m4 (would happen if
  // cursor collapsed to index 0 after eviction) and not skip m5 (would
  // happen if cursor stayed ahead of the shrunken array length).
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "m5", chunk: true },
  });
  await new Promise((r) => setTimeout(r, 25));
  expect(buffer.toArray().map((l) => l.line)).toEqual(["m2", "m3", "m4", "m5"]);
  unsub();
});
