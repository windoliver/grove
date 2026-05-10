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
import type { Page, PageKind } from "../data/pages-store.js";
import type { Screen } from "../screens/screen-manager.js";
import { theme } from "../theme.js";

export interface BreadcrumbBarProps {
  readonly stack?: readonly Page[] | undefined;
  readonly screen?: Screen | undefined;
  readonly presetName?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly width: number;
}

// ---------------------------------------------------------------------------
// Stack-mode helpers
// ---------------------------------------------------------------------------

const PAGE_LABELS: Record<PageKind, string> = {
  "preset-select": "Preset Select",
  "goal-input": "Goal",
  "agent-detect": "Launch Preview",
  "launch-preview": "Launch Preview",
  spawning: "Spawning",
  running: "Running",
  complete: "Complete",
  advanced: "Advanced",
  panel: "Panel",
  "entity-detail": "Detail",
};

const PANEL_LABELS: Record<string, string> = {
  agents: "Agents",
  sessions: "Sessions",
  dag: "DAG",
  tasks: "Tasks",
  reviews: "Reviews",
  feed: "Feed",
};

function pageLabel(p: Page): string {
  if (p.kind === "panel") {
    const panel = p.params?.panel ?? "";
    return PANEL_LABELS[panel] ?? "Panel";
  }
  return PAGE_LABELS[p.kind];
}

function renderStackChain(
  stack: readonly Page[],
  presetName: string | undefined,
  sessionId: string | undefined,
  width: number,
): React.ReactNode {
  const currentPage = stack[stack.length - 1];
  const currentLabel = currentPage ? pageLabel(currentPage) : "";

  // Narrow modes: only show the current label
  if (width < 70) {
    return (
      <box paddingX={1}>
        <text color={theme.focus} bold>
          {currentLabel}
        </text>
      </box>
    );
  }

  const shortSession = sessionId?.slice(0, 8);
  const parts: React.ReactNode[] = [];

  // >= 100: prepend "Grove ›"
  if (width >= 100) {
    parts.push(
      <text key="grove" color={theme.text} bold>
        Grove
      </text>,
    );
    parts.push(
      <text key="sep-grove" color={theme.secondary}>
        {" "}
        {"›"}{" "}
      </text>,
    );
  }

  // Optional presetName at front
  if (presetName) {
    parts.push(
      <text key="preset" color={theme.secondary}>
        {presetName}
      </text>,
    );
    parts.push(
      <text key="sep-preset" color={theme.secondary}>
        {" "}
        {"›"}{" "}
      </text>,
    );
  }

  // Full stack chain: prior pages as secondary, current page as focus/bold
  for (let i = 0; i < stack.length; i++) {
    const page = stack[i];
    if (!page) continue;
    const label = pageLabel(page);
    const isCurrent = i === stack.length - 1;
    if (i > 0) {
      parts.push(
        <text key={`sep-${i}`} color={theme.secondary}>
          {" "}
          {"›"}{" "}
        </text>,
      );
    }
    parts.push(
      isCurrent ? (
        <text key={`page-${i}`} color={theme.focus} bold>
          {label}
        </text>
      ) : (
        <text key={`page-${i}`} color={theme.secondary}>
          {label}
        </text>
      ),
    );
  }

  // Optional shortSession at end
  if (shortSession) {
    parts.push(
      <text key="sep-sess" color={theme.secondary}>
        {" "}
        {"›"}{" "}
      </text>,
    );
    parts.push(
      <text key="sess" color={theme.secondary}>
        {shortSession}
      </text>,
    );
  }

  return (
    <box paddingX={1} flexDirection="row">
      {parts}
    </box>
  );
}

const SCREEN_LABELS: Record<Screen, string> = {
  "preset-select": "Preset Select",
  "agent-detect": "Launch Preview",
  "launch-preview": "Launch Preview",
  "goal-input": "Goal",
  spawning: "Spawning",
  running: "Running",
  advanced: "Advanced",
  complete: "Complete",
};

export const BreadcrumbBar: React.NamedExoticComponent<BreadcrumbBarProps> = React.memo(
  function BreadcrumbBar({
    stack,
    screen,
    presetName,
    sessionId,
    width,
  }: BreadcrumbBarProps): React.ReactNode {
    // Stack mode: when stack is provided and non-empty, use new rendering path
    if (stack && stack.length > 0) {
      return renderStackChain(stack, presetName, sessionId, width);
    }

    // Legacy mode: screen-based rendering (unchanged)
    const label = SCREEN_LABELS[screen ?? "preset-select"] ?? (screen as string);
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
          {screen !== "preset-select" && screen !== undefined ? (
            <text color={theme.secondary}> [Esc]</text>
          ) : (
            <text color={theme.secondary}> [q]uit</text>
          )}
        </box>
      );
    }

    // Medium: 70-99 cols — truncated breadcrumb
    if (width < 100) {
      const parts: React.ReactNode[] = [];
      if (presetName) {
        parts.push(
          <text key="preset" color={theme.secondary}>
            {presetName}
          </text>,
        );
        parts.push(
          <text key="sep1" color={theme.secondary}>
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
          <text key="sep2" color={theme.secondary}>
            {" "}
            {"\u203a"}{" "}
          </text>,
        );
        parts.push(
          <text key="sess" color={theme.secondary}>
            {shortSession}
          </text>,
        );
      }
      return (
        <box paddingX={1} flexDirection="row">
          {parts}
          {screen !== "preset-select" && screen !== undefined ? (
            <text color={theme.secondary}> [Esc]</text>
          ) : null}
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
      <text key="sep0" color={theme.secondary}>
        {" "}
        {"\u203a"}{" "}
      </text>,
    );
    if (presetName) {
      parts.push(
        <text key="preset" color={theme.secondary}>
          {presetName}
        </text>,
      );
      parts.push(
        <text key="sep1" color={theme.secondary}>
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
        <text key="sep2" color={theme.secondary}>
          {" "}
          {"\u203a"}{" "}
        </text>,
      );
      parts.push(
        <text key="sess" color={theme.secondary}>
          {shortSession}
        </text>,
      );
    }

    return (
      <box paddingX={1} flexDirection="row">
        {parts}
        {screen === "running" || screen === "advanced" ? (
          <text color={theme.secondary}> [Tab]</text>
        ) : screen !== "preset-select" && screen !== undefined ? (
          <text color={theme.secondary}> [Esc]</text>
        ) : null}
      </box>
    );
  },
);
