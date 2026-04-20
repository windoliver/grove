/**
 * SessionLogProjector — turns typed Messages into LogLine entries that
 * feed the existing AgentLogBuffer so TracePane keeps working without a
 * parallel ingestion pipeline for acpx-spawned sessions.
 *
 * Exported as pure functions (plus a glue helper) to keep the store and
 * the buffer decoupled and make every projection unit-testable.
 */

import type { Message, Result } from "../../acp/types.js";
import type { AcpSessionStore } from "./acp-session-store.js";
import type { AgentLogBuffer, LogLine } from "./agent-log-buffer.js";

export function messageToLogLine(message: Message): LogLine | undefined {
  switch (message.kind) {
    case "text":
      return { ts: Date.now(), line: message.text, type: "output" };
    case "thinking":
      return { ts: Date.now(), line: `(thinking) ${message.text}`, type: "output" };
    case "tool_call": {
      // `tool_call_update` frames legitimately omit name/status. Keep the
      // projection resilient so partial frames render as a concise update
      // line instead of "undefined (undefined)".
      const name = message.toolCall.name ?? message.toolCall.id;
      const status = message.toolCall.status ?? "update";
      return { ts: Date.now(), line: `[tool] ${name} (${status})`, type: "tool" };
    }
    case "permission_request":
      return { ts: Date.now(), line: `[perm] ${message.request.tool}`, type: "tool" };
    case "token_usage":
      return undefined;
    case "raw":
      return { ts: Date.now(), line: `[raw:${message.acpMethod}]`, type: "output" };
  }
}

export function resultToLogLine(result: Result): LogLine {
  return { ts: Date.now(), line: `[${result.stopReason}]`, type: "turn" };
}

/**
 * Bind a store session to a buffer: every new message in the latest turn
 * becomes a LogLine push, and the terminal Result becomes a [stopReason]
 * line. The returned unsubscribe drops the binding.
 *
 * The projector keeps a per-turn cursor so repeat notifications don't
 * double-project already-emitted messages.
 */
export function projectSessionToBuffer(
  store: AcpSessionStore,
  sessionId: string,
  buffer: AgentLogBuffer,
): () => void {
  const cursors = new Map<string, number>();
  const closed = new Set<string>();

  const drain = (): void => {
    const sess = store.getSession(sessionId);
    if (!sess) return;
    for (const turn of sess.turns.values()) {
      // Cursors are kept in ABSOLUTE sequence-number space so eviction
      // from the front of `turn.messages` does not misalign them. The
      // store reports dropped counts via `turn.droppedMessageCount`;
      // translate cursor → current-array index by subtracting it.
      const absolute = cursors.get(turn.turnId) ?? 0;
      const startIdx = Math.max(0, absolute - turn.droppedMessageCount);
      for (let i = startIdx; i < turn.messages.length; i++) {
        const msg = turn.messages[i];
        if (msg) {
          const ll = messageToLogLine(msg);
          if (ll) buffer.push(ll);
        }
      }
      cursors.set(turn.turnId, turn.droppedMessageCount + turn.messages.length);
      if (turn.closedAt !== undefined && !closed.has(turn.turnId)) {
        closed.add(turn.turnId);
        buffer.push(
          resultToLogLine({
            turnId: turn.turnId,
            stopReason: turn.stopReason ?? "end_turn",
            ...(turn.error ? { error: turn.error } : {}),
          }),
        );
      }
    }
  };

  const unsubscribe = store.subscribe(sessionId, drain);
  drain();
  return unsubscribe;
}
