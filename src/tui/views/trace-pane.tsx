/**
 * TracePane — k9s-style split-pane agent trace viewer.
 *
 * Left column:  scrollable agent list with status indicators
 * Right column: selected agent's full scrollable trace, rendered via
 *               the shared <LogViewport> component (which owns its own
 *               buffer subscription + viewport slicing + header).
 *
 * Auto-scroll follows new output; scrolling up pauses auto-scroll.
 * Historical lines (from resume) are rendered dimmed.
 *
 * Layout:
 * ┌────────────────┬──────────────────────────────────────┐
 * │ ► ● coder      │ [tool] Read src/auth.ts (completed)  │
 * │   ○ reviewer   │ Found 3 issues in authentication     │
 * │   ○ analyst    │ [tool] Edit src/auth.ts (running)    │
 * └────────────────┴──────────────────────────────────────┘
 * j/k:select agent  J/K:scroll trace  f:full  Esc:close
 */

import React from "react";
import { LogViewport } from "../components/log-viewport.js";
import type { AgentLogBuffer, LogLine } from "../data/agent-log-buffer.js";
import { agentStatusIcon, theme } from "../theme.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed width of the agent list column (characters). */
const AGENT_LIST_WIDTH = 20;
/**
 * Default viewport height (lines).
 * Uses terminal rows minus chrome (header, status bar, borders ≈ 5 lines).
 * Falls back to 30 if stdout is not a TTY.
 */
const DEFAULT_VIEWPORT_LINES = Math.max(10, (process.stdout.rows ?? 40) - 5);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TracePaneProps {
  /** Map of role name → AgentLogBuffer. */
  readonly buffers: ReadonlyMap<string, AgentLogBuffer>;
  /** Ordered list of agent role names. */
  readonly roles: readonly string[];
  /** Map of role name → agent status for icon display. */
  readonly agentStatuses: ReadonlyMap<string, string>;
  /** Current spinner frame for animated icons. */
  readonly spinnerFrame: number;
  /** Index of the selected agent in the role list. */
  readonly selectedAgent: number;
  /** Scroll offset from bottom of trace (0 = auto-scroll). */
  readonly traceScrollOffset: number;
  /** Number of visible trace lines. */
  readonly viewportLines?: number;
}

export function traceLineTextColor(line: LogLine): string {
  return line.historical ? theme.disabled : theme.text;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TracePane: React.NamedExoticComponent<TracePaneProps> = React.memo(function TracePane({
  buffers,
  roles,
  agentStatuses,
  spinnerFrame,
  selectedAgent,
  traceScrollOffset,
  viewportLines = DEFAULT_VIEWPORT_LINES,
}: TracePaneProps): React.ReactNode {
  const selectedRole = roles[selectedAgent];
  const selectedBuffer = selectedRole ? buffers.get(selectedRole) : undefined;

  // ─── Left column: agent list ───
  const agentList = roles.map((role, idx) => {
    const isSelected = idx === selectedAgent;
    const status = agentStatuses.get(role) ?? "idle";
    const badge = agentStatusIcon(status, status === "running" ? spinnerFrame : undefined);
    const lineCount = buffers.get(role)?.size ?? 0;
    const selector = isSelected ? "▶" : " ";

    return (
      <box
        key={role}
        flexDirection="row"
        backgroundColor={isSelected ? theme.selectedBg : undefined}
      >
        <text color={isSelected ? theme.focus : theme.secondary}>{selector} </text>
        <text color={badge.color}>{badge.icon} </text>
        <text color={isSelected ? theme.text : theme.secondary} bold={isSelected}>
          {role.length > 12 ? `${role.slice(0, 11)}…` : role.padEnd(12)}
        </text>
        <text color={theme.secondary}> {lineCount > 0 ? String(lineCount) : ""}</text>
      </box>
    );
  });

  // ─── Render ───
  if (roles.length === 0) {
    return (
      <box flexDirection="column" paddingX={1}>
        <text color={theme.secondary}>No agents to trace</text>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexGrow={1}>
        {/* Left: Agent list */}
        <box
          flexDirection="column"
          width={AGENT_LIST_WIDTH}
          borderStyle="round"
          borderColor={theme.border}
        >
          <box paddingX={1}>
            <text color={theme.focus} bold>
              Agents
            </text>
          </box>
          {agentList}
        </box>

        {/* Right: trace output */}
        <box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={theme.focus}>
          {selectedBuffer ? (
            <LogViewport
              buffer={selectedBuffer}
              paused={false}
              filter=""
              scrollOffset={traceScrollOffset}
              viewportLines={viewportLines}
              title={`${selectedRole ?? "—"} trace`}
            />
          ) : (
            <box paddingX={1}>
              <text color={theme.secondary}>(no agent selected)</text>
            </box>
          )}
        </box>
      </box>
    </box>
  );
});
