/**
 * Status bar component shown at the bottom of the TUI.
 *
 * Displays available keyboard shortcuts and current view context.
 */

import { Box, Text } from "ink";
import React from "react";

/** Props for the StatusBar component. */
export interface StatusBarProps {
  /** Whether we're in a detail view. */
  readonly isDetailView: boolean;
  /** Error message to display, if any. */
  readonly error?: string | undefined;
  /** Last refresh timestamp. */
  readonly lastRefresh?: string | undefined;
}

/** Bottom status bar with keybinding hints. */
export const StatusBar: React.NamedExoticComponent<StatusBarProps> = React.memo(function StatusBar({
  isDetailView,
  error,
  lastRefresh,
}: StatusBarProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      {error && (
        <Box>
          <Text color="red" bold>
            Error: {error}
          </Text>
        </Box>
      )}
      <Box>
        <Text dimColor>
          {isDetailView
            ? " Esc:back  j/k:scroll  r:refresh  q:quit"
            : " 1-4:tab  j/k:nav  Enter:detail  n/p:page  r:refresh  q:quit"}
        </Text>
        {lastRefresh && (
          <Text dimColor>
            {"  "}| updated {lastRefresh}
          </Text>
        )}
      </Box>
    </Box>
  );
});
