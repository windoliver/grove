import { expect, test } from "bun:test";
import type { Message, Result, ToolCall } from "./types.js";

test("Message union discriminates by kind", () => {
  const m: Message = { kind: "text", turnId: "t1", text: "hi", chunk: true };
  expect(m.kind).toBe("text");
  if (m.kind === "text") expect(m.text).toBe("hi");
});

test("ToolCall status covers full lifecycle", () => {
  const tc: ToolCall = { id: "tc1", name: "bash", status: "pending", input: {} };
  const next: ToolCall = { ...tc, status: "completed", output: "ok" };
  expect(next.status).toBe("completed");
});

test("Result stopReason includes cancelled and error", () => {
  const r: Result = { turnId: "t1", stopReason: "cancelled" };
  expect(r.stopReason).toBe("cancelled");
});
