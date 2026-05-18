/**
 * Supervision composition root — horizontal layout joining FleetRail and
 * DetailRail (#193 Task 8).
 *
 * Supports controlled mode (cursor/pinnedAgentId props set by Task 10
 * running-view) and uncontrolled mode (internal state, used by tests and
 * standalone rendering).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { theme } from "../../theme.js";
import { DetailRail } from "./detail-rail.js";
import { FleetRail } from "./fleet-rail.js";
import type { FleetAgent } from "./use-fleet-model.js";

export interface SupervisionProps {
  /** Fleet agents, already sorted problem-first by buildFleet. */
  readonly agents: readonly FleetAgent[];
  /** Tail lines for the selected agent's output. */
  readonly tail: readonly string[];
  /** Controlled cursor (index into agents). Uncontrolled when absent. */
  readonly cursor?: number;
  /**
   * Controlled pinned agent id. Uncontrolled when absent.
   * When both `cursor` and `pinnedAgentId` are provided, `pinnedAgentId` wins for selection.
   */
  readonly pinnedAgentId?: string;
  /** Fired whenever the resolved selected agentId changes. */
  readonly onSelect?: (agentId: string | undefined) => void;
}

export const Supervision = React.memo(function Supervision({
  agents,
  tail,
  cursor: cursorProp,
  pinnedAgentId: pinnedProp,
  onSelect,
}: SupervisionProps): React.ReactNode {
  // ── Uncontrolled internal state ──────────────────────────────────────────
  const [internalCursor, setInternalCursor] = useState(0);

  // Clamp internal cursor when agents list shrinks
  useEffect(() => {
    if (agents.length === 0) {
      setInternalCursor(0);
      return;
    }
    setInternalCursor((prev) => Math.min(prev, agents.length - 1));
  }, [agents.length]);

  // ── Resolve active cursor and pinned id ──────────────────────────────────
  // pinnedProp (controlled) acts as the pin; no uncontrolled pin state needed
  // until a future task exposes keyboard pinning in uncontrolled mode.
  const isControlled = cursorProp !== undefined || pinnedProp !== undefined;
  const activeCursor = cursorProp ?? internalCursor;
  const activePinned = pinnedProp;

  // ── Resolve selected agent ───────────────────────────────────────────────
  const selectedAgent = useMemo((): FleetAgent | undefined => {
    if (activePinned) {
      const pinned = agents.find((a) => a.agentId === activePinned);
      if (pinned) return pinned;
    }
    return agents[activeCursor] ?? agents[0];
  }, [agents, activeCursor, activePinned]);

  // ── Auto-select on approval (uncontrolled only, guarded by pin) ──────────
  const lastApprovalRef = useRef<string | undefined>(undefined);
  const prevSelectedIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (isControlled) return; // let the controller handle this
    if (activePinned) return; // pin takes precedence
    const approvalAgent = agents.find((a) => a.health.kind === "approval");
    if (!approvalAgent) return;
    if (approvalAgent.agentId === lastApprovalRef.current) return; // same agent, no re-trigger
    lastApprovalRef.current = approvalAgent.agentId;
    const idx = agents.indexOf(approvalAgent);
    if (idx !== -1) {
      setInternalCursor(idx);
      // Do not set a pin — approval auto-select is just a cursor nudge
    }
  }, [agents, activePinned, isControlled]);

  // ── onSelect effect ──────────────────────────────────────────────────────
  const selectedId = selectedAgent?.agentId;
  // guarded so an inline onSelect from the parent doesn't fire every render
  useEffect(() => {
    if (selectedId === prevSelectedIdRef.current) return;
    prevSelectedIdRef.current = selectedId;
    onSelect?.(selectedId);
  }, [selectedId, onSelect]);

  // ── Resolve cursor index for FleetRail highlight ─────────────────────────
  const resolvedCursor = useMemo((): number => {
    if (!selectedAgent) return activeCursor;
    const idx = agents.indexOf(selectedAgent);
    return idx !== -1 ? idx : activeCursor;
  }, [agents, selectedAgent, activeCursor]);

  // ── Layout ───────────────────────────────────────────────────────────────
  return (
    <box flexDirection="row">
      <box flexBasis="40%" paddingX={1}>
        <FleetRail
          agents={agents}
          cursor={resolvedCursor}
          selectedAgentId={selectedAgent?.agentId}
        />
      </box>
      <box flexBasis="60%" borderStyle="round" borderColor={theme.focus}>
        <DetailRail agent={selectedAgent} tail={tail} />
      </box>
    </box>
  );
});
