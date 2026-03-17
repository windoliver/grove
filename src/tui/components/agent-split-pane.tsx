/**
 * Agent split pane component — tmux-like side-by-side terminal output.
 *
 * Shows 2-4 agent terminals in split layout with status indicators
 * and Enter-to-zoom / Esc-to-unsplit support.
 */

import React, { useCallback } from "react";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { theme } from "../theme.js";

/** Maximum visible agent panes. Overflow agents are listed but not rendered. */
const MAX_VISIBLE_PANES = 4;

/** Props for the AgentSplitPane component. */
export interface AgentSplitPaneProps {
  /** Active tmux session names (grove-*). */
  readonly sessions: readonly string[];
  /** TmuxManager for pane capture. */
  readonly tmux: TmuxManager;
  /** Polling interval in milliseconds. */
  readonly intervalMs: number;
  /** Whether this view is actively polling. */
  readonly active: boolean;
  /** Index of the focused pane (for highlight). */
  readonly focusedIndex?: number | undefined;
}

/** Status symbol for agent state. */
function agentSymbol(sessionName: string, _sessions: readonly string[]): string {
  // All sessions in the list are active (from tmux.listSessions)
  void _sessions;
  void sessionName;
  return theme.agentRunning;
}

/** Single agent pane — captures and renders one agent's output. */
const AgentPane = React.memo(function AgentPane({
  sessionName,
  tmux,
  intervalMs,
  active,
  focused,
}: {
  readonly sessionName: string;
  readonly tmux: TmuxManager;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly focused: boolean;
}) {
  const fetcher = useCallback(async () => {
    return tmux.capturePanes(sessionName);
  }, [tmux, sessionName]);

  const captureMs = Math.max(intervalMs, 200);
  const { data: output } = usePolledData<string>(fetcher, captureMs, active);

  const rawOutput = output ?? "";
  const lines = rawOutput.trimEnd().split("\n").slice(-15);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      border
      borderStyle="single"
      borderColor={focused ? theme.focus : theme.inactive}
    >
      <box>
        <text color={focused ? theme.focus : theme.muted} bold={focused}>
          {` ${agentSymbol(sessionName, [])} ${sessionName.replace("grove-", "@")} `}
        </text>
      </box>
      <box flexDirection="column" flexGrow={1}>
        {lines.length > 0 ? (
          lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: terminal lines have no stable identity
            <text key={i}>{line}</text>
          ))
        ) : (
          <text opacity={0.5}>(no output)</text>
        )}
      </box>
    </box>
  );
});

/** Agent split pane layout showing multiple agent terminals side by side. */
export const AgentSplitPane: React.NamedExoticComponent<AgentSplitPaneProps> = React.memo(
  function AgentSplitPane({
    sessions,
    tmux,
    intervalMs,
    active,
    focusedIndex,
  }: AgentSplitPaneProps): React.ReactNode {
    if (sessions.length === 0) {
      return (
        <box>
          <text opacity={0.5}>No active agent sessions</text>
        </box>
      );
    }

    const visibleSessions = sessions.slice(0, MAX_VISIBLE_PANES);
    const overflowCount = sessions.length - visibleSessions.length;

    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="row" flexGrow={1}>
          {visibleSessions.map((session, i) => (
            <AgentPane
              key={session}
              sessionName={session}
              tmux={tmux}
              intervalMs={intervalMs}
              active={active}
              focused={focusedIndex === i}
            />
          ))}
        </box>
        {overflowCount > 0 && (
          <box>
            <text color={theme.dimmed}>
              {`+${overflowCount} more agent${overflowCount > 1 ? "s" : ""} (not shown)`}
            </text>
          </box>
        )}
      </box>
    );
  },
);
