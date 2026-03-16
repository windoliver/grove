/**
 * Extracted keyboard handler for the TUI.
 *
 * Pure routing function exported separately from the React hook
 * for testability (same pattern as use-panel-focus.ts).
 */

import type { KeyEvent } from "@opentui/core";
import type { ZoomLevel } from "../panels/panel-manager.js";
import type { NavigationActions } from "./use-navigation.js";
import { InputMode, Panel, type PanelFocusActions } from "./use-panel-focus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All the mutable actions the keyboard handler can trigger. */
export interface KeyboardActions {
  readonly panels: PanelFocusActions;
  readonly nav: NavigationActions;
  readonly onQuit: () => void;
  readonly onSpawnPalette: () => void;
  readonly onVfsNavigate: () => void;
  readonly onArtifactPrev: () => void;
  readonly onArtifactNext: () => void;
  readonly onArtifactDiffToggle: () => void;
  readonly onCompareToggle: () => void;
  readonly onCompareSelect: (cid: string) => void;
  readonly onSearchSubmit: (query: string) => void;
  readonly onSearchChar: (char: string) => void;
  readonly onSearchBackspace: () => void;
  readonly onMessageSubmit: () => void;
  readonly onMessageChar: (char: string) => void;
  readonly onMessageBackspace: () => void;
  readonly onApproveQuestion: () => void;
  readonly onDenyQuestion: () => void;
  readonly onSendKeys: (key: string) => void;
  readonly onPaletteUp: () => void;
  readonly onPaletteDown: (maxIndex: number) => void;
  readonly onPaletteSelect: () => void;
  readonly onZoomCycle: () => void;
  readonly onSelect: (index: number) => void;
  readonly rowCount: number;
  readonly pageSize: number;
  readonly compareMode: boolean;
  readonly frontierCids: readonly string[];
  readonly selectedSession: string | undefined;
  readonly hasTmux: boolean;
}

// ---------------------------------------------------------------------------
// Pure routing function
// ---------------------------------------------------------------------------

/** Zoom level cycle: normal → half → full → normal. */
export function nextZoom(current: ZoomLevel): ZoomLevel {
  switch (current) {
    case "normal":
      return "half";
    case "half":
      return "full";
    case "full":
      return "normal";
  }
}

/**
 * Route a key event to the appropriate action.
 *
 * Returns true if the key was handled, false otherwise.
 * This is a pure function — all side effects go through the actions object.
 */
export function routeKey(key: KeyEvent, actions: KeyboardActions): boolean {
  const input = key.name;
  const isCtrl = key.ctrl;
  const mode = actions.panels.state.mode;
  const focused = actions.panels.state.focused;

  // Command palette toggle (works in all modes except help)
  if (isCtrl && input === "p") {
    if (mode === InputMode.CommandPalette) {
      actions.panels.setMode(InputMode.Normal);
    } else {
      actions.onSpawnPalette();
      actions.panels.setMode(InputMode.CommandPalette);
    }
    return true;
  }

  // Escape always exits current mode, or pops detail, or reduces zoom
  if (input === "escape") {
    if (mode !== InputMode.Normal) {
      actions.panels.setMode(InputMode.Normal);
      return true;
    }
    if (actions.nav.isDetailView) {
      actions.nav.popDetail();
      return true;
    }
    // Escape in normal mode with no detail view → cycle zoom back
    actions.onZoomCycle();
    return true;
  }

  // In help mode, ? toggles off
  if (mode === InputMode.Help) {
    if (input === "?" || (key.shift && input === "/")) {
      actions.panels.setMode(InputMode.Normal);
    }
    return true;
  }

  // In terminal input mode, forward keystrokes to tmux
  if (mode === InputMode.TerminalInput) {
    if (actions.hasTmux && actions.selectedSession && input) {
      actions.onSendKeys(input);
    }
    return true;
  }

  // Command palette navigation
  if (mode === InputMode.CommandPalette) {
    if (input === "j" || input === "down") {
      actions.onPaletteDown(0); // maxIndex handled by caller
      return true;
    }
    if (input === "k" || input === "up") {
      actions.onPaletteUp();
      return true;
    }
    if (input === "return") {
      actions.onPaletteSelect();
      return true;
    }
    return true;
  }

  // Search input mode
  if (mode === InputMode.SearchInput) {
    if (input === "return") {
      actions.onSearchSubmit("");
      return true;
    }
    if (input === "backspace") {
      actions.onSearchBackspace();
      return true;
    }
    if (input && input.length === 1 && !isCtrl) {
      actions.onSearchChar(input);
      return true;
    }
    return true;
  }

  // Message input mode
  if (mode === InputMode.MessageInput) {
    if (input === "return") {
      actions.onMessageSubmit();
      return true;
    }
    if (input === "backspace") {
      actions.onMessageBackspace();
      return true;
    }
    if (input && input.length === 1 && !isCtrl) {
      actions.onMessageChar(input);
      return true;
    }
    return true;
  }

  // Help overlay toggle
  if (input === "?" || (key.shift && input === "/")) {
    actions.panels.setMode(InputMode.Help);
    return true;
  }

  // Normal mode keybindings
  if (input === "q") {
    actions.onQuit();
    return true;
  }

  // Panel focus: 1-4
  if (input === "1") {
    actions.panels.focus(Panel.Dag);
    return true;
  }
  if (input === "2") {
    actions.panels.focus(Panel.Detail);
    return true;
  }
  if (input === "3") {
    actions.panels.focus(Panel.Frontier);
    return true;
  }
  if (input === "4") {
    actions.panels.focus(Panel.Claims);
    return true;
  }

  // Panel toggle: 5-=, [, ], \, ;, '
  if (input === "5") {
    actions.panels.toggle(Panel.AgentList);
    return true;
  }
  if (input === "6") {
    actions.panels.toggle(Panel.Terminal);
    return true;
  }
  if (input === "7") {
    actions.panels.toggle(Panel.Artifact);
    return true;
  }
  if (input === "8") {
    actions.panels.toggle(Panel.Vfs);
    return true;
  }
  if (input === "9") {
    actions.panels.toggle(Panel.Activity);
    return true;
  }
  if (input === "0") {
    actions.panels.toggle(Panel.Search);
    return true;
  }
  if (input === "-") {
    actions.panels.toggle(Panel.Threads);
    return true;
  }
  if (input === "=") {
    actions.panels.toggle(Panel.Outcomes);
    return true;
  }
  if (input === "[") {
    actions.panels.toggle(Panel.Bounties);
    return true;
  }
  if (input === "]") {
    actions.panels.toggle(Panel.Gossip);
    return true;
  }
  if (input === "\\") {
    actions.panels.toggle(Panel.Inbox);
    return true;
  }
  if (input === ";") {
    actions.panels.toggle(Panel.Decisions);
    return true;
  }
  if (input === "'") {
    actions.panels.toggle(Panel.GitHub);
    return true;
  }

  // Tab/Shift+Tab: cycle focus
  if (input === "tab") {
    if (key.shift) {
      actions.panels.cyclePrev();
    } else {
      actions.panels.cycleNext();
    }
    return true;
  }

  // Zoom cycle: + key
  if (input === "+" || (key.shift && input === "=")) {
    actions.onZoomCycle();
    return true;
  }

  // Terminal input mode entry
  if (input === "i" && focused === Panel.Terminal) {
    actions.panels.setMode(InputMode.TerminalInput);
    return true;
  }

  // Search input mode entry
  if (input === "/" && focused === Panel.Search) {
    actions.panels.setMode(InputMode.SearchInput);
    return true;
  }

  // Broadcast message
  if (input === "b") {
    actions.onMessageChar(""); // triggers broadcast mode
    actions.panels.setMode(InputMode.MessageInput);
    return true;
  }

  // Direct message
  if (input === "@") {
    actions.onMessageChar("@");
    actions.panels.setMode(InputMode.MessageInput);
    return true;
  }

  // Approve/Deny pending question (Decisions panel)
  if (input === "a" && focused === Panel.Decisions) {
    actions.onApproveQuestion();
    return true;
  }
  if (input === "d" && focused === Panel.Decisions) {
    actions.onDenyQuestion();
    return true;
  }

  // MCP/ask-user manager
  if (input === "m") {
    actions.onSpawnPalette();
    actions.panels.setMode(InputMode.CommandPalette);
    return true;
  }

  // Compare artifacts (Frontier panel)
  if (input === "C" && focused === Panel.Frontier) {
    actions.onCompareToggle();
    return true;
  }

  // Within-panel navigation
  if (input === "j" || input === "down") {
    actions.nav.cursorDown(Math.max(0, actions.rowCount - 1));
    return true;
  }
  if (input === "k" || input === "up") {
    actions.nav.cursorUp();
    return true;
  }

  if (input === "return") {
    if (focused === Panel.Vfs) {
      actions.onVfsNavigate();
      return true;
    }
    if (actions.compareMode && focused === Panel.Frontier && actions.frontierCids.length > 0) {
      const cid = actions.frontierCids[actions.nav.state.cursor];
      if (cid) actions.onCompareSelect(cid);
      return true;
    }
    const isClaimsPanel = focused === Panel.Claims;
    if (!actions.nav.isDetailView && !isClaimsPanel && actions.rowCount > 0) {
      actions.onSelect(actions.nav.state.cursor);
    }
    return true;
  }

  if (input === "n") {
    const hasFullPage = actions.rowCount >= actions.pageSize;
    const totalItems = hasFullPage
      ? actions.nav.state.pageOffset + actions.rowCount + 1
      : actions.nav.state.pageOffset + actions.rowCount;
    actions.nav.nextPage(actions.pageSize, totalItems);
    return true;
  }
  if (input === "p") {
    actions.nav.prevPage(actions.pageSize);
    return true;
  }

  // Artifact panel actions
  if (focused === Panel.Artifact && actions.compareMode) {
    if (input === "a") {
      actions.onCompareSelect("a");
      return true;
    }
    if (input === "b") {
      actions.onCompareSelect("b");
      return true;
    }
  }
  if (focused === Panel.Artifact) {
    if (input === "h" || input === "left") {
      actions.onArtifactPrev();
      return true;
    }
    if (input === "l" || input === "right") {
      actions.onArtifactNext();
      return true;
    }
    if (input === "d") {
      actions.onArtifactDiffToggle();
      return true;
    }
  }

  if (input === "r") return true; // refresh — handled by polling

  return false;
}
