import React from "react";
import { theme } from "../../theme.js";
import type { AgentState, SupervisedAgent } from "./types.js";

const STATE_COLOR: Readonly<Record<AgentState, keyof typeof theme>> = {
  running: "success",
  silent: "stale",
  stuck: "warning",
  thrashing: "error",
  blocked: "error",
  awaiting: "info",
  done: "secondary",
  idle: "secondary",
};

const STATE_ICON: Readonly<Record<AgentState, string>> = {
  running: "●",
  silent: "◐",
  stuck: "↻",
  thrashing: "↯",
  blocked: "⨯",
  awaiting: "⏸",
  done: "✓",
  idle: "·",
};

const STATE_LABEL: Readonly<Record<AgentState, string>> = {
  running: "RUN",
  silent: "SLNT",
  stuck: "STCK",
  thrashing: "THRSH",
  blocked: "BLK",
  awaiting: "APPR",
  done: "DONE",
  idle: "IDLE",
};

export const CARD_WIDTH = 26;
export const CARD_HEIGHT = 6;

export interface AgentCardProps {
  readonly agent: SupervisedAgent;
  readonly focused: boolean;
}

export const AgentCard: React.NamedExoticComponent<AgentCardProps> = React.memo(function AgentCard({
  agent,
  focused,
}: AgentCardProps) {
  const stateColor = theme[STATE_COLOR[agent.state]];
  const idText = agent.agentId.slice(0, 12);
  const taskText = truncate(agent.currentTask ?? "", 22);
  return (
    <box
      width={CARD_WIDTH}
      height={CARD_HEIGHT}
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? theme.info : theme.secondary}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text>{idText}</text>
        <text color={stateColor}>
          {STATE_ICON[agent.state]} {STATE_LABEL[agent.state]}
        </text>
      </box>
      <text color={theme.secondary}>
        {agent.role} · {agent.platform}
      </text>
      <text>{truncate(agent.stateReason, 24)}</text>
      <text color={theme.secondary}>{taskText}</text>
      <box flexDirection="row" justifyContent="space-between">
        <text>${agent.costUsd.toFixed(2)}</text>
        <text color={agent.contextHot ? theme.error : theme.secondary}>
          {agent.contextPercent !== undefined ? `${agent.contextPercent}%` : ""}
          {agent.costSpike ? " ⚠" : ""}
        </text>
      </box>
    </box>
  );
});

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
