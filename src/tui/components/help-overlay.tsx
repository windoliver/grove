/**
 * Help overlay for the TUI — triggered by `?` key.
 *
 * Shows context-sensitive keybinding reference.
 * Follows the k9s/lazygit convention of `?` for help.
 */

import React from "react";
import {
  DEFAULT_KEY_ACTIONS,
  type KeybindingOverrides,
  type RemappableAction,
} from "../hooks/use-keybinding-overrides.js";
import { Panel } from "../hooks/use-panel-focus.js";
import { PANEL_REGISTRY } from "../panels/panel-registry.js";
import { theme } from "../theme.js";

/** Props for the HelpOverlay component. */
export interface HelpOverlayProps {
  readonly visible: boolean;
  /** Whether the user is in a detail view (affects which bindings are shown). */
  readonly isDetailView?: boolean | undefined;
  /** Which panel is focused (for panel-specific hints). */
  readonly focusedPanel?: number | undefined;
  /** Active keybinding overrides — merged config + file-based. Shows remapped keys. */
  readonly keybindingOverrides?: KeybindingOverrides | undefined;
}

/** Return the active key for a remappable action (override or default). */
function activeKey(action: RemappableAction, overrides: KeybindingOverrides | undefined): string {
  return overrides?.[action] ?? DEFAULT_KEY_ACTIONS[action];
}

/** A keybinding entry for display. */
interface KeyBinding {
  readonly key: string;
  readonly description: string;
}

function globalBindings(overrides: KeybindingOverrides | undefined): readonly KeyBinding[] {
  return [
    { key: activeKey("help", overrides), description: "Toggle this help" },
    { key: activeKey("quit", overrides), description: "Quit" },
    { key: activeKey("zoom_reset", overrides), description: "Back / dismiss / reduce zoom" },
    { key: "Ctrl+G", description: "Back to Session View" },
    { key: "Ctrl+P", description: "Command palette" },
    { key: "Tab", description: "Cycle panel focus" },
    { key: "Shift+Tab", description: "Cycle panel focus (reverse)" },
    { key: activeKey("zoom_cycle", overrides), description: "Zoom cycle (Normal → Half → Full)" },
  ];
}

/** Panel keybindings derived from the registry — single source of truth. */
const PANEL_BINDINGS: readonly KeyBinding[] = PANEL_REGISTRY.map((def) => ({
  key: def.keybinding,
  description: `${def.kind === "core" ? "Focus" : "Toggle"} ${def.label} panel`,
}));

function navigationBindings(overrides: KeybindingOverrides | undefined): readonly KeyBinding[] {
  return [
    { key: "j / \u2193", description: "Move cursor down" },
    { key: "k / \u2191", description: "Move cursor up" },
    { key: "Enter", description: "Select / expand" },
    { key: "n", description: "Next page" },
    { key: "p", description: "Previous page" },
    { key: activeKey("refresh", overrides), description: "Refresh" },
  ];
}

const DETAIL_BINDINGS: readonly KeyBinding[] = [
  { key: "Esc", description: "Back to list" },
  { key: "j / k", description: "Scroll content" },
];

function artifactBindings(overrides: KeybindingOverrides | undefined): readonly KeyBinding[] {
  return [
    { key: `${activeKey("artifact_prev", overrides)} / \u2190`, description: "Previous artifact" },
    { key: `${activeKey("artifact_next", overrides)} / \u2192`, description: "Next artifact" },
    { key: activeKey("artifact_diff", overrides), description: "Toggle diff view" },
  ];
}

function terminalBindings(overrides: KeybindingOverrides | undefined): readonly KeyBinding[] {
  return [
    { key: activeKey("terminal_input", overrides), description: "Enter terminal input mode" },
    { key: "Esc", description: "Exit terminal input mode" },
  ];
}

function searchBindings(overrides: KeybindingOverrides | undefined): readonly KeyBinding[] {
  return [
    { key: activeKey("search_start", overrides), description: "Enter search input mode" },
    { key: "Enter", description: "Submit search query" },
    { key: "Esc", description: "Cancel search input" },
  ];
}

function messagingBindings(overrides: KeybindingOverrides | undefined): readonly KeyBinding[] {
  return [
    { key: activeKey("broadcast", overrides), description: "Broadcast message to all agents" },
    { key: activeKey("direct_message", overrides), description: "Direct message to agent" },
    { key: "m", description: "MCP/ask-user manager" },
  ];
}

function decisionsBindings(overrides: KeybindingOverrides | undefined): readonly KeyBinding[] {
  return [
    { key: activeKey("approve", overrides), description: "Approve pending question" },
    { key: activeKey("deny", overrides), description: "Deny pending question" },
  ];
}

function frontierBindings(overrides: KeybindingOverrides | undefined): readonly KeyBinding[] {
  return [{ key: activeKey("compare_toggle", overrides), description: "Compare artifacts" }];
}

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
          <text color={theme.secondary}>{b.description}</text>
        </box>
      ))}
    </box>
  );
}

/** Help overlay showing keybinding reference. */
export const HelpOverlay: React.NamedExoticComponent<HelpOverlayProps> = React.memo(
  function HelpOverlay({
    visible,
    isDetailView,
    focusedPanel,
    keybindingOverrides,
  }: HelpOverlayProps): React.ReactNode {
    if (!visible) return null;

    const sections: React.ReactNode[] = [];

    sections.push(renderSection("Global", globalBindings(keybindingOverrides)));

    if (isDetailView) {
      sections.push(renderSection("Detail View", DETAIL_BINDINGS));
    } else {
      sections.push(renderSection("Navigation", navigationBindings(keybindingOverrides)));
      sections.push(renderSection("Panels", PANEL_BINDINGS));
    }

    // Panel-specific bindings
    if (focusedPanel === Panel.Artifact) {
      sections.push(renderSection("Artifact Panel", artifactBindings(keybindingOverrides)));
    }
    if (focusedPanel === Panel.Terminal) {
      sections.push(renderSection("Terminal Panel", terminalBindings(keybindingOverrides)));
    }
    if (focusedPanel === Panel.Search) {
      sections.push(renderSection("Search Panel", searchBindings(keybindingOverrides)));
    }
    if (focusedPanel === Panel.Decisions) {
      sections.push(renderSection("Decisions Panel", decisionsBindings(keybindingOverrides)));
    }
    if (focusedPanel === Panel.Frontier) {
      sections.push(renderSection("Frontier Panel", frontierBindings(keybindingOverrides)));
    }

    // Messaging is always available in normal mode
    sections.push(renderSection("Messaging", messagingBindings(keybindingOverrides)));

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
