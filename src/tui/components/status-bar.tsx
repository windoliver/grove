/**
 * Status bar component shown at the bottom of the TUI.
 *
 * Displays context-sensitive keyboard shortcuts based on the focused panel,
 * current input mode, agent count, and session cost.
 */

import React from "react";
import type { InputMode, Panel } from "../hooks/use-panel-focus.js";
import { theme } from "../theme.js";

/** Props for the StatusBar component. */
export interface StatusBarProps {
  /** Current input mode. */
  readonly mode: InputMode;
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
}

/** Mode labels for the status bar. */
const MODE_LABELS: Record<InputMode, string> = {
  normal: "NORMAL",
  terminal_input: "TERMINAL",
  command_palette: "CMD",
  search_input: "SEARCH",
  message_input: "MESSAGE",
  help: "HELP",
};

/** Context-sensitive keybinding hints per panel. */
function panelHints(panel: Panel | undefined, isDetailView: boolean | undefined): string {
  if (isDetailView) return " Esc:back  j/k:scroll  r:refresh  ?:help  q:quit";

  // Panel-specific hints (panel numbers match Panel constants)
  switch (panel) {
    case 6: // Terminal
      return " i:input  Esc:exit  j/k:scroll  Tab:cycle  ?:help  q:quit";
    case 3: // Frontier
      return " C:compare  j/k:nav  Enter:detail  +/Esc:zoom  ?:help  q:quit";
    case 7: // Artifact
      return " h/l:cycle  d:diff  j/k:scroll  +/Esc:zoom  ?:help  q:quit";
    case 10: // Search
      return " /:search  j/k:nav  Enter:detail  ?:help  q:quit";
    case 8: // VFS
      return " j/k:nav  Enter:browse  Esc:back  ?:help  q:quit";
    case 16: // Decisions
      return " a:approve  d:deny  j/k:nav  ?:help  q:quit";
    case 15: // Inbox
      return " b:broadcast  @:direct  j/k:nav  ?:help  q:quit";
    default:
      return " 1-4:panel  5-]:toggle  Tab:cycle  j/k:nav  Enter:select  Ctrl+P:spawn  +/Esc:zoom  ?:help  q:quit";
  }
}

/** Bottom status bar with context-sensitive keybinding hints. */
export const StatusBar: React.NamedExoticComponent<StatusBarProps> = React.memo(function StatusBar({
  mode,
  isDetailView,
  error,
  costLabel,
  focusedPanel,
  agentCount,
}: StatusBarProps): React.ReactNode {
  const modeLabel = MODE_LABELS[mode];
  const hints = panelHints(focusedPanel, isDetailView);
  const agentLabel =
    agentCount !== undefined && agentCount > 0 ? `${String(agentCount)} agents` : undefined;

  return (
    <box flexDirection="column">
      {error && (
        <box>
          <text color={theme.error}>Error: {error}</text>
        </box>
      )}
      <box>
        <text color={theme.focus}>[{modeLabel}]</text>
        <text opacity={0.5}>{hints}</text>
        {agentLabel && (
          <text color={theme.muted}>
            {"  "}
            {agentLabel}
          </text>
        )}
        {costLabel && (
          <text color={theme.muted}>
            {"  "}
            {costLabel}
          </text>
        )}
      </box>
    </box>
  );
});
