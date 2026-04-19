/**
 * AcpMessageSink — translates GroveEvents whose type is "acp.message" or
 * "acp.result" into AcpSinkEvents and feeds them to an AcpSessionStore.
 *
 * Non-acp events and malformed payloads are silently ignored. This is the
 * only bridge point between the bus-shaped event world and the typed store.
 */

import type { Message, Result } from "../../acp/types.js";
import type { GroveEvent } from "../../core/event-bus.js";
import type { AcpSessionStore } from "./acp-session-store.js";

export interface AcpMessageSink {
  handleGroveEvent(event: GroveEvent): void;
}

export function createAcpMessageSink(store: AcpSessionStore): AcpMessageSink {
  return {
    handleGroveEvent(event: GroveEvent): void {
      if (event.type === "acp.message") {
        const p = event.payload as {
          sessionId?: unknown;
          turnId?: unknown;
          message?: unknown;
        };
        if (
          typeof p.sessionId !== "string" ||
          typeof p.turnId !== "string" ||
          !isMessage(p.message)
        ) {
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
        const p = event.payload as {
          sessionId?: unknown;
          turnId?: unknown;
          result?: unknown;
        };
        if (
          typeof p.sessionId !== "string" ||
          typeof p.turnId !== "string" ||
          !isResult(p.result)
        ) {
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
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { kind?: unknown }).kind === "string" &&
    typeof (v as { turnId?: unknown }).turnId === "string"
  );
}

function isResult(v: unknown): v is Result {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { turnId?: unknown }).turnId === "string" &&
    typeof (v as { stopReason?: unknown }).stopReason === "string"
  );
}
