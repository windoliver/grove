import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { compactTurn } from "./compact.js";
import { AcpParser } from "./parser.js";
import type { Message, Result } from "./types.js";

test("compactTurn folds text chunks into a single assistant message", () => {
  const msgs: Message[] = [
    { kind: "text", turnId: "t1", text: "Hel", chunk: true },
    { kind: "text", turnId: "t1", text: "lo", chunk: true },
  ];
  const result: Result = { turnId: "t1", stopReason: "end_turn" };
  const snap = compactTurn({ turnId: "t1", messages: msgs, result });
  expect(snap.assistantText).toBe("Hello");
});

test("compactTurn folds tool-call lifecycle into final ToolCall record", () => {
  const msgs: Message[] = [
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", name: "bash", status: "pending", input: {} },
    },
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", name: "bash", status: "in_progress", input: {} },
    },
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", name: "bash", status: "completed", input: {}, output: "ok" },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.toolCalls).toHaveLength(1);
  expect(snap.toolCalls[0]?.status).toBe("completed");
  expect(snap.toolCalls[0]?.output).toBe("ok");
});

test("compactTurn is idempotent", () => {
  const msgs: Message[] = [{ kind: "text", turnId: "t1", text: "Hi", chunk: true }];
  const result: Result = { turnId: "t1", stopReason: "end_turn" };
  const a = compactTurn({ turnId: "t1", messages: msgs, result });
  const b = compactTurn({ turnId: "t1", messages: msgs, result });
  expect(a).toEqual(b);
});

test("compactTurn preserves name/input from initial tool_call across partial updates", () => {
  // Simulates the Claude wire shape: initial tool_call has the real name + input,
  // tool_call_update frames only carry status/output.
  const msgs: Message[] = [
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", name: "Read", status: "pending", input: { path: "/etc/hostname" } },
    },
    { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", status: "in_progress" } },
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", status: "completed", output: "myhost" },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.toolCalls).toHaveLength(1);
  expect(snap.toolCalls[0]?.name).toBe("Read");
  expect(snap.toolCalls[0]?.input).toEqual({ path: "/etc/hostname" });
  expect(snap.toolCalls[0]?.status).toBe("completed");
  expect(snap.toolCalls[0]?.output).toBe("myhost");
});

test("compactTurn status is monotonic — later pending never regresses completed", () => {
  const msgs: Message[] = [
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", name: "bash", status: "completed", input: {} },
    },
    { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", status: "pending" } },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.toolCalls[0]?.status).toBe("completed");
});

test("compactTurn prefers result.usage (canonical) over usage_update (advisory)", () => {
  const msgs: Message[] = [
    { kind: "token_usage", turnId: "t1", usage: { inputTokens: 999999, outputTokens: 999999 } },
  ];
  const result: Result = {
    turnId: "t1",
    stopReason: "end_turn",
    usage: {
      inputTokens: 3,
      outputTokens: 4,
      cachedReadTokens: 0,
      cachedWriteTokens: 21907,
      totalTokens: 21914,
    },
  };
  const snap = compactTurn({ turnId: "t1", messages: msgs, result });
  expect(snap.usage?.inputTokens).toBe(3);
  expect(snap.usage?.outputTokens).toBe(4);
  expect(snap.usage?.totalTokens).toBe(21914);
});

test("compactTurn falls back to usage_update when result has no usage", () => {
  const msgs: Message[] = [
    { kind: "token_usage", turnId: "t1", usage: { inputTokens: 100, outputTokens: 50 } },
  ];
  const result: Result = { turnId: "t1", stopReason: "end_turn" };
  const snap = compactTurn({ turnId: "t1", messages: msgs, result });
  expect(snap.usage?.inputTokens).toBe(100);
  expect(snap.usage?.outputTokens).toBe(50);
});

test("claude-tool-call fixture compacts to real tool names, not placeholders", async () => {
  const fixture = await Bun.file("tests/fixtures/acp/claude-tool-call.ndjson").text();
  const parser = new AcpParser({
    sessionId: "s1",
    turnId: "t-fixture",
    stream: Readable.from([fixture]),
  });
  const messages: Message[] = [];
  for await (const m of parser.messages) messages.push(m);
  const result = await parser.result;
  const snap = compactTurn({ turnId: "t-fixture", messages, result });

  // Every finalized tool call must have a real name (not the parser default "")
  // and a non-empty input; both were being clobbered by the old last-write-wins merge.
  expect(snap.toolCalls.length).toBeGreaterThan(0);
  for (const tc of snap.toolCalls) {
    expect(tc.name).not.toBe("");
    expect(tc.name).not.toBe("tool_call_update");
    expect(tc.input).not.toEqual({});
  }
});

test("claude-simple fixture canonical usage comes from result.usage, not usage_update", async () => {
  const fixture = await Bun.file("tests/fixtures/acp/claude-simple.ndjson").text();
  const parser = new AcpParser({
    sessionId: "s1",
    turnId: "t-fixture",
    stream: Readable.from([fixture]),
  });
  const messages: Message[] = [];
  for await (const m of parser.messages) messages.push(m);
  const result = await parser.result;
  const snap = compactTurn({ turnId: "t-fixture", messages, result });

  // Real claude fixture: result.usage is {inputTokens:3, outputTokens:4, ...}.
  // usage_update advisory has much larger context-window values.
  expect(snap.usage?.inputTokens).toBeLessThan(100);
  expect(snap.usage?.outputTokens).toBeLessThan(100);
  expect(snap.usage?.totalTokens).toBeGreaterThan(0);
});
