/**
 * Detail rail — selected-agent context (issue #193).
 *
 * Stacked sections: header, approval (when present), task, tail, handoffs,
 * cost, action footer.
 */

import React from "react";
import { theme } from "../../theme.js";
import type { AgentHealth } from "./agent-health.js";
import type { FleetAgent } from "./use-fleet-model.js";

export interface DetailRailProps {
  readonly agent: FleetAgent | undefined;
  readonly tail: readonly string[];
}

const mins = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

function healthHeader(h: AgentHealth): { text: string; color: string } {
  switch (h.kind) {
    case "running":
      return { text: "RUNNING", color: theme.running };
    case "idle":
      return { text: "IDLE", color: theme.idle };
    case "approval":
      return { text: "APPROVAL PENDING", color: theme.warning };
    case "blocked":
      return { text: `BLOCKED ${mins(h.sinceMs)} on ${h.on}`, color: theme.error };
    case "stuck":
      return { text: `STUCK ${mins(h.sinceMs)}`, color: theme.warning };
    case "thrashing":
      return { text: `THRASHING (${h.retries} retries)`, color: theme.warning };
    case "silent":
      return { text: `SILENT ${mins(h.sinceMs)}`, color: theme.warning };
    case "error":
      return { text: `ERROR: ${h.reason}`, color: theme.error };
    case "expired":
      return { text: "EXPIRED", color: theme.idle };
  }
}

export const DetailRail = React.memo(function DetailRail({
  agent,
  tail,
}: DetailRailProps): React.ReactNode {
  if (!agent) {
    return (
      <box flexDirection="column" paddingX={1}>
        <text opacity={0.5}>Select an agent (j/k) to view context</text>
      </box>
    );
  }

  const hdr = healthHeader(agent.health);

  return (
    <box flexDirection="column" paddingX={1}>
      <box flexDirection="row" marginBottom={1}>
        <text bold>{agent.agentName}</text>
        <text color={theme.secondary}>{`  (${agent.role}/${agent.platform})  `}</text>
        <text color={hdr.color} bold>
          {hdr.text}
        </text>
      </box>

      {agent.health.kind === "approval" ? (
        <box
          flexDirection="column"
          marginBottom={1}
          borderStyle="round"
          borderColor={theme.warning}
          paddingX={1}
        >
          <text color={theme.warning} bold>
            Wants to run:
          </text>
          <text>{agent.health.cmd}</text>
          <text color={theme.secondary}>[y]allow [n]deny [a]always</text>
        </box>
      ) : null}

      <box flexDirection="column" marginBottom={1}>
        <text color={theme.secondary} bold>
          Task
        </text>
        <text>{agent.currentTask ?? "(no task)"}</text>
        <text color={theme.secondary}>target: {agent.claim.spec.targetRef}</text>
      </box>

      <box flexDirection="column" marginBottom={1}>
        <text color={theme.secondary} bold>
          Tail
        </text>
        {tail.length === 0 ? (
          <text opacity={0.4}>(no output)</text>
        ) : (
          tail.slice(-8).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ephemeral lines
            <text key={i}>{line}</text>
          ))
        )}
      </box>

      <box flexDirection="row" marginBottom={1}>
        <text color={theme.secondary}>Handoffs: </text>
        <text>{`${agent.handoffs.pendingOut} pending out`}</text>
        {agent.handoffs.overdueIn > 0 ? (
          <text color={theme.error}>{`  ${agent.handoffs.overdueIn} overdue in`}</text>
        ) : null}
        {agent.handoffs.blockedOn ? (
          <text color={theme.error}>{`  blocked on ${agent.handoffs.blockedOn}`}</text>
        ) : null}
      </box>

      <box flexDirection="row" marginBottom={1}>
        <text color={theme.secondary}>Cost: </text>
        <text>
          {agent.cost
            ? `$${agent.cost.usd.toFixed(2)} · ${agent.cost.tokens.toLocaleString()} tok`
            : "-"}
        </text>
      </box>

      <box flexDirection="row">
        <text color={theme.secondary}>[t]ail [d]ag [r]eroute [K]ill [m]essage</text>
      </box>
    </box>
  );
});
