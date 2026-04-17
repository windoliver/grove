import { expect, test } from "bun:test";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AcpParser, parseAcpLine } from "./parser.js";
import type { Message, Result } from "./types.js";

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
    sessionId: "019d9a3c-3dc0-7152-a434-bfd19dd56320",
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
    sessionId: "5476a074-f21d-40dd-b0ef-edcbe7429193",
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

test("parseAcpLine: tool_call without toolCallId → raw (never synthesize empty id)", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "tool_call", status: "pending", title: "no-id frame" },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("raw");
  if (parsed.message.kind !== "raw") throw new Error("unreachable");
  expect(parsed.message.acpMethod).toBe("tool_call");
});

test("parseAcpLine: tool_call with unknown status string → raw (don't coerce to pending)", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "tool_call", toolCallId: "tc-1", status: "cancelled", title: "x" },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  // Unknown status must not silently become "pending" tool_call — emit raw so
  // schema drift is visible to downstream consumers.
  expect(parsed.message.kind).toBe("raw");
});

test("parseAcpLine: prefers canonical _meta.claudeCode.toolName over mutable title", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        status: "pending",
        title: "Read /etc/hostname",
        _meta: { claudeCode: { toolName: "Read" } },
      },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("tool_call");
  if (parsed.message.kind !== "tool_call") throw new Error("unreachable");
  // Canonical identity comes from metadata; mutable display text stays on title.
  expect(parsed.message.toolCall.name).toBe("Read");
  expect(parsed.message.toolCall.title).toBe("Read /etc/hostname");
});

test("parseAcpLine: falls back to title when no canonical identity is present", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-2",
        status: "pending",
        title: "Read File",
      },
    },
  });
  const parsed = parseAcpLine(line, "t");
  if (parsed.kind !== "message" || parsed.message.kind !== "tool_call") {
    throw new Error("unreachable");
  }
  expect(parsed.message.toolCall.name).toBe("Read File");
  expect(parsed.message.toolCall.title).toBe("Read File");
});

test("parseAcpLine: permission_request → typed Message{kind:permission_request}", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "permission_request",
        id: "perm-1",
        tool: "Write",
        input: { path: "/tmp/x" },
      },
    },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("permission_request");
  if (parsed.message.kind !== "permission_request") throw new Error("unreachable");
  expect(parsed.message.request.id).toBe("perm-1");
  expect(parsed.message.request.tool).toBe("Write");
  expect(parsed.message.request.input).toEqual({ path: "/tmp/x" });
});

test("parseAcpLine: permission_request without id/tool → raw (for audit visibility)", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate: "permission_request", input: {} } },
  });
  const parsed = parseAcpLine(line, "t");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("raw");
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

test("AcpParser: result resolves without the consumer iterating messages (eager read)", async () => {
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
  const parser = new AcpParser({
    sessionId: "s",
    turnId: "t-eager",
    stream: readableFromString(`${line}\n`),
  });
  // Do NOT iterate parser.messages. Result must still resolve.
  const timeout = new Promise<Result>((_resolve, reject) =>
    setTimeout(() => reject(new Error("result did not resolve in 1s")), 1000),
  );
  const result = await Promise.race([parser.result, timeout]);
  expect(result.stopReason).toBe("end_turn");
});

test("AcpParser: subscriber attached before stream finishes buffers messages until drained", async () => {
  const lines = [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const parser = new AcpParser({
    sessionId: "s",
    turnId: "t-buffered",
    stream: readableFromString(`${lines.join("\n")}\n`),
  });
  // Subscribe synchronously, BEFORE the background reader has finished.
  const iter = parser.messages[Symbol.asyncIterator]();
  // Now allow the reader to run and finish.
  await parser.result;
  const collected: string[] = [];
  while (true) {
    const { value, done } = await iter.next();
    if (done) break;
    if (value.kind === "text") collected.push(value.text);
  }
  expect(collected).toEqual(["a", "b"]);
});

test("AcpParser: a subscriber that never drains gets bounded (drops past cap); turn still resolves", async () => {
  // Pump more than MAX_SUBSCRIBER_BUFFER messages so the unbounded subscriber
  // would otherwise OOM. The drops go to the slow subscriber; the key invariant
  // is that the parser does not retain unbounded state and the turn still
  // completes.
  const lines: string[] = [];
  const OVER = 9000; // comfortably > MAX_SUBSCRIBER_BUFFER (8192)
  for (let i = 0; i < OVER; i += 1) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        },
      }),
    );
  }
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
  const parser = new AcpParser({
    sessionId: "s",
    turnId: "t-bounded",
    stream: readableFromString(`${lines.join("\n")}\n`),
  });
  // Attach a subscriber that never drains.
  const slow = parser.messages[Symbol.asyncIterator]();
  // Turn must still resolve even though slow never drains.
  const result = await parser.result;
  expect(result.stopReason).toBe("end_turn");
  // Slow subscriber's queue was bounded: drain it and count.
  let slowCount = 0;
  while (true) {
    const { value, done } = await slow.next();
    if (done) break;
    if (value.kind === "text") slowCount += 1;
  }
  // At most the cap (plus one waiter-fulfillment slot) — proves bounded buffer.
  expect(slowCount).toBeLessThan(OVER);
  expect(slowCount).toBeGreaterThan(0);
});

test("AcpParser: return() discards already-buffered messages (no replay after unsubscribe)", async () => {
  // Queue several messages, then unsubscribe WITHOUT having drained them.
  // next() after return() must report done — even though the queue had backlog.
  const lines = [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const parser = new AcpParser({
    sessionId: "s",
    turnId: "t-return-backlog",
    stream: readableFromString(`${lines.join("\n")}\n`),
  });
  const iter = parser.messages[Symbol.asyncIterator]();
  // Let the background read queue messages into this subscriber.
  await parser.result;
  // Now unsubscribe before draining.
  const returned = await (iter.return?.() ?? Promise.resolve({ value: undefined, done: true }));
  expect(returned.done).toBe(true);
  // Backlog MUST be discarded.
  const after = await iter.next();
  expect(after.done).toBe(true);
  expect(after.value).toBeUndefined();
});

test("AcpParser: subscriber that calls return() stops receiving messages (no zombie push)", async () => {
  const parser = new AcpParser({
    sessionId: "s",
    turnId: "t-return",
    stream: readableFromString(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "early" },
          },
        },
      })}\n`,
    ),
  });
  const iter = parser.messages[Symbol.asyncIterator]();
  const first = await iter.next();
  expect(first.done).toBe(false);
  if (first.done) throw new Error("unreachable");
  // Consumer aborts.
  const returned = await (iter.return?.() ?? Promise.resolve({ value: undefined, done: true }));
  expect(returned.done).toBe(true);
  // Now the parser gets more data and would broadcast. The closed subscriber
  // must NOT receive or queue any of it.
  // (Can't feed the existing stream; but its queue at this point is empty, and
  // all subsequent next() calls must stay done.)
  const again = await iter.next();
  expect(again.done).toBe(true);
  const again2 = await iter.next();
  expect(again2.done).toBe(true);
});

test("AcpParser: overflow emits an in-band _overflow raw marker so consumers see the drop", async () => {
  const lines: string[] = [];
  const OVER = 9000;
  for (let i = 0; i < OVER; i += 1) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        },
      }),
    );
  }
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
  const parser = new AcpParser({
    sessionId: "s",
    turnId: "t-overflow",
    stream: readableFromString(`${lines.join("\n")}\n`),
  });
  const iter = parser.messages[Symbol.asyncIterator]();
  await parser.result;
  let sawOverflow = false;
  while (true) {
    const { value, done } = await iter.next();
    if (done) break;
    if (value.kind === "raw" && value.acpMethod === "_overflow") sawOverflow = true;
  }
  expect(sawOverflow).toBe(true);
});

test("AcpParser: broadcast — two simultaneous subscribers each receive every message", async () => {
  const lines = [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "y" } },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const parser = new AcpParser({
    sessionId: "s",
    turnId: "t-fanout",
    stream: readableFromString(`${lines.join("\n")}\n`),
  });
  const collect = async (): Promise<string[]> => {
    const out: string[] = [];
    for await (const m of parser.messages) {
      if (m.kind === "text") out.push(m.text);
    }
    return out;
  };
  const [a, b] = await Promise.all([collect(), collect()]);
  expect(a).toEqual(["x", "y"]);
  expect(b).toEqual(["x", "y"]);
});

test("AcpParser: all message turnIds match constructor turnId", async () => {
  const fixture = await loadFixture("codex-simple.ndjson");
  const parser = new AcpParser({
    sessionId: "019d9a3c-3dc0-7152-a434-bfd19dd56320",
    turnId: "my-turn-id",
    stream: readableFromString(fixture),
  });

  for await (const msg of parser.messages) {
    expect(msg.turnId).toBe("my-turn-id");
  }
});

// ---------------------------------------------------------------------------
// Regression: title on tool_call_update must NOT overwrite canonical name
// ---------------------------------------------------------------------------

test("parseAcpLine: tool_call_update without canonical _meta leaves name undefined", () => {
  // Simulates a later frame that carries only a display title ("rm -rf /tmp/x")
  // but no canonical tool identity. The parser must NOT promote that title
  // into `name` — downstream merge would otherwise rewrite the initial
  // canonical name (e.g. "Bash" → "rm -rf /tmp/x") mid-turn.
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        title: "rm -rf /tmp/x",
        status: "in_progress",
      },
    },
  });
  const parsed = parseAcpLine(line, "t1");
  expect(parsed.kind).toBe("message");
  if (parsed.kind !== "message") throw new Error("unreachable");
  expect(parsed.message.kind).toBe("tool_call");
  if (parsed.message.kind !== "tool_call") throw new Error("unreachable");
  const tc = parsed.message.toolCall;
  expect(tc.name).toBeUndefined();
  expect(tc.title).toBe("rm -rf /tmp/x");
  expect(tc.status).toBe("in_progress");
});

test("parseAcpLine: tool_call_update with canonical _meta still sets name", () => {
  // Canonical identity is stable across updates — `_meta.claudeCode.toolName`
  // remains authoritative even on update frames.
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        title: "some mutable display",
        status: "completed",
        _meta: { claudeCode: { toolName: "Bash" } },
      },
    },
  });
  const parsed = parseAcpLine(line, "t1");
  if (parsed.kind !== "message" || parsed.message.kind !== "tool_call") {
    throw new Error("unreachable");
  }
  expect(parsed.message.toolCall.name).toBe("Bash");
});

// ---------------------------------------------------------------------------
// Regression: session mismatch is demoted to raw, not leaked into the turn
// ---------------------------------------------------------------------------

test("parseAcpLine: session/update with mismatched sessionId → raw _sessionMismatch", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "foreign-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "leak" } },
    },
  });
  const parsed = parseAcpLine(line, "t1", "expected-session");
  if (parsed.kind !== "message" || parsed.message.kind !== "raw") {
    throw new Error("unreachable");
  }
  expect(parsed.message.acpMethod).toBe("_sessionMismatch");
});

test("parseAcpLine: matching sessionId passes through normally", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    },
  });
  const parsed = parseAcpLine(line, "t1", "s1");
  if (parsed.kind !== "message" || parsed.message.kind !== "text") {
    throw new Error("unreachable");
  }
  expect(parsed.message.text).toBe("ok");
});

test("parseAcpLine: absent expected sessionId skips validation (backwards-compat)", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "whatever",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    },
  });
  const parsed = parseAcpLine(line, "t1");
  if (parsed.kind !== "message" || parsed.message.kind !== "text") {
    throw new Error("unreachable");
  }
  expect(parsed.message.text).toBe("ok");
});

test("AcpParser: foreign-session frames are demoted, not leaked into the iterator", async () => {
  const lines = [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "other-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NOPE" } },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "mine",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mine" } },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const parser = new AcpParser({
    sessionId: "mine",
    turnId: "t1",
    stream: readableFromString(`${lines.join("\n")}\n`),
  });
  const got: Message[] = [];
  for await (const m of parser.messages) got.push(m);

  const textMsgs = got.filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text");
  expect(textMsgs).toHaveLength(1);
  expect(textMsgs[0]?.text).toBe("mine");

  const rawMismatch = got.find((m) => m.kind === "raw" && m.acpMethod === "_sessionMismatch");
  expect(rawMismatch).toBeDefined();
});
