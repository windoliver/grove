import { describe, expect, test } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { sessionUpdateToMessage } from "./session-update-mapper.js";

const TURN = "t-1";

function notif(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: "s-1", update };
}

describe("sessionUpdateToMessage", () => {
  test("agent_message_chunk → text with chunk=true", () => {
    const m = sessionUpdateToMessage(
      notif({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
      TURN,
    );
    expect(m).toEqual({ kind: "text", turnId: TURN, text: "hi", chunk: true });
  });

  test("agent_thought_chunk → thinking with chunk=true", () => {
    const m = sessionUpdateToMessage(
      notif({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
      TURN,
    );
    expect(m).toEqual({ kind: "thinking", turnId: TURN, text: "hmm", chunk: true });
  });

  test("tool_call → tool_call with populated fields", () => {
    const m = sessionUpdateToMessage(
      notif({
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Run ls",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls" },
      }),
      TURN,
    );
    expect(m.kind).toBe("tool_call");
    if (m.kind !== "tool_call") throw new Error("unreachable");
    expect(m.toolCall.id).toBe("c1");
    expect(m.toolCall.title).toBe("Run ls");
    expect(m.toolCall.status).toBe("in_progress");
  });

  test("usage_update → token_usage", () => {
    const m = sessionUpdateToMessage(
      notif({ sessionUpdate: "usage_update", used: 100, size: 8000 }),
      TURN,
    );
    expect(m.kind).toBe("token_usage");
  });

  test("plan / mode / config updates → raw", () => {
    const m = sessionUpdateToMessage(notif({ sessionUpdate: "plan", entries: [] }), TURN);
    expect(m.kind).toBe("raw");
    if (m.kind !== "raw") throw new Error("unreachable");
    expect(m.acpMethod).toBe("session/update:plan");
  });
});
