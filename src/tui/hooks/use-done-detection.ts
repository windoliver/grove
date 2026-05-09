/**
 * Detects session completion by watching for explicit done signals.
 *
 * Polls contributions for [DONE] prefix or context.done flag.
 * Calls onDone on the first done signal. `grove_done` is an explicit session
 * terminator in the TUI workflow; waiting for every role to also signal done
 * leaves review-loop sessions alive after reviewer approval.
 *
 * Extracted from ScreenManager to reduce component complexity.
 */

import { useCallback, useEffect, useRef } from "react";
import type { EventBus, GroveEvent } from "../../core/event-bus.js";
import type { AgentTopology } from "../../core/topology.js";
import type { Screen } from "../screens/screen-manager.js";

function isDoneContribution(c: { summary: string; context?: unknown }): boolean {
  return (
    c.summary.startsWith("[DONE]") ||
    (c.context !== null &&
      c.context !== undefined &&
      typeof c.context === "object" &&
      (c.context as Record<string, unknown>).done === true)
  );
}

/**
 * Watch for session completion via contribution done signals.
 *
 * Subscribes to EventBus for real-time done detection. When `eventBus` is
 * undefined the hook is a no-op — callers must wire EventBus to detect
 * completion. (A8.5 #391: dropped the polling fallback so `src/tui` no
 * longer owns a periodic timer for this path.)
 *
 * @param topology - Agent topology with role definitions
 * @param screen - Current screen state (only active on "running" or "advanced")
 * @param eventBus - Event bus for real-time done detection; without it the hook is inert
 * @param onDone - Callback when the session has been explicitly signaled done
 */
export function useDoneDetection(
  topology: AgentTopology | undefined,
  screen: Screen,
  eventBus: EventBus | undefined,
  onDone: () => void,
): void {
  const doneSignaledRef = useRef(false);

  const signalDone = useCallback(() => {
    if (!topology || doneSignaledRef.current) return;
    doneSignaledRef.current = true;
    onDone();
  }, [topology, onDone]);

  useEffect(() => {
    if (screen !== "running" && screen !== "advanced") {
      doneSignaledRef.current = false;
    }
  }, [screen]);

  // Event-driven mode: subscribe to EventBus for real-time done detection
  useEffect(() => {
    if (screen !== "running" && screen !== "advanced") return;
    if (!topology || !eventBus) return;

    const handlers: Array<{ role: string; handler: (e: GroveEvent) => void }> = [];
    for (const role of topology.roles) {
      const handler = (event: GroveEvent) => {
        if (event.type === "contribution") {
          const payload = event.payload as { summary?: string; context?: unknown };
          if (
            payload.summary &&
            isDoneContribution(payload as { summary: string; context?: unknown })
          ) {
            signalDone();
          }
        }
        if (event.type === "stop") {
          signalDone();
        }
      };
      handlers.push({ role: role.name, handler });
      eventBus.subscribe(role.name, handler);
    }

    return () => {
      for (const { role, handler } of handlers) {
        eventBus.unsubscribe(role, handler);
      }
    };
  }, [screen, topology, eventBus, signalDone]);
}
