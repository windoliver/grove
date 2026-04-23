import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { Message, ToolCallEvent } from "./types.js";

export function sessionUpdateToMessage(notification: SessionNotification, turnId: string): Message {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        kind: "text",
        turnId,
        text: update.content.type === "text" ? update.content.text : `[${update.content.type}]`,
        chunk: true,
      };
    case "agent_thought_chunk":
      return {
        kind: "thinking",
        turnId,
        text: update.content.type === "text" ? update.content.text : `[${update.content.type}]`,
        chunk: true,
      };
    case "user_message_chunk":
      return {
        kind: "text",
        turnId,
        text: update.content.type === "text" ? update.content.text : `[${update.content.type}]`,
        chunk: true,
      };
    case "tool_call": {
      // NOTE: ACP's `title` is mutable display text. The `name` field on the
      // grove ToolCall contract is the stable canonical tool identity used
      // as an audit/telemetry key. Do not populate `name` from `title` —
      // that would turn shell commands and other user-visible strings into
      // forged canonical keys. Leave `name` undefined until a canonical id
      // is available via metadata; `title` holds the display text.
      const event: ToolCallEvent = { id: update.toolCallId };
      event.title = update.title;
      if (update.status !== undefined) event.status = update.status;
      if (update.rawInput !== undefined) event.input = update.rawInput;
      return { kind: "tool_call", turnId, toolCall: event };
    }
    case "tool_call_update": {
      const event: ToolCallEvent = { id: update.toolCallId };
      if (update.status !== undefined && update.status !== null) event.status = update.status;
      if (update.title !== undefined && update.title !== null) event.title = update.title;
      if (update.rawInput !== undefined) event.input = update.rawInput;
      if (update.rawOutput !== undefined) event.output = update.rawOutput;
      return { kind: "tool_call", turnId, toolCall: event };
    }
    case "usage_update":
      return {
        kind: "token_usage",
        turnId,
        usage: {
          inputTokens: update.used ?? 0,
          outputTokens: 0,
          totalTokens: update.size,
        },
      };
    default:
      return {
        kind: "raw",
        turnId,
        acpMethod: `session/update:${update.sessionUpdate}`,
        params: update,
      };
  }
}
