/**
 * WebSocket handler for grove-server.
 *
 * TUI connects via WebSocket, receives push events,
 * sends commands (start_session, stop_session, get_state).
 *
 * The protocol is JSON messages over a single WebSocket connection.
 * The server pushes SessionEvents and responds to WsMessages.
 */

import type {
  SessionEvent,
  SessionEventListener,
  SessionService,
  SessionState,
} from "./session-service.js";

// ---------------------------------------------------------------------------
// Inbound message protocol
// ---------------------------------------------------------------------------

/** Commands the TUI can send to the server. */
export interface WsMessage {
  readonly type: "command";
  readonly command: "start_session" | "stop_session" | "get_state";
  readonly payload?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Outbound message helpers
// ---------------------------------------------------------------------------

/** Serialise a SessionState for the wire, converting agents array. */
function serialiseState(state: SessionState): string {
  return JSON.stringify({
    type: "state",
    id: state.id,
    goal: state.goal,
    agents: state.agents,
    contributions: state.contributions,
    status: state.status,
  });
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/** Minimal WebSocket interface matching Bun's ServerWebSocket shape. */
export interface WsSocket {
  send(data: string): void;
}

/** Additional metadata stored on a connected socket. */
interface WsSocketInternal extends WsSocket {
  _unsub?: (() => void) | undefined;
}

/**
 * Create handlers for Bun.serve() WebSocket events.
 *
 * Returns an object with `open`, `message`, and `close` callbacks
 * suitable for Bun's `websocket` option.
 */
export function createWsHandler(service: SessionService): {
  open(ws: WsSocket): void;
  message(ws: WsSocket, message: string): void;
  close(ws: WsSocket): void;
} {
  return {
    open(ws: WsSocket) {
      const internal = ws as WsSocketInternal;

      // Send current state snapshot on connect
      const state = service.getState();
      ws.send(serialiseState(state));

      // Subscribe to push events and forward to this client
      const listener: SessionEventListener = (event: SessionEvent) => {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          /* socket may have closed */
        }
      };
      internal._unsub = service.onEvent(listener);
    },

    message(ws: WsSocket, message: string) {
      void handleMessage(ws, message, service);
    },

    close(ws: WsSocket) {
      const internal = ws as WsSocketInternal;
      if (internal._unsub) {
        internal._unsub();
        internal._unsub = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Message handling (async)
// ---------------------------------------------------------------------------

async function handleMessage(ws: WsSocket, raw: string, service: SessionService): Promise<void> {
  try {
    const msg = JSON.parse(raw) as WsMessage;

    const p = msg.payload;
    switch (msg.command) {
      case "start_session": {
        const goal = String(p?.goal ?? "");
        const sessionId = typeof p?.sessionId === "string" ? p.sessionId : undefined;
        const state = await service.startSession(goal, sessionId);
        ws.send(serialiseState(state));
        break;
      }

      case "stop_session": {
        const reason = String(p?.reason ?? "User stopped");
        await service.stopSession(reason);
        break;
      }

      case "get_state": {
        const state = service.getState();
        ws.send(serialiseState(state));
        break;
      }
    }
  } catch (err: unknown) {
    try {
      ws.send(JSON.stringify({ type: "error", message: String(err) }));
    } catch {
      /* send failed, ignore */
    }
  }
}
