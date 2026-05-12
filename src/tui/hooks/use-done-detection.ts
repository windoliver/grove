/**
 * Detects session completion by watching for explicit done signals.
 *
 * Watches contribution events for [DONE] prefix or context.done flag.
 * Calls onDone when a required terminal role has marked the session complete.
 *
 * Extracted from ScreenManager to reduce component complexity.
 */

import { useCallback, useEffect, useRef } from "react";
import type { EventBus, GroveEvent } from "../../core/event-bus.js";
import type { AgentTopology } from "../../core/topology.js";
import type { Screen } from "../screens/screen-manager.js";

export function isDoneContribution(c: { summary: string; context?: unknown }): boolean {
  return (
    c.summary.startsWith("[DONE]") ||
    (c.context !== null &&
      c.context !== undefined &&
      typeof c.context === "object" &&
      (c.context as Record<string, unknown>).done === true)
  );
}

export function requiredDoneRoleNames(topology: AgentTopology | undefined): readonly string[] {
  if (!topology) return [];
  const terminalRoles = topology.roles
    .filter((role) => (role.edges?.length ?? 0) === 0)
    .map((role) => role.name);
  return terminalRoles.length > 0 ? terminalRoles : topology.roles.map((role) => role.name);
}

interface DoneContribution {
  readonly summary: string;
  readonly context?: unknown;
  readonly agent?: { readonly role?: string | undefined } | undefined;
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
): (contribution: DoneContribution) => void {
  const doneRolesRef = useRef<Set<string>>(new Set());
  const doneSignaledRef = useRef(false);

  const checkDone = useCallback(
    (role: string) => {
      if (!topology || doneSignaledRef.current) return;
      doneRolesRef.current.add(role);
      const roleNames = new Set(requiredDoneRoleNames(topology));
      const allDone = [...roleNames].every((r) => doneRolesRef.current.has(r));
      if (allDone && roleNames.size > 0) {
        doneSignaledRef.current = true;
        onDone();
      }
    },
    [topology, onDone],
  );

  const completeNow = useCallback(() => {
    if (!topology) return;
    if (topology.roles.length === 0 || doneSignaledRef.current) return;
    doneSignaledRef.current = true;
    onDone();
  }, [topology, onDone]);

  const observeContribution = useCallback(
    (contribution: DoneContribution) => {
      if (!isDoneContribution(contribution)) return;
      const role = contribution.agent?.role;
      if (role !== undefined) checkDone(role);
    },
    [checkDone],
  );

  useEffect(() => {
    if (screen !== "running" && screen !== "advanced") {
      doneRolesRef.current.clear();
      doneSignaledRef.current = false;
    }
  }, [screen]);

  // Event-driven mode: subscribe to EventBus for real-time done detection
  useEffect(() => {
    if (screen !== "running" && screen !== "advanced") return;
    if (!topology || !eventBus) return;

    doneSignaledRef.current = false;
    const handlers: Array<{ role: string; handler: (e: GroveEvent) => void }> = [];
    for (const role of topology.roles) {
      const handler = (event: GroveEvent) => {
        if (event.type === "contribution") {
          const payload = event.payload as { summary?: string; context?: unknown };
          if (
            payload.summary &&
            isDoneContribution(payload as { summary: string; context?: unknown })
          ) {
            checkDone(event.sourceRole);
          }
        }
        if (event.type === "stop") {
          completeNow();
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
  }, [screen, topology, eventBus, checkDone, completeNow]);

  return observeContribution;
}
