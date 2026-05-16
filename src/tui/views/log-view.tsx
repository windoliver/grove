/**
 * LogView — single-session live log tail (issue #310).
 *
 * Controlled component: state (paused, filter, filterMode, scrollOffset) is
 * owned by the parent (running-view) and mutated by the central keyboard
 * dispatcher (running-keyboard.ts). LogView is the bridge between that state
 * and the pure <LogViewport> renderer.
 *
 * Renders an "filter:" prompt line when filterMode is true, otherwise just
 * the viewport.
 */

import React from "react";
import { LogViewport } from "../components/log-viewport.js";
import type { AgentLogBuffer } from "../data/agent-log-buffer.js";
import { theme } from "../theme.js";

export interface LogViewProps {
  readonly sessionId: string;
  /** Pre-resolved buffer for this session/role. Caller owns lifecycle. */
  readonly buffer: AgentLogBuffer | undefined;
  readonly paused: boolean;
  readonly filter: string;
  readonly filterMode: boolean;
  readonly scrollOffset: number;
  readonly viewportLines?: number;
}

export const LogView: React.NamedExoticComponent<LogViewProps> = React.memo(function LogView({
  sessionId,
  buffer,
  paused,
  filter,
  filterMode,
  scrollOffset,
  viewportLines,
}: LogViewProps): React.ReactNode {
  if (!buffer) {
    return (
      <box flexDirection="column" paddingX={1}>
        <text color={theme.secondary}>{`No log buffer for ${sessionId}`}</text>
      </box>
    );
  }
  return (
    <box flexDirection="column" flexGrow={1}>
      {filterMode && (
        <box flexDirection="row" paddingX={1}>
          <text color={theme.focus}>filter: </text>
          <text>{filter}</text>
          <text color={theme.focus}>_</text>
        </box>
      )}
      <LogViewport
        buffer={buffer}
        paused={paused}
        filter={filter}
        scrollOffset={scrollOffset}
        {...(viewportLines !== undefined ? { viewportLines } : {})}
      />
    </box>
  );
});
