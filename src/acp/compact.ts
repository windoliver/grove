/**
 * Fold a live event log (Messages + Result) into a compacted turn snapshot.
 * Idempotent: running twice on the same input yields the same output.
 */

import type { Message, Result, ToolCall, TokenUsage } from "./types.js";

export interface TurnSnapshot {
  turnId: string;
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCall[];
  usage: TokenUsage | undefined;
  stopReason: Result["stopReason"];
  error: Result["error"] | undefined;
}

export function compactTurn(input: {
  turnId: string;
  messages: readonly Message[];
  result: Result;
}): TurnSnapshot {
  let assistantText = "";
  let thinkingText = "";
  const toolCallMap = new Map<string, ToolCall>();
  let usage: TokenUsage | undefined;

  for (const m of input.messages) {
    switch (m.kind) {
      case "text":
        assistantText += m.text;
        break;
      case "thinking":
        thinkingText += m.text;
        break;
      case "tool_call": {
        const existing = toolCallMap.get(m.toolCall.id);
        toolCallMap.set(m.toolCall.id, { ...existing, ...m.toolCall });
        break;
      }
      case "token_usage":
        usage = m.usage;
        break;
      default:
        // raw, permission_request — not included in snapshot summary
        break;
    }
  }

  return {
    turnId: input.turnId,
    assistantText,
    thinkingText,
    toolCalls: [...toolCallMap.values()],
    usage,
    stopReason: input.result.stopReason,
    error: input.result.error,
  };
}
