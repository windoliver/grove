/**
 * Status bar component shown at the bottom of the TUI.
 *
 * Displays available keyboard shortcuts, current input mode, and errors.
 */

import React from "react";
import type { InputMode } from "../hooks/use-panel-focus.js";

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

/** Bottom status bar with keybinding hints. */
export const StatusBar: React.NamedExoticComponent<StatusBarProps> = React.memo(function StatusBar({
  mode,
  isDetailView,
  error,
  costLabel,
}: StatusBarProps): React.ReactNode {
  const modeLabel = MODE_LABELS[mode];

  return (
    <box flexDirection="column">
      {error && (
        <box>
          <text color="#ff0000">Error: {error}</text>
        </box>
      )}
      <box>
        <text color="#00cccc">[{modeLabel}]</text>
        <text opacity={0.5}>
          {isDetailView
            ? " Esc:back  j/k:scroll  r:refresh  ?:help  q:quit"
            : " 1-4:panel  5-]:toggle  Tab:cycle  j/k:nav  Enter:select  Ctrl+P:cmd  ?:help  q:quit"}
        </text>
        {costLabel && (
          <text color="#888888">
            {"  "}
            {costLabel}
          </text>
        )}
      </box>
    </box>
  );
});
