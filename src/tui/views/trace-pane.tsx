/**
 * TracePane — k9s-style split-pane agent trace viewer.
 *
 * Left column:  scrollable agent list with status indicators
 * Right column: selected agent's full scrollable trace (viewport sliced)
 *
 * Uses AgentLogBuffer ring buffers for O(viewport) rendering.
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

import React, { useCallback, useEffect, useState } from "react";
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

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
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
  // Subscribe to the selected agent's buffer for live updates
  const selectedRole = roles[selectedAgent];
  const selectedBuffer = selectedRole ? buffers.get(selectedRole) : undefined;

  // Force re-render when buffer changes (via 16ms batched flush)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!selectedBuffer) return;
    const listener = () => setTick((t) => t + 1);
    selectedBuffer.subscribe(listener);
    return () => selectedBuffer.unsubscribe(listener);
  }, [selectedBuffer]);

  // ─── Left column: agent list ───
  const agentList = roles.map((role, idx) => {
    const isSelected = idx === selectedAgent;
    const status = agentStatuses.get(role) ?? "idle";
    const badge = agentStatusIcon(status, status === "running" ? spinnerFrame : undefined);
    const lineCount = buffers.get(role)?.size ?? 0;
    const selector = isSelected ? "\u25b6" : " ";

    return (
      <box
        key={role}
        flexDirection="row"
        backgroundColor={isSelected ? theme.selectedBg : undefined}
      >
        <text color={isSelected ? theme.focus : theme.secondary}>{selector} </text>
        <text color={badge.color}>{badge.icon} </text>
        <text color={isSelected ? theme.text : theme.secondary} bold={isSelected}>
          {role.length > 12 ? `${role.slice(0, 11)}\u2026` : role.padEnd(12)}
        </text>
        <text color={theme.secondary}> {lineCount > 0 ? String(lineCount) : ""}</text>
      </box>
    );
  });

  // ─── Right column: trace output (viewport sliced) ───
  const getViewportLines = useCallback((): LogLine[] => {
    if (!selectedBuffer || selectedBuffer.isEmpty) return [];
    const total = selectedBuffer.size;
    const end = Math.max(0, total - traceScrollOffset);
    const start = Math.max(0, end - viewportLines);
    return selectedBuffer.slice(start, end);
  }, [selectedBuffer, traceScrollOffset, viewportLines]);

  const displayLines = getViewportLines();
  const isAutoScroll = traceScrollOffset === 0;
  const totalLines = selectedBuffer?.size ?? 0;

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

        {/* Right: Trace output */}
        <box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={theme.focus}>
          <box flexDirection="row" paddingX={1}>
            <text color={theme.focus} bold>
              {selectedRole ?? "—"} trace
            </text>
            <text color={theme.secondary}>
              {" "}
              {totalLines} lines
              {isAutoScroll
                ? " | auto-scroll: ON"
                : ` | auto-scroll: OFF (${traceScrollOffset}\u2191)`}
            </text>
          </box>
          {displayLines.length === 0 ? (
            <box paddingX={1}>
              <text color={theme.secondary}>(no output yet)</text>
            </box>
          ) : (
            <box flexDirection="column" paddingX={1}>
              {displayLines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: trace lines have no stable identity
                <box key={i} flexDirection="row">
                  <text color={theme.disabled}>{formatTimestamp(line.ts)} </text>
                  <code>{line.line}</code>
                </box>
              ))}
            </box>
          )}
        </box>
      </box>
    </box>
  );
});
