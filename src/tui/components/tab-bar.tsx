/**
 * Tab bar component for switching between TUI views.
 */

import { Box, Text } from "ink";
import React from "react";
import type { Tab } from "../hooks/use-navigation.js";
import { TAB_LABELS } from "../hooks/use-navigation.js";

/** Props for the TabBar component. */
export interface TabBarProps {
  readonly activeTab: Tab;
}

/** Horizontal tab bar with numbered labels. */
export const TabBar: React.NamedExoticComponent<TabBarProps> = React.memo(function TabBar({
  activeTab,
}: TabBarProps): React.ReactElement {
  return (
    <Box>
      {TAB_LABELS.map((label, i) => {
        const isActive = i === activeTab;
        return (
          <Box key={label} marginRight={2}>
            <Text bold={isActive} color={isActive ? "cyan" : "gray"} underline={isActive}>
              {i + 1}:{label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
});
