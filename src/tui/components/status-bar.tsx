/**
 * Status bar component shown at the bottom of the TUI.
 *
 * Displays context-sensitive keyboard shortcuts based on the focused panel,
 * current input mode, agent count, and session cost.
 */

import React from "react";
import { type InputMode, Panel, type ViewMode } from "../hooks/use-panel-focus.js";
import { theme } from "../theme.js";

/** Which top-level screen the user is on — shown in status bar for orientation. */
export type ScreenContext = "running" | "inspect";

/** Props for the StatusBar component. */
export interface StatusBarProps {
  /** Current input mode. */
  readonly mode: InputMode;
  /** Which top-level screen is active (session vs. inspect overlay). */
  readonly screenContext?: ScreenContext | undefined;
  /** Whether we're in a detail view within a panel. */
  readonly isDetailView?: boolean | undefined;
  /** Error message to display, if any. */
  readonly error?: string | undefined;
  /** Session cost label (e.g. "$1.23 / 45k tokens"), shown on the right when available. */
  readonly costLabel?: string | undefined;
  /** Currently focused panel for context-sensitive hints. */
  readonly focusedPanel?: Panel | undefined;
  /** Number of active agents. */
  readonly agentCount?: number | undefined;
  /** Current view mode (grid or pipeline). */
  readonly viewMode?: ViewMode | undefined;
  /** Current goal text to display in the status bar. */
  readonly goalLabel?: string | undefined;
}

/** Mode labels for the status bar. */
const MODE_LABELS: Record<InputMode, string> = {
  normal: "NORMAL",
  terminal_input: "TERMINAL",
  command_palette: "CMD",
  search_input: "SEARCH",
  message_input: "MESSAGE",
  goal_input: "GOAL",
  help: "HELP",
};

/** Context-sensitive keybinding hints per panel. */
function panelHints(panel: Panel | undefined, isDetailView: boolean | undefined): string {
  if (isDetailView) return " Esc:back  j/k:scroll  r:refresh  ?:help  q:quit";

  // Panel-specific hints — use Panel enum constants (never magic numbers)
  switch (panel) {
    case Panel.Terminal:
      return " i:input  Esc:exit  j/k:scroll  Tab:cycle  ?:help  q:quit";
    case Panel.Frontier:
      return " C:compare  j/k:nav  Enter:detail  +/Esc:zoom  ?:help  q:quit";
    case Panel.Artifact:
      return " h/l:cycle  d:diff  j/k:scroll  +/Esc:zoom  ?:help  q:quit";
    case Panel.Search:
      return " /:search  j/k:nav  Enter:detail  ?:help  q:quit";
    case Panel.Vfs:
      return " j/k:nav  Enter:browse  Esc:back  ?:help  q:quit";
    case Panel.Decisions:
      return " a:approve  d:deny  j/k:nav  ?:help  q:quit";
    case Panel.Inbox:
      return " b:broadcast  @:direct  j/k:nav  ?:help  q:quit";
    default:
      return " 1-4:focus  5-`:toggle  Tab:cycle  j/k:nav  Enter:select  Ctrl+P:spawn  +/Esc:zoom  ?:help  q:quit";
  }
}

/** Screen context labels for the status bar. */
const SCREEN_CONTEXT_LABELS: Record<ScreenContext, string> = {
  running: "RUNNING",
  inspect: "INSPECT",
};

/** Bottom status bar with context-sensitive keybinding hints. */
export const StatusBar: React.NamedExoticComponent<StatusBarProps> = React.memo(function StatusBar({
  mode,
  screenContext,
  isDetailView,
  error,
  costLabel,
  focusedPanel,
  agentCount,
  viewMode,
  goalLabel,
}: StatusBarProps): React.ReactNode {
  const modeLabel = MODE_LABELS[mode];
  const hints = panelHints(focusedPanel, isDetailView);
  const agentLabel =
    agentCount !== undefined && agentCount > 0 ? `${String(agentCount)} agents` : undefined;

  return (
    <box flexDirection="column">
      {goalLabel && (
        <box>
          <text color={theme.secondary}>Goal: {goalLabel}</text>
        </box>
      )}
      {error && (
        <box>
          <text color={theme.error}>Error: {error}</text>
        </box>
      )}
      <box flexDirection="row">
        <text color={theme.focus}>[{modeLabel}]</text>
        {screenContext && (
          <text color={theme.secondary}> [{SCREEN_CONTEXT_LABELS[screenContext]}]</text>
        )}
        {viewMode === "pipeline" && <text color={theme.warning}> [PIPELINE]</text>}
        <text opacity={0.5}>{hints}</text>
        {agentLabel && (
          <text color={theme.secondary}>
            {"  "}
            {agentLabel}
          </text>
        )}
        {costLabel && (
          <text color={theme.secondary}>
            {"  "}
            {costLabel}
          </text>
        )}
      </box>
    </box>
  );
});
