/**
 * Responsive breadcrumb bar showing screen context.
 *
 * Viewport breakpoints:
 *   >= 100 cols: Full breadcrumbs: Grove > review-loop > abc123 [Tab]
 *   70-99 cols:  Truncated: review-loop > abc123 [Tab]
 *   < 70 cols:   Screen name + Esc hint
 *   < 40 cols:   Minimal — status only
 */

import React from "react";
import type { Screen } from "../screens/screen-manager.js";
import { theme } from "../theme.js";

export interface BreadcrumbBarProps {
  readonly screen: Screen;
  readonly presetName?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly width: number;
}

const SCREEN_LABELS: Record<Screen, string> = {
  "preset-select": "Preset Select",
  "agent-detect": "Agent Detect",
  "goal-input": "Goal",
  spawning: "Spawning",
  running: "Running",
  advanced: "Advanced",
  complete: "Complete",
};

export const BreadcrumbBar: React.NamedExoticComponent<BreadcrumbBarProps> = React.memo(
  function BreadcrumbBar({
    screen,
    presetName,
    sessionId,
    width,
  }: BreadcrumbBarProps): React.ReactNode {
    const label = SCREEN_LABELS[screen] ?? screen;
    const shortSession = sessionId?.slice(0, 8);

    // Minimal: < 40 cols
    if (width < 40) {
      return (
        <box paddingX={1}>
          <text color={theme.focus} bold>
            {label}
          </text>
        </box>
      );
    }

    // Short: < 70 cols — screen name + Esc hint
    if (width < 70) {
      return (
        <box paddingX={1} flexDirection="row">
          <text color={theme.focus} bold>
            {label}
          </text>
          {screen !== "preset-select" ? (
            <text color={theme.dimmed}> [Esc]</text>
          ) : (
            <text color={theme.dimmed}> [q]uit</text>
          )}
        </box>
      );
    }

    // Medium: 70-99 cols — truncated breadcrumb
    if (width < 100) {
      const parts: React.ReactNode[] = [];
      if (presetName) {
        parts.push(
          <text key="preset" color={theme.muted}>
            {presetName}
          </text>,
        );
        parts.push(
          <text key="sep1" color={theme.dimmed}>
            {" "}
            {"\u203a"}{" "}
          </text>,
        );
      }
      parts.push(
        <text key="screen" color={theme.focus} bold>
          {label}
        </text>,
      );
      if (shortSession) {
        parts.push(
          <text key="sep2" color={theme.dimmed}>
            {" "}
            {"\u203a"}{" "}
          </text>,
        );
        parts.push(
          <text key="sess" color={theme.muted}>
            {shortSession}
          </text>,
        );
      }
      return (
        <box paddingX={1} flexDirection="row">
          {parts}
          {screen !== "preset-select" ? <text color={theme.dimmed}> [Esc]</text> : null}
        </box>
      );
    }

    // Full: >= 100 cols
    const parts: React.ReactNode[] = [];
    parts.push(
      <text key="grove" color={theme.text} bold>
        Grove
      </text>,
    );
    parts.push(
      <text key="sep0" color={theme.dimmed}>
        {" "}
        {"\u203a"}{" "}
      </text>,
    );
    if (presetName) {
      parts.push(
        <text key="preset" color={theme.muted}>
          {presetName}
        </text>,
      );
      parts.push(
        <text key="sep1" color={theme.dimmed}>
          {" "}
          {"\u203a"}{" "}
        </text>,
      );
    }
    parts.push(
      <text key="screen" color={theme.focus} bold>
        {label}
      </text>,
    );
    if (shortSession) {
      parts.push(
        <text key="sep2" color={theme.dimmed}>
          {" "}
          {"\u203a"}{" "}
        </text>,
      );
      parts.push(
        <text key="sess" color={theme.muted}>
          {shortSession}
        </text>,
      );
    }

    return (
      <box paddingX={1} flexDirection="row">
        {parts}
        {screen === "running" || screen === "advanced" ? (
          <text color={theme.dimmed}> [Tab]</text>
        ) : screen !== "preset-select" ? (
          <text color={theme.dimmed}> [Esc]</text>
        ) : null}
      </box>
    );
  },
);
