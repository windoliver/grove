/**
 * Detects session completion by watching for done signals from required topology roles.
 *
 * Polls contributions for [DONE] prefix or context.done flag.
 * Calls onDone when all required roles have signaled completion.
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

function requiredDoneRoles(topology: AgentTopology): readonly string[] {
  const explicit = topology.roles.filter((role) => role.endsSession).map((role) => role.name);
  return explicit.length > 0 ? explicit : topology.roles.map((role) => role.name);
}

function doneRoleFromEvent(event: GroveEvent, subscribedRole: string): string {
  return event.sourceRole && event.sourceRole !== "system" ? event.sourceRole : subscribedRole;
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
 * @param onDone - Callback when all required roles have signaled done
 */
export function useDoneDetection(
  topology: AgentTopology | undefined,
  screen: Screen,
  eventBus: EventBus | undefined,
  onDone: () => void,
): void {
  const doneRolesRef = useRef<Set<string>>(new Set());

  const checkDone = useCallback(
    (role: string) => {
      if (!topology) return;
      doneRolesRef.current.add(role);
      const roleNames = requiredDoneRoles(topology);
      const allDone = roleNames.every((r) => doneRolesRef.current.has(r));
      if (allDone && roleNames.length > 0) {
        onDone();
      }
    },
    [topology, onDone],
  );

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
            checkDone(doneRoleFromEvent(event, role.name));
          }
        }
        if (event.type === "stop") {
          checkDone(doneRoleFromEvent(event, role.name));
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
  }, [screen, topology, eventBus, checkDone]);
}
