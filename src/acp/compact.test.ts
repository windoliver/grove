import { expect, test } from "bun:test";
import { compactTurn } from "./compact.js";
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
    { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", name: "bash", status: "pending", input: {} } },
    { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", name: "bash", status: "in_progress", input: {} } },
    { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", name: "bash", status: "completed", input: {}, output: "ok" } },
  ];
  const snap = compactTurn({ turnId: "t1", messages: msgs, result: { turnId: "t1", stopReason: "end_turn" } });
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
