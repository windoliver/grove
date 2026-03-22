/**
 * WebSocket hook for connecting TUI to grove-server's session service.
 *
 * Replaces usePolledData and useEventDrivenData when the TUI is running
 * as a thin client connected to the backend via WebSocket.
 *
 * Falls back gracefully: when the WebSocket is not available the hook
 * returns connected=false and the caller should use the existing
 * provider-based data hooks instead.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types mirroring the server protocol (keep in sync with session-service.ts)
// ---------------------------------------------------------------------------

/** Agent info from the server. */
export interface WsAgentInfo {
  readonly role: string;
  readonly id: string;
  readonly status: string;
}

/** Session state snapshot from the server. */
export interface WsSessionState {
  readonly id: string;
  readonly goal: string;
  readonly agents: readonly WsAgentInfo[];
  readonly contributions: number;
  readonly status: "pending" | "running" | "complete";
}

/** Events pushed from the server. */
export type WsSessionEvent =
  | {
      readonly type: "state";
      readonly id: string;
      readonly goal: string;
      readonly agents: readonly WsAgentInfo[];
      readonly contributions: number;
      readonly status: string;
    }
  | { readonly type: "agent_spawned"; readonly role: string; readonly agent: WsAgentInfo }
  | {
      readonly type: "contribution";
      readonly cid: string;
      readonly kind: string;
      readonly summary: string;
      readonly role: string;
    }
  | { readonly type: "agent_done"; readonly role: string; readonly reason: string }
  | { readonly type: "session_complete"; readonly reason: string }
  | { readonly type: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Return type of useSessionWs. */
export interface UseSessionWsResult {
  /** Current session state (null before first message). */
  readonly state: WsSessionState | null;
  /** Accumulated contribution events since connection. */
  readonly events: readonly WsSessionEvent[];
  /** Send a command to the server. */
  readonly send: (command: string, payload?: Record<string, unknown>) => void;
  /** Whether the WebSocket is currently connected. */
  readonly connected: boolean;
}

/** Reconnect delay in ms. */
const RECONNECT_DELAY_MS = 3000;

/**
 * Connect to grove-server's WebSocket endpoint and receive push events.
 *
 * @param serverUrl - WebSocket URL, e.g. "ws://localhost:4515/ws"
 * @param active - Whether the hook should connect. Set false to disable.
 */
export function useSessionWs(serverUrl: string, active = true): UseSessionWsResult {
  const [state, setState] = useState<WsSessionState | null>(null);
  const [events, setEvents] = useState<readonly WsSessionEvent[]>([]);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const connect = useCallback(() => {
    if (!activeRef.current) return;

    try {
      const ws = new WebSocket(serverUrl);

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as WsSessionEvent;

          if (msg.type === "state") {
            const stateMsg = msg as WsSessionEvent & { type: "state" };
            setState({
              id: stateMsg.id,
              goal: stateMsg.goal,
              agents: stateMsg.agents,
              contributions: stateMsg.contributions,
              status: stateMsg.status as WsSessionState["status"],
            });
          }

          // Accumulate all events (capped at 200)
          setEvents((prev) => {
            const next = [...prev, msg];
            return next.length > 200 ? next.slice(-200) : next;
          });
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        // Schedule reconnect
        if (activeRef.current) {
          reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => {
        // onclose will fire after onerror — reconnect handled there
      };

      wsRef.current = ws;
    } catch {
      // WebSocket constructor threw — schedule reconnect
      if (activeRef.current) {
        reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    }
  }, [serverUrl]);

  useEffect(() => {
    if (!active) return;

    connect();

    return () => {
      if (reconnectRef.current !== null) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (wsRef.current !== null) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [active, connect]);

  const send = useCallback((command: string, payload?: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "command", command, payload }));
    }
  }, []);

  return { state, events, send, connected };
}
