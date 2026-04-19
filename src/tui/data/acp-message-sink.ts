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

const VALID_MESSAGE_KINDS = new Set([
  "text",
  "thinking",
  "tool_call",
  "permission_request",
  "token_usage",
  "raw",
]);

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
  const kind = (v as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !VALID_MESSAGE_KINDS.has(kind)) return false;
  return typeof (v as { turnId?: unknown }).turnId === "string";
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
