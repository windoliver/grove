/**
 * Fleet rail — dense one-row-per-agent list (issue #193).
 *
 * Renders the FleetAgent[] from useFleetModel. Cursor row is highlighted;
 * problem agents show ALL-CAPS health label and any blocked-on attribution.
 */

import React from "react";
import { EmptyState } from "../../components/empty-state.js";
import { agentStatusIcon, theme } from "../../theme.js";
import type { AgentHealth } from "./agent-health.js";
import type { FleetAgent } from "./use-fleet-model.js";

export interface FleetRailProps {
  readonly agents: readonly FleetAgent[];
  readonly cursor: number;
  readonly selectedAgentId: string | undefined;
}

const PROBLEM_KINDS = new Set<AgentHealth["kind"]>([
  "error",
  "approval",
  "blocked",
  "stuck",
  "thrashing",
  "silent",
]);

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const mins = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

function healthLabel(h: AgentHealth): { label: string; color: string } {
  switch (h.kind) {
    case "running":
      return { label: "run", color: theme.running };
    case "idle":
      return { label: "idle", color: theme.idle };
    case "approval":
      return { label: "APPROVAL", color: theme.warning };
    case "blocked":
      return { label: `BLOCKED ${mins(h.sinceMs)}`, color: theme.error };
    case "stuck":
      return { label: `STUCK ${mins(h.sinceMs)}`, color: theme.warning };
    case "thrashing":
      return { label: `THRASH x${h.retries}`, color: theme.warning };
    case "silent":
      return { label: `SILENT ${mins(h.sinceMs)}`, color: theme.warning };
    case "error":
      return { label: "ERROR", color: theme.error };
    case "expired":
      return { label: "expired", color: theme.idle };
  }
}

export const FleetRail = React.memo(function FleetRail({
  agents,
  cursor,
  selectedAgentId,
}: FleetRailProps): React.ReactNode {
  if (agents.length === 0) {
    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>Fleet (0)</text>
        </box>
        <EmptyState title="No agents registered." hint="Press r to register, or Ctrl+P to spawn." />
      </box>
    );
  }

  const problemCount = agents.filter((a) => PROBLEM_KINDS.has(a.health.kind)).length;
  const header = `Fleet (${agents.length}${problemCount > 0 ? ` · ${problemCount} problem` : ""})`;

  return (
    <box flexDirection="column">
      <box marginBottom={1}>
        <text bold>{header}</text>
      </box>
      {agents.map((a, i) => {
        const isCursor = i === cursor;
        const isSelected = a.agentId === selectedAgentId;
        const { icon } = agentStatusIcon(
          a.health.kind === "running" ? "running" : a.health.kind === "idle" ? "idle" : "error",
        );
        const lbl = healthLabel(a.health);
        const prefix = isCursor ? "►" : " ";
        const action = a.lastAction ?? a.currentTask ?? "";
        return (
          <box
            key={a.agentId}
            flexDirection="row"
            backgroundColor={isSelected ? theme.focus : undefined}
          >
            <text>{`${prefix} `}</text>
            <text color={lbl.color}>{`${icon} ${lbl.label.padEnd(14)}`}</text>
            <text color={theme.secondary}>{` ${a.role.padEnd(10)} `}</text>
            <text>{trunc(a.agentName, 14).padEnd(14)}</text>
            <text color={theme.secondary}>{` ${trunc(action, 40)}`}</text>
            {a.health.kind === "blocked" ? (
              <text color={theme.error}>{` ← ${a.health.on}`}</text>
            ) : null}
            {a.health.kind === "approval" ? <text color={theme.warning}>{" [y/n]"}</text> : null}
            {a.cost ? <text color={theme.secondary}>{`  $${a.cost.usd.toFixed(2)}`}</text> : null}
          </box>
        );
      })}
    </box>
  );
});
