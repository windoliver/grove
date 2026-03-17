/**
 * Help overlay for the TUI — triggered by `?` key.
 *
 * Shows context-sensitive keybinding reference.
 * Follows the k9s/lazygit convention of `?` for help.
 */

import React from "react";
import { theme } from "../theme.js";

/** Props for the HelpOverlay component. */
export interface HelpOverlayProps {
  readonly visible: boolean;
  /** Whether the user is in a detail view (affects which bindings are shown). */
  readonly isDetailView?: boolean | undefined;
  /** Which panel is focused (for panel-specific hints). */
  readonly focusedPanel?: number | undefined;
}

/** A keybinding entry for display. */
interface KeyBinding {
  readonly key: string;
  readonly description: string;
}

const GLOBAL_BINDINGS: readonly KeyBinding[] = [
  { key: "?", description: "Toggle this help" },
  { key: "q", description: "Quit" },
  { key: "Esc", description: "Back / dismiss / reduce zoom" },
  { key: "Ctrl+P", description: "Command palette" },
  { key: "Tab", description: "Cycle panel focus" },
  { key: "Shift+Tab", description: "Cycle panel focus (reverse)" },
  { key: "+", description: "Zoom cycle (Normal → Half → Full)" },
];

const PANEL_BINDINGS: readonly KeyBinding[] = [
  { key: "1", description: "Focus DAG panel" },
  { key: "2", description: "Focus Detail panel" },
  { key: "3", description: "Focus Frontier panel" },
  { key: "4", description: "Focus Claims panel" },
  { key: "5", description: "Toggle Agents panel" },
  { key: "6", description: "Toggle Terminal panel" },
  { key: "7", description: "Toggle Artifact panel" },
  { key: "8", description: "Toggle VFS panel" },
  { key: "9", description: "Toggle Activity panel" },
  { key: "0", description: "Toggle Search panel" },
  { key: "-", description: "Toggle Threads panel" },
  { key: "=", description: "Toggle Outcomes panel" },
  { key: "[", description: "Toggle Bounties panel" },
  { key: "]", description: "Toggle Gossip panel" },
  { key: "\\", description: "Toggle Inbox panel" },
  { key: ";", description: "Toggle Decisions panel" },
  { key: "'", description: "Toggle GitHub panel" },
];

const NAVIGATION_BINDINGS: readonly KeyBinding[] = [
  { key: "j / \u2193", description: "Move cursor down" },
  { key: "k / \u2191", description: "Move cursor up" },
  { key: "Enter", description: "Select / expand" },
  { key: "n", description: "Next page" },
  { key: "p", description: "Previous page" },
  { key: "r", description: "Refresh" },
];

const DETAIL_BINDINGS: readonly KeyBinding[] = [
  { key: "Esc", description: "Back to list" },
  { key: "j / k", description: "Scroll content" },
];

const ARTIFACT_BINDINGS: readonly KeyBinding[] = [
  { key: "h / \u2190", description: "Previous artifact" },
  { key: "l / \u2192", description: "Next artifact" },
  { key: "d", description: "Toggle diff view" },
];

const TERMINAL_BINDINGS: readonly KeyBinding[] = [
  { key: "i", description: "Enter terminal input mode" },
  { key: "Esc", description: "Exit terminal input mode" },
];

const SEARCH_BINDINGS: readonly KeyBinding[] = [
  { key: "/", description: "Enter search input mode" },
  { key: "Enter", description: "Submit search query" },
  { key: "Esc", description: "Cancel search input" },
];

const MESSAGING_BINDINGS: readonly KeyBinding[] = [
  { key: "b", description: "Broadcast message to all agents" },
  { key: "@", description: "Direct message to agent" },
  { key: "m", description: "MCP/ask-user manager" },
];

const DECISIONS_BINDINGS: readonly KeyBinding[] = [
  { key: "a", description: "Approve pending question" },
  { key: "d", description: "Deny pending question" },
];

const FRONTIER_BINDINGS: readonly KeyBinding[] = [{ key: "C", description: "Compare artifacts" }];

// Panel IDs matching use-panel-focus.ts
const PANEL_ARTIFACT = 7;
const PANEL_TERMINAL = 6;
const PANEL_SEARCH = 10;
const PANEL_DECISIONS = 16;
const PANEL_FRONTIER = 3;

function renderSection(title: string, bindings: readonly KeyBinding[]): React.ReactNode {
  return (
    <box flexDirection="column" key={title}>
      <box>
        <text bold color={theme.focus}>
          {title}
        </text>
      </box>
      {bindings.map((b) => (
        <box key={b.key} paddingLeft={1} flexDirection="row">
          <text color={theme.text} bold>
            {b.key.padEnd(14)}
          </text>
          <text color={theme.muted}>{b.description}</text>
        </box>
      ))}
    </box>
  );
}

/** Help overlay showing keybinding reference. */
export const HelpOverlay: React.NamedExoticComponent<HelpOverlayProps> = React.memo(
  function HelpOverlay({ visible, isDetailView, focusedPanel }: HelpOverlayProps): React.ReactNode {
    if (!visible) return null;

    const sections: React.ReactNode[] = [];

    sections.push(renderSection("Global", GLOBAL_BINDINGS));

    if (isDetailView) {
      sections.push(renderSection("Detail View", DETAIL_BINDINGS));
    } else {
      sections.push(renderSection("Navigation", NAVIGATION_BINDINGS));
      sections.push(renderSection("Panels", PANEL_BINDINGS));
    }

    // Panel-specific bindings
    if (focusedPanel === PANEL_ARTIFACT) {
      sections.push(renderSection("Artifact Panel", ARTIFACT_BINDINGS));
    }
    if (focusedPanel === PANEL_TERMINAL) {
      sections.push(renderSection("Terminal Panel", TERMINAL_BINDINGS));
    }
    if (focusedPanel === PANEL_SEARCH) {
      sections.push(renderSection("Search Panel", SEARCH_BINDINGS));
    }
    if (focusedPanel === PANEL_DECISIONS) {
      sections.push(renderSection("Decisions Panel", DECISIONS_BINDINGS));
    }
    if (focusedPanel === PANEL_FRONTIER) {
      sections.push(renderSection("Frontier Panel", FRONTIER_BINDINGS));
    }

    // Messaging is always available in normal mode
    sections.push(renderSection("Messaging", MESSAGING_BINDINGS));

    return (
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box>
          <text bold color={theme.focus}>
            Keybinding Reference (? to close)
          </text>
        </box>
        <box marginTop={1} flexDirection="column">
          {sections}
        </box>
      </box>
    );
  },
);
