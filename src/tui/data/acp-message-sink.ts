/**
 * AcpMessageSink — translates GroveEvents whose type is "acp.message" or
 * "acp.result" into AcpSinkEvents and feeds them to an AcpSessionStore.
 *
 * Non-acp events and malformed payloads are silently ignored. This is the
 * only bridge point between the bus-shaped event world and the typed store.
 */

import type { Message, Result } from "../../acp/types.js";
import type { GroveEvent } from "../../core/event-bus.js";
import { debugLog } from "../debug-log.js";
import type { AcpSessionStore } from "./acp-session-store.js";

export interface AcpMessageSink {
  handleGroveEvent(event: GroveEvent): void;
}

// Per-kind payload shape guard: the sink is the only gate between the wire
// and downstream projectors that dereference kind-specific fields without
// null-checks (session-log-projector, session-panel). A `tool_call` frame
// missing `.toolCall` or a `permission_request` missing `.request` must be
// rejected at ingest time — otherwise it lands in the store and throws on
// every subsequent projection/render cycle.
function isMessageBody(kind: string, v: Record<string, unknown>): boolean {
  switch (kind) {
    case "text":
    case "thinking":
      return typeof v.text === "string" && typeof v.chunk === "boolean";
    case "tool_call":
      // `ToolCallEvent.name` is OPTIONAL — ACP emits one full `tool_call`
      // frame per id plus N `tool_call_update` frames that legitimately
      // omit `name` and other unchanged fields. Only `id` is required.
      return (
        typeof v.toolCall === "object" &&
        v.toolCall !== null &&
        typeof (v.toolCall as { id?: unknown }).id === "string"
      );
    case "permission_request":
      return (
        typeof v.request === "object" &&
        v.request !== null &&
        typeof (v.request as { id?: unknown }).id === "string" &&
        typeof (v.request as { tool?: unknown }).tool === "string"
      );
    case "token_usage":
      return (
        typeof v.usage === "object" &&
        v.usage !== null &&
        typeof (v.usage as { inputTokens?: unknown }).inputTokens === "number" &&
        typeof (v.usage as { outputTokens?: unknown }).outputTokens === "number"
      );
    case "raw":
      return typeof v.acpMethod === "string";
    default:
      return false;
  }
}

export function createAcpMessageSink(store: AcpSessionStore): AcpMessageSink {
  return {
    handleGroveEvent(event: GroveEvent): void {
      if (event.type === "acp.message") {
        const p = event.payload as
          | { sessionId?: unknown; turnId?: unknown; message?: unknown }
          | null
          | undefined;
        if (
          !p ||
          typeof p.sessionId !== "string" ||
          typeof p.turnId !== "string" ||
          !isMessage(p.message)
        ) {
          debugLog("acp_event_malformed", `acp.message payload rejected from ${event.sourceRole}`);
          return;
        }
        // Envelope and inner turnId MUST agree. Mismatch would let a
        // malformed event close or mutate the wrong turn.
        if (p.message.turnId !== p.turnId) {
          debugLog(
            "acp_event_malformed",
            `acp.message turnId mismatch envelope=${p.turnId} inner=${p.message.turnId} from ${event.sourceRole}`,
          );
          return;
        }
        store.ingest({
          kind: "message",
          sessionId: p.sessionId,
          turnId: p.turnId,
          message: p.message,
        });
        return;
      }

      if (event.type === "acp.result") {
        const p = event.payload as
          | { sessionId?: unknown; turnId?: unknown; result?: unknown }
          | null
          | undefined;
        if (
          !p ||
          typeof p.sessionId !== "string" ||
          typeof p.turnId !== "string" ||
          !isResult(p.result)
        ) {
          debugLog("acp_event_malformed", `acp.result payload rejected from ${event.sourceRole}`);
          return;
        }
        if (p.result.turnId !== p.turnId) {
          debugLog(
            "acp_event_malformed",
            `acp.result turnId mismatch envelope=${p.turnId} inner=${p.result.turnId} from ${event.sourceRole}`,
          );
          return;
        }
        store.ingest({
          kind: "result",
          sessionId: p.sessionId,
          turnId: p.turnId,
          result: p.result,
        });
      }
    },
  };
}

function isMessage(v: unknown): v is Message {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.turnId !== "string") return false;
  const kind = rec.kind;
  if (typeof kind !== "string") return false;
  return isMessageBody(kind, rec);
}

function isResult(v: unknown): v is Result {
  if (typeof v !== "object" || v === null) return false;
  if (typeof (v as { turnId?: unknown }).turnId !== "string") return false;
  // StopReason admits unknown strings via `(string & {})` for forward-compat
  // with future ACP revisions and provider-specific reasons. Accept any
  // non-empty string; UI layer maps unknown values to a generic terminal state.
  const stopReason = (v as { stopReason?: unknown }).stopReason;
  return typeof stopReason === "string" && stopReason.length > 0;
}
