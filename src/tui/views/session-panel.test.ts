import { expect, test } from "bun:test";
import type { TurnRecord } from "../data/acp-session-store.js";
import { deriveSessionPanelLines, statusBadge } from "./session-panel.js";

test("statusBadge returns the right label for each stopReason", () => {
  expect(statusBadge(undefined)).toBe("● running");
  expect(statusBadge("end_turn")).toBe("✓ end_turn");
  expect(statusBadge("cancelled")).toBe("⊘ cancelled");
  expect(statusBadge("max_tokens")).toBe("⊘ max_tokens");
  expect(statusBadge("error")).toBe("✗ error");
});

test("deriveSessionPanelLines concatenates text chunks and emits one tool line per tool_call", () => {
  const turn: TurnRecord = {
    turnId: "t1",
    sessionId: "s1",
    startedAt: 1,
    messages: [
      { kind: "text", turnId: "t1", text: "Hel", chunk: true },
      { kind: "text", turnId: "t1", text: "lo", chunk: true },
      {
        kind: "tool_call",
        turnId: "t1",
        toolCall: { id: "tc1", name: "bash", status: "completed", input: {} },
      },
      {
        kind: "permission_request",
        turnId: "t1",
        request: { id: "p1", tool: "bash", input: {} },
      },
      { kind: "thinking", turnId: "t1", text: "hmm", chunk: true },
      { kind: "raw", turnId: "t1", acpMethod: "session/update:x", params: {} },
      { kind: "token_usage", turnId: "t1", usage: { inputTokens: 10, outputTokens: 5 } },
    ],
  };
  const lines = deriveSessionPanelLines(turn);
  expect(lines).toEqual([
    { kind: "text", text: "Hello" },
    { kind: "tool", text: "[tool] bash · completed" },
    { kind: "perm", text: "⚑ permission requested: bash" },
    { kind: "thinking", text: "(thinking) hmm" },
    { kind: "raw", text: "[raw: session/update:x]" },
  ]);
});

test("deriveSessionPanelLines returns [] when the turn is empty", () => {
  const turn: TurnRecord = { turnId: "t1", sessionId: "s1", startedAt: 1, messages: [] };
  expect(deriveSessionPanelLines(turn)).toEqual([]);
});
