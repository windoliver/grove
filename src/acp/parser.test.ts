import { expect, test } from "bun:test";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AcpParser, parseAcpLine } from "./parser.js";
import type { Message } from "./types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dir, "../../tests/fixtures/acp");

async function loadFixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES_DIR, name)).text();
}

function readableFromString(s: string): Readable {
  return Readable.from([s]);
}

// ---------------------------------------------------------------------------
// parseAcpLine unit tests
// ---------------------------------------------------------------------------

test("parseAcpLine: text chunk → Message{kind:text}", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "test-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" },
      },
    },
  });
  const parsed = parseAcpLine(line, "turn-1");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  const msg = parsed.message;
  expect(msg.kind).toBe("text");
  if (msg.kind !== "text") throw new Error("unreachable");
  expect(msg.text).toBe("hello world");
  expect(msg.chunk).toBe(true);
  expect(msg.turnId).toBe("turn-1");
});

test("parseAcpLine: result frame → ParsedLine{kind:result}", () => {
  const line = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
  const parsed = parseAcpLine(line, "turn-1");
  expect(parsed.kind).toBe("result");
  if (parsed.kind !== "result") throw new Error("unreachable");
  expect(parsed.result.stopReason).toBe("end_turn");
  expect(parsed.result.turnId).toBe("turn-1");
});

test("parseAcpLine: unknown sessionUpdate → raw message", () => {
  const update = { sessionUpdate: "some_future_event", data: { x: 1 } };
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update },
  });
  const parsed = parseAcpLine(line, "turn-x");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  const msg = parsed.message;
  expect(msg.kind).toBe("raw");
  if (msg.kind !== "raw") throw new Error("unreachable");
  expect(msg.acpMethod).toBe("some_future_event");
  expect(msg.turnId).toBe("turn-x");
});

test("parseAcpLine: malformed JSON → raw{acpMethod:'_parseError'}", () => {
  const parsed = parseAcpLine("not valid json !!!", "turn-err");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  const msg = parsed.message;
  expect(msg.kind).toBe("raw");
  if (msg.kind !== "raw") throw new Error("unreachable");
  expect(msg.acpMethod).toBe("_parseError");
  expect(msg.params).toBe("not valid json !!!");
});

test("parseAcpLine: thinking chunk → Message{kind:thinking}", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "I'm thinking..." },
      },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("thinking");
  if (parsed.message.kind !== "thinking") throw new Error("unreachable");
  expect(parsed.message.text).toBe("I'm thinking...");
  expect(parsed.message.chunk).toBe(true);
});

test("parseAcpLine: tool_call → Message{kind:tool_call, status:pending}", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        status: "pending",
        title: "Read File",
        rawInput: {},
        content: [],
      },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("tool_call");
  if (parsed.message.kind !== "tool_call") throw new Error("unreachable");
  expect(parsed.message.toolCall.id).toBe("tc-1");
  expect(parsed.message.toolCall.status).toBe("pending");
  expect(parsed.message.toolCall.name).toBe("Read File");
});

test("parseAcpLine: usage_update → Message{kind:token_usage}", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "usage_update",
        used: 19862,
        size: 258400,
      },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("token_usage");
  if (parsed.message.kind !== "token_usage") throw new Error("unreachable");
  expect(parsed.message.usage.outputTokens).toBe(19862);
  expect(parsed.message.usage.inputTokens).toBe(258400);
});

test("parseAcpLine: error frame → Result{stopReason:error}", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32600, message: "Invalid request" },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("result");
  if (parsed.kind !== "result") throw new Error("unreachable");
  expect(parsed.result.stopReason).toBe("error");
  expect(parsed.result.error?.message).toBe("Invalid request");
});

// ---------------------------------------------------------------------------
// AcpParser integration tests
// ---------------------------------------------------------------------------

test("AcpParser: codex-simple.ndjson — end_turn result + at least one text message", async () => {
  const fixture = await loadFixture("codex-simple.ndjson");
  const parser = new AcpParser({
    sessionId: "test",
    turnId: "turn-codex",
    stream: readableFromString(fixture),
  });

  const messages: Message[] = [];
  for await (const msg of parser.messages) {
    messages.push(msg);
  }

  const result = await parser.result;
  expect(result.stopReason).toBe("end_turn");
  expect(result.turnId).toBe("turn-codex");

  const textMessages = messages.filter((m) => m.kind === "text");
  expect(textMessages.length).toBeGreaterThan(0);
  // The codex fixture has "hello" as the agent response
  const firstText = textMessages[0];
  if (firstText?.kind === "text") {
    expect(firstText.text).toBe("hello");
  }
});

test("AcpParser: claude-tool-call.ndjson — includes tool_call, thinking, end_turn", async () => {
  const fixture = await loadFixture("claude-tool-call.ndjson");
  const parser = new AcpParser({
    sessionId: "test",
    turnId: "turn-claude",
    stream: readableFromString(fixture),
  });

  const messages: Message[] = [];
  for await (const msg of parser.messages) {
    messages.push(msg);
  }

  const result = await parser.result;
  expect(result.stopReason).toBe("end_turn");
  expect(result.turnId).toBe("turn-claude");

  const toolCallMessages = messages.filter((m) => m.kind === "tool_call");
  expect(toolCallMessages.length).toBeGreaterThan(0);

  const thinkingMessages = messages.filter((m) => m.kind === "thinking");
  expect(thinkingMessages.length).toBeGreaterThan(0);

  // Verify tool_call fields
  const firstToolCall = toolCallMessages[0];
  if (firstToolCall?.kind === "tool_call") {
    expect(firstToolCall.toolCall.id).toBeTruthy();
    expect(firstToolCall.turnId).toBe("turn-claude");
  }
});

test("AcpParser: empty stream → acpx_exit error Result", async () => {
  const parser = new AcpParser({
    sessionId: "s",
    turnId: "turn-empty",
    stream: readableFromString(""),
  });

  const messages: Message[] = [];
  for await (const msg of parser.messages) {
    messages.push(msg);
  }

  const result = await parser.result;
  expect(result.stopReason).toBe("error");
  expect(result.error?.code).toBe("acpx_exit");
  expect(result.error?.message).toBe("stream closed before result");
  expect(result.turnId).toBe("turn-empty");
  expect(messages.length).toBe(0);
});

test("parseAcpLine: unknown stopReason is preserved as terminal result (forward-compat)", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: { stopReason: "new_future_reason" },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("result");
  if (parsed.kind !== "result") throw new Error("unreachable");
  // Must be treated as terminal, not dropped to raw or synthesized as error.
  expect(parsed.result.stopReason).toBe("new_future_reason");
  expect(parsed.result.error).toBeUndefined();
});

test("parseAcpLine: result.usage (canonical) is parsed onto the Result", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      stopReason: "end_turn",
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        cachedReadTokens: 0,
        cachedWriteTokens: 21907,
        totalTokens: 21914,
      },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("result");
  if (parsed.kind !== "result") throw new Error("unreachable");
  expect(parsed.result.usage?.inputTokens).toBe(3);
  expect(parsed.result.usage?.outputTokens).toBe(4);
  expect(parsed.result.usage?.cachedReadTokens).toBe(0);
  expect(parsed.result.usage?.cachedWriteTokens).toBe(21907);
  expect(parsed.result.usage?.totalTokens).toBe(21914);
});

test("parseAcpLine: tool_call_update without title/rawInput emits partial event (no placeholder name)", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("tool_call");
  if (parsed.message.kind !== "tool_call") throw new Error("unreachable");
  // No placeholder name — must be omitted so the compactor can preserve the
  // real name from the initial tool_call frame.
  expect(parsed.message.toolCall.name).toBeUndefined();
  expect(parsed.message.toolCall.input).toBeUndefined();
  expect(parsed.message.toolCall.status).toBe("completed");
});

test("AcpParser: all message turnIds match constructor turnId", async () => {
  const fixture = await loadFixture("codex-simple.ndjson");
  const parser = new AcpParser({
    sessionId: "test",
    turnId: "my-turn-id",
    stream: readableFromString(fixture),
  });

  for await (const msg of parser.messages) {
    expect(msg.turnId).toBe("my-turn-id");
  }
});
