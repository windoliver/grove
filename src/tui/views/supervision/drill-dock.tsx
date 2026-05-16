/**
 * DrillDock — bottom pane scoped to the focused agent.
 *
 * Hosts three tabs:
 *   - Feed → DrillFeed (per-agent contributions)
 *   - DAG  → DagView (unscoped for v1; per-agent scoping is a follow-up)
 *   - Term → TerminalView (driven by agent.sessionName)
 */

import React from "react";
import { InputMode } from "../../hooks/use-panel-focus.js";
import type { TuiDataProvider } from "../../provider.js";
import { theme } from "../../theme.js";
import { DagView } from "../dag.js";
import { TerminalView } from "../terminal.js";
import { DrillFeed } from "./drill-feed.js";
import { DrillTabs } from "./drill-tabs.js";
import type { DrillTab, SupervisedAgent } from "./types.js";

export interface DrillDockProps {
  readonly agent: SupervisedAgent;
  readonly tab: DrillTab;
  readonly provider: TuiDataProvider;
  readonly active: boolean;
}

export const DrillDock: React.NamedExoticComponent<DrillDockProps> = React.memo(
  function DrillDock({ agent, tab, provider, active }: DrillDockProps) {
    return (
      <box flexDirection="column" borderStyle="single" paddingLeft={1}>
        <box flexDirection="row" gap={1}>
          <text>{agent.agentId}</text>
          <text color={theme.secondary}>·</text>
          <DrillTabs active={tab} />
        </box>
        <box flexGrow={1}>
          {tab === "feed" && (
            <DrillFeed
              provider={provider}
              scopedAgentId={agent.agentId}
              active={active}
            />
          )}
          {tab === "dag" && (
            // v1: unscoped DAG. Per-agent scoping is a follow-up; the supervision
            // surface still benefits from operators seeing the global graph here.
            <DagView provider={provider} active={active} cursor={0} />
          )}
          {tab === "term" && agent.sessionName !== undefined && (
            <TerminalView
              sessionName={agent.sessionName}
              active={active}
              mode={InputMode.Normal}
            />
          )}
          {tab === "term" && agent.sessionName === undefined && (
            <text color={theme.secondary}>(no tmux session for this agent)</text>
          )}
        </box>
      </box>
    );
  },
);
