/**
 * Extracted keyboard handler for the TUI.
 *
 * Pure routing function exported separately from the React hook
 * for testability (same pattern as use-panel-focus.ts).
 */

import type { KeyEvent } from "@opentui/core";
import type { ZoomLevel } from "../panels/panel-manager.js";
import type { KeybindingOverrides } from "./use-keybinding-overrides.js";
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
  readonly onCompareAdopt: (side: "a" | "b") => void;
  readonly onSearchStart: () => void;
  readonly onSearchSubmit: () => void;
  readonly onSearchChar: (char: string) => void;
  readonly onSearchBackspace: () => void;
  readonly onMessageSubmit: () => void;
  readonly onMessageChar: (char: string) => void;
  readonly onMessageBackspace: () => void;
  readonly onBroadcastMode: () => void;
  readonly onDirectMessageMode: () => void;
  readonly onGoalSubmit: () => void;
  readonly onGoalChar: (char: string) => void;
  readonly onGoalBackspace: () => void;
  readonly onApproveQuestion: () => void;
  readonly onDenyQuestion: () => void;
  readonly onSendKeys: (key: string) => void;
  readonly onPaletteUp: () => void;
  readonly onPaletteDown: (maxIndex: number) => void;
  readonly onPaletteSelect: () => void;
  readonly onZoomCycle: () => void;
  readonly onZoomReset: () => void;
  readonly onTerminalScrollUp: () => void;
  readonly onTerminalScrollDown: () => void;
  readonly onTerminalScrollBottom: () => void;
  readonly onLayoutToggle: () => void;
  readonly onSelect: (index: number) => void;
  readonly rowCount: number;
  readonly pageSize: number;
  readonly paletteItemCount: number;
  readonly compareMode: boolean;
  readonly frontierCids: readonly string[];
  readonly selectedSession: string | undefined;
  readonly hasTmux: boolean;
  /** Keybinding overrides from .grove/keybindings.json (item 19). */
  readonly keybindingOverrides?: KeybindingOverrides | undefined;
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

  // Keybinding overrides (item 19): check if this key maps to a remapped action.
  // Override lookup only applies in normal mode to avoid breaking modal input.
  const overrides = actions.keybindingOverrides;
  if (mode === InputMode.Normal && overrides && input && !isCtrl) {
    // Reverse lookup: find which action this key is mapped to
    for (const [action, boundKey] of Object.entries(overrides)) {
      if (boundKey === input) {
        switch (action) {
          case "quit":
            actions.onQuit();
            return true;
          case "help":
            actions.panels.setMode(InputMode.Help);
            return true;
          case "zoom_cycle":
            actions.onZoomCycle();
            return true;
          case "zoom_reset":
            actions.onZoomReset();
            return true;
          case "broadcast":
            actions.onBroadcastMode();
            return true;
          case "direct_message":
            actions.onDirectMessageMode();
            return true;
          case "search_start":
            if (focused === Panel.Search) actions.onSearchStart();
            return true;
          case "terminal_input":
            if (focused === Panel.Terminal) actions.panels.setMode(InputMode.TerminalInput);
            return true;
          case "compare_toggle":
            if (focused === Panel.Frontier) actions.onCompareToggle();
            return true;
          case "artifact_prev":
            if (focused === Panel.Artifact) actions.onArtifactPrev();
            return true;
          case "artifact_next":
            if (focused === Panel.Artifact) actions.onArtifactNext();
            return true;
          case "artifact_diff":
            if (focused === Panel.Artifact) actions.onArtifactDiffToggle();
            return true;
          case "approve":
            if (focused === Panel.Decisions) actions.onApproveQuestion();
            return true;
          case "deny":
            if (focused === Panel.Decisions) actions.onDenyQuestion();
            return true;
          case "refresh":
            return true;
          case "palette":
            actions.onSpawnPalette();
            actions.panels.setMode(InputMode.CommandPalette);
            return true;
        }
      }
    }
  }

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

  // Escape: one effect per keypress, highest-priority first.
  // Priority: (1) exit mode → (2) pop detail → (3) reset zoom
  if (input === "escape") {
    if (mode !== InputMode.Normal) {
      actions.panels.setMode(InputMode.Normal);
      return true;
    }
    if (actions.nav.isDetailView) {
      actions.nav.popDetail();
      return true;
    }
    // Reset zoom to normal (not cycle — Escape is "go back", not "go forward")
    actions.onZoomReset();
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
      actions.onPaletteDown(Math.max(0, actions.paletteItemCount - 1));
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
      actions.onSearchSubmit();
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

  // Goal input mode
  if (mode === InputMode.GoalInput) {
    if (input === "return") {
      actions.onGoalSubmit();
      return true;
    }
    if (input === "backspace") {
      actions.onGoalBackspace();
      return true;
    }
    if (input === "space") {
      actions.onGoalChar(" ");
      return true;
    }
    if (input && input.length === 1 && !isCtrl) {
      actions.onGoalChar(input);
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

  // Layout toggle: + key (tab <-> grid)
  if (input === "+" || (key.shift && input === "=")) {
    actions.onLayoutToggle();
    return true;
  }

  // View mode cycle: V key (item 11 — grid ↔ pipeline)
  if (input === "V" || (key.shift && input === "v")) {
    actions.panels.cycleViewMode();
    return true;
  }

  // Terminal input mode entry
  if (input === "i" && focused === Panel.Terminal) {
    actions.panels.setMode(InputMode.TerminalInput);
    return true;
  }

  // Search input mode entry
  if (input === "/" && focused === Panel.Search) {
    actions.onSearchStart();
    return true;
  }

  // Panel-specific keys — must be checked BEFORE global keys like "b"/"d"
  // because they are more specific (panel + mode gated).

  // Terminal panel: j/k scroll output, G un-pins (item 9)
  if (focused === Panel.Terminal) {
    if (input === "j" || input === "down") {
      actions.onTerminalScrollDown();
      return true;
    }
    if (input === "k" || input === "up") {
      actions.onTerminalScrollUp();
      return true;
    }
    if (input === "G" || (key.shift && input === "g")) {
      actions.onTerminalScrollBottom();
      return true;
    }
  }

  // Artifact panel: adopt compared contribution (a/b)
  if (focused === Panel.Artifact && actions.compareMode) {
    if (input === "a") {
      actions.onCompareAdopt("a");
      return true;
    }
    if (input === "b") {
      actions.onCompareAdopt("b");
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

  // Approve/Deny pending question (Decisions panel)
  if (input === "a" && focused === Panel.Decisions) {
    actions.onApproveQuestion();
    return true;
  }
  if (input === "d" && focused === Panel.Decisions) {
    actions.onDenyQuestion();
    return true;
  }

  // Compare artifacts (Frontier panel)
  if (input === "C" && focused === Panel.Frontier) {
    actions.onCompareToggle();
    return true;
  }

  // Global keys — only reached if no panel-specific handler matched

  // Broadcast message
  if (input === "b") {
    actions.onBroadcastMode();
    return true;
  }

  // Direct message
  if (input === "@") {
    actions.onDirectMessageMode();
    return true;
  }

  // MCP/ask-user manager
  if (input === "m") {
    actions.onSpawnPalette();
    actions.panels.setMode(InputMode.CommandPalette);
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

  if (input === "r") return true; // refresh — handled by polling

  return false;
}
