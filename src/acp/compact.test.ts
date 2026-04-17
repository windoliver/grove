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

test("compactTurn flags overflowed:true when the stream contained an _overflow marker", () => {
  const msgs: Message[] = [
    { kind: "text", turnId: "t1", text: "partial", chunk: true },
    { kind: "raw", turnId: "t1", acpMethod: "_overflow", params: { droppedAtLeast: 1 } },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  // Snapshot consumers MUST treat this as a partial log.
  expect(snap.overflowed).toBe(true);
});

test("compactTurn collects permission_request messages into permissionRequests", () => {
  const msgs: Message[] = [
    {
      kind: "permission_request",
      turnId: "t1",
      request: { id: "p1", tool: "Write", input: {} },
    },
    {
      kind: "permission_request",
      turnId: "t1",
      request: { id: "p2", tool: "Edit", input: {} },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.permissionRequests).toHaveLength(2);
  expect(snap.permissionRequests[0]?.id).toBe("p1");
  expect(snap.permissionRequests[1]?.tool).toBe("Edit");
});

test("compactTurn preserves parser anomaly frames (_sessionMismatch, _parseError) in rawAnomalyFrames", () => {
  // Isolation alarms and parse errors must not disappear from the snapshot —
  // otherwise a contaminated or corrupted turn compacts into a clean record.
  const msgs: Message[] = [
    {
      kind: "raw",
      turnId: "t1",
      acpMethod: "_sessionMismatch",
      params: { sessionId: "foreign" },
    },
    { kind: "raw", turnId: "t1", acpMethod: "_parseError", params: "not json" },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.rawAnomalyFrames).toHaveLength(2);
  expect(snap.rawAnomalyFrames[0]?.acpMethod).toBe("_sessionMismatch");
  expect(snap.rawAnomalyFrames[1]?.acpMethod).toBe("_parseError");
});

test("compactTurn terminal status is strict-monotonic — completed cannot be flipped to failed", () => {
  // completed and failed share rank 2; an out-of-order or duplicate terminal
  // update must NOT silently rewrite the final outcome. First terminal wins.
  const msgs: Message[] = [
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", name: "Bash", status: "completed", input: { cmd: "ls" } },
    },
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", status: "failed", error: "late duplicate" },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.toolCalls[0]?.status).toBe("completed");
});

test("compactTurn terminal status is strict-monotonic — failed cannot be flipped to completed", () => {
  const msgs: Message[] = [
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", name: "Bash", status: "failed", input: { cmd: "ls" } },
    },
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", status: "completed", output: "reordered" },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.toolCalls[0]?.status).toBe("failed");
});

test("compactTurn rejected-terminal frames cannot contaminate output/diff/error", () => {
  // A late duplicate terminal update with a conflicting status must not
  // leak its payload into the accepted outcome — otherwise we get audit
  // records like {status:"completed", error:"late duplicate failure"}.
  const msgs: Message[] = [
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: {
        id: "tc1",
        name: "Bash",
        status: "completed",
        input: { cmd: "ls" },
        output: "ok",
      },
    },
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", status: "failed", output: "reordered", error: "late duplicate" },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.toolCalls[0]?.status).toBe("completed");
  expect(snap.toolCalls[0]?.output).toBe("ok");
  expect(snap.toolCalls[0]?.error).toBeUndefined();
});

test("compactTurn preserves unknown forward-compat raw frames in otherRawFrames", () => {
  // Parser keeps unknown sessionUpdate kinds as raw for forward-compat.
  // The compactor must retain them so a schema-drifted turn doesn't
  // silently lose frames once the live event log is pruned.
  const msgs: Message[] = [
    {
      kind: "raw",
      turnId: "t1",
      acpMethod: "some_future_event",
      params: { foo: "bar" },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.otherRawFrames).toHaveLength(1);
  expect(snap.otherRawFrames[0]?.acpMethod).toBe("some_future_event");
  // And anomaly/tool/permission buckets stay clean.
  expect(snap.rawAnomalyFrames).toHaveLength(0);
  expect(snap.rawToolFrames).toHaveLength(0);
  expect(snap.rawPermissionFrames).toHaveLength(0);
});

test("compactTurn routes a truncated tool_call (initial placeholder, no update) into incompleteToolCalls", () => {
  // Simulates the real Claude wire path where an initial tool_call carries no
  // canonical input (parser filters rawInput:{} placeholder) and no
  // tool_call_update ever arrives (overflow/EOF/lost frame). The compactor
  // must NOT finalize this as a valid tool call — otherwise the audit log
  // gets a Bash/Read/Write entry with no command/path.
  const msgs: Message[] = [
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc1", name: "Bash", status: "pending" /* no input */ },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.toolCalls).toHaveLength(0);
  expect(snap.incompleteToolCalls).toHaveLength(1);
  expect(snap.incompleteToolCalls[0]?.id).toBe("tc1");
  expect(snap.incompleteToolCalls[0]?.name).toBe("Bash");
});

test("compactTurn carries parser-demoted permission frames into rawPermissionFrames", () => {
  // When the parser demotes a permission_request frame (missing id/tool) to raw,
  // the compactor must preserve the signal — otherwise a malformed permission
  // prompt vanishes from the snapshot entirely, defeating the purpose of the
  // permission audit trail.
  const msgs: Message[] = [
    {
      kind: "raw",
      turnId: "t1",
      acpMethod: "permission_request",
      params: { sessionUpdate: "permission_request", tool: "Write" /* no id */ },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.permissionRequests).toHaveLength(0);
  expect(snap.rawPermissionFrames).toHaveLength(1);
  expect(snap.rawPermissionFrames[0]?.acpMethod).toBe("permission_request");
});

test("compactTurn carries parser-demoted tool frames (raw) into rawToolFrames", () => {
  // When the parser demotes a tool_call frame (missing id / unknown status)
  // to raw, the compactor must preserve that signal — otherwise tool activity
  // disappears entirely from the snapshot.
  const msgs: Message[] = [
    {
      kind: "raw",
      turnId: "t1",
      acpMethod: "tool_call",
      params: { sessionUpdate: "tool_call", status: "pending", title: "no-id frame" },
    },
    {
      kind: "raw",
      turnId: "t1",
      acpMethod: "tool_call_update",
      params: { toolCallId: "tc-x", status: "unknown_future_status" },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  expect(snap.toolCalls).toHaveLength(0);
  expect(snap.incompleteToolCalls).toHaveLength(0);
  expect(snap.rawToolFrames).toHaveLength(2);
  expect(snap.rawToolFrames[0]?.acpMethod).toBe("tool_call");
  expect(snap.rawToolFrames[1]?.acpMethod).toBe("tool_call_update");
});

test("compactTurn routes orphan tool_call_update (no name/input) into incompleteToolCalls, not toolCalls", () => {
  const msgs: Message[] = [
    // No initial tool_call frame — only an update. Parser would have emitted this
    // when the initial frame was demoted to raw (missing id / unknown status).
    {
      kind: "tool_call",
      turnId: "t1",
      toolCall: { id: "tc-orphan", status: "completed", output: "ok" },
    },
  ];
  const snap = compactTurn({
    turnId: "t1",
    messages: msgs,
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  // Must NOT appear as a finalized tool call with blank name/input.
  expect(snap.toolCalls).toHaveLength(0);
  // Must appear in incompleteToolCalls so schema drift is visible.
  expect(snap.incompleteToolCalls).toHaveLength(1);
  expect(snap.incompleteToolCalls[0]?.id).toBe("tc-orphan");
  expect(snap.incompleteToolCalls[0]?.status).toBe("completed");
});

test("compactTurn keeps canonical usage undefined when result has no usage (advisoryUsage is separate)", () => {
  const msgs: Message[] = [
    { kind: "token_usage", turnId: "t1", usage: { inputTokens: 100, outputTokens: 50 } },
  ];
  const result: Result = { turnId: "t1", stopReason: "end_turn" };
  const snap = compactTurn({ turnId: "t1", messages: msgs, result });
  // Canonical usage must stay undefined — advisory values are rolling-window
  // meters and must not be promoted to per-turn canonical counts.
  expect(snap.usage).toBeUndefined();
  // But the advisory meter itself is preserved under a separate field.
  expect(snap.advisoryUsage?.inputTokens).toBe(100);
  expect(snap.advisoryUsage?.outputTokens).toBe(50);
});

test("claude-tool-call fixture compacts to real tool names, not placeholders", async () => {
  const fixture = await Bun.file("tests/fixtures/acp/claude-tool-call.ndjson").text();
  const parser = new AcpParser({
    sessionId: "5476a074-f21d-40dd-b0ef-edcbe7429193",
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
    sessionId: "6bca1174-e38a-40f5-b82e-96425bef3853",
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
