/**
 * Detects session completion by watching for done signals from all topology roles.
 *
 * Polls contributions for [DONE] prefix or context.done flag.
 * Calls onDone when all roles have signaled completion.
 *
 * Extracted from ScreenManager to reduce component complexity.
 */

import { useCallback, useEffect, useRef } from "react";
import type { EventBus, GroveEvent } from "../../core/event-bus.js";
import type { AgentTopology } from "../../core/topology.js";
import type { TuiDataProvider } from "../provider.js";
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
 * Supports two modes:
 * - **Event-driven** (preferred): subscribes to EventBus for real-time notifications
 * - **Polling fallback**: polls provider every 5s when no EventBus is available
 *
 * @param provider - Data provider for fetching contributions
 * @param topology - Agent topology with role definitions
 * @param screen - Current screen state (only active on "running" or "advanced")
 * @param eventBus - Optional event bus for real-time done detection
 * @param onDone - Callback when all roles have signaled done
 */
export function useDoneDetection(
  provider: TuiDataProvider,
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
      const roleNames = new Set(topology.roles.map((r) => r.name));
      const allDone = [...roleNames].every((r) => doneRolesRef.current.has(r));
      if (allDone && roleNames.size > 0) {
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
            checkDone(role.name);
          }
        }
        if (event.type === "stop") {
          checkDone(role.name);
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

  // Polling fallback: check contributions every 5s when no EventBus available
  useEffect(() => {
    if (screen !== "running" && screen !== "advanced") return;
    if (!topology || eventBus) return; // Skip if event-driven mode is active

    const roleNames = new Set(topology.roles.map((r) => r.name));
    const timer = setInterval(async () => {
      try {
        const contributions = await provider.getContributions({ limit: 50 });
        if (!contributions) return;

        for (const c of contributions) {
          if (isDoneContribution(c)) {
            const role = c.agent.role;
            if (role) doneRolesRef.current.add(role);
          }
        }

        const allDone = [...roleNames].every((r) => doneRolesRef.current.has(r));
        if (allDone && roleNames.size > 0) {
          onDone();
        }
      } catch {
        // Non-fatal
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [screen, topology, provider, eventBus, onDone]);
}
