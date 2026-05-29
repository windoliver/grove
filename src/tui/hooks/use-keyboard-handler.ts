/**
 * Extracted keyboard handler for the TUI.
 *
 * Pure routing function exported separately from the React hook
 * for testability (same pattern as use-panel-focus.ts).
 */

import type { KeyEvent } from "@opentui/core";
import {
  type KeyBinding,
  keyEventToToken,
  type ResolvedKeymap,
  resolveKeySequence,
} from "../keymap/keymap.js";
import type { ZoomLevel } from "../panels/panel-manager.js";
import { PANEL_REGISTRY } from "../panels/panel-registry.js";
import { isHelpToggleKey } from "./shared-keyboard-core.js";
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
  /** Called whenever the command palette is dismissed (any path). Clears
   *  adoptContext + palette state so leftover targets don't leak into the
   *  next unrelated spawn. */
  readonly onPaletteClose: () => void;
  readonly onVfsNavigate: () => void;
  readonly onArtifactPrev: () => void;
  readonly onArtifactNext: () => void;
  readonly onArtifactDiffToggle: () => void;
  readonly onArtifactDiffModeToggle: () => void;
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
  readonly onPaletteChar: (char: string) => void;
  readonly onPaletteBackspace: () => void;
  readonly onDetailSectionNext: () => void;
  readonly onDetailSectionPrev: () => void;
  readonly onZoomCycle: () => void;
  readonly onZoomReset: () => void;
  readonly onTerminalScrollUp: () => void;
  readonly onTerminalScrollDown: () => void;
  readonly onTerminalScrollBottom: () => void;
  readonly onLayoutToggle: () => void;
  readonly onRefresh: () => void;
  readonly onSelect: (index: number) => void;
  readonly rowCount: number;
  readonly pageSize: number;
  readonly paletteItemCount: number;
  readonly onFrontierTabNext: () => void;
  readonly onFrontierTabPrev: () => void;
  readonly onFrontierAdopt: (cid: string, summary: string) => void;
  /** Entries (cid + summary) for the currently visible frontier slice.
   *  Resolved on each call so the value reflects the latest slice nav,
   *  even if it happened in the same JS tick before React committed. */
  readonly frontierEntries: () => ReadonlyArray<{ cid: string; summary: string }>;
  readonly compareMode: boolean;
  /** Cids for the currently visible frontier slice. Function form so the
   *  keyboard handler reads the latest ref-backed value (slice nav clears
   *  the ref synchronously; state-based array would lag by a render). */
  readonly frontierCids: () => readonly string[];
  readonly selectedSession: string | undefined;
  readonly hasTmux: boolean;
  readonly resolvedKeymap?: ResolvedKeymap | undefined;
  readonly keymapPrefix?: readonly string[] | undefined;
  readonly onKeymapPrefixChange?: (prefix: readonly string[]) => void;
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

export function executeKeymapAction(binding: KeyBinding, actions: KeyboardActions): boolean {
  const focused = actions.panels.state.focused;
  switch (binding.action) {
    case "quit":
      actions.onQuit();
      return true;
    case "help":
      actions.panels.setMode(InputMode.Help);
      return true;
    case "palette":
      actions.onSpawnPalette();
      actions.panels.setMode(InputMode.CommandPalette);
      return true;
    case "refresh":
      actions.onRefresh();
      return true;
    case "zoom_cycle":
      actions.onZoomCycle();
      return true;
    case "zoom_reset":
      actions.onZoomReset();
      return true;
    case "layout_toggle":
      actions.onLayoutToggle();
      return true;
    case "view_cycle":
      actions.panels.cycleViewMode();
      return true;
    case "cycle_panel_next":
      actions.panels.cycleNext();
      return true;
    case "cycle_panel_prev":
      actions.panels.cyclePrev();
      return true;
    case "focus_panel":
      actions.panels.focus(binding.panel);
      return true;
    case "toggle_panel":
      actions.panels.toggle(binding.panel);
      return true;
    case "broadcast":
      actions.onBroadcastMode();
      return true;
    case "direct_message":
      actions.onDirectMessageMode();
      return true;
    case "search_start":
      if (focused !== Panel.Search) return false;
      actions.onSearchStart();
      return true;
    case "terminal_input":
      if (focused !== Panel.Terminal) return false;
      actions.panels.setMode(InputMode.TerminalInput);
      return true;
    case "compare_toggle":
      if (focused !== Panel.Frontier) return false;
      actions.onCompareToggle();
      return true;
    case "artifact_prev":
      if (focused !== Panel.Artifact) return false;
      actions.onArtifactPrev();
      return true;
    case "artifact_next":
      if (focused !== Panel.Artifact) return false;
      actions.onArtifactNext();
      return true;
    case "artifact_diff":
      if (focused !== Panel.Artifact) return false;
      actions.onArtifactDiffToggle();
      return true;
    case "approve":
      if (focused !== Panel.Decisions) return false;
      actions.onApproveQuestion();
      return true;
    case "deny":
      if (focused !== Panel.Decisions) return false;
      actions.onDenyQuestion();
      return true;
    case "cursor_down":
      if (actions.nav.isDetailView) {
        actions.onDetailSectionNext();
        return true;
      }
      actions.nav.cursorDown(Math.max(0, actions.rowCount - 1));
      return true;
    case "cursor_up":
      if (actions.nav.isDetailView) {
        actions.onDetailSectionPrev();
        return true;
      }
      actions.nav.cursorUp();
      return true;
    case "select":
      if (!actions.nav.isDetailView && focused !== Panel.Claims && actions.rowCount > 0) {
        actions.onSelect(actions.nav.state.cursor);
      }
      return true;
    case "page_next": {
      const hasFullPage = actions.rowCount >= actions.pageSize;
      const totalItems = hasFullPage
        ? actions.nav.state.pageOffset + actions.rowCount + 1
        : actions.nav.state.pageOffset + actions.rowCount;
      actions.nav.nextPage(actions.pageSize, totalItems);
      return true;
    }
    case "page_prev":
      actions.nav.prevPage(actions.pageSize);
      return true;
    case "vfs_navigate":
      if (focused !== Panel.Vfs) return false;
      actions.onVfsNavigate();
      return true;
    case "terminal_scroll_up":
      if (focused !== Panel.Terminal) return false;
      actions.onTerminalScrollUp();
      return true;
    case "terminal_scroll_down":
      if (focused !== Panel.Terminal) return false;
      actions.onTerminalScrollDown();
      return true;
    case "terminal_scroll_bottom":
      if (focused !== Panel.Terminal) return false;
      actions.onTerminalScrollBottom();
      return true;
    case "frontier_tab_next":
      if (focused !== Panel.Frontier) return false;
      actions.onFrontierTabNext();
      return true;
    case "frontier_tab_prev":
      if (focused !== Panel.Frontier) return false;
      actions.onFrontierTabPrev();
      return true;
    case "frontier_adopt":
      if (focused === Panel.Frontier && !actions.compareMode) {
        const entries = actions.frontierEntries();
        const entry = entries[actions.nav.state.cursor];
        if (entry !== undefined) actions.onFrontierAdopt(entry.cid, entry.summary);
        return entry !== undefined;
      }
      return false;
    case "compare_select":
      if (focused === Panel.Frontier && actions.compareMode) {
        const cid = actions.frontierCids()[actions.nav.state.cursor];
        if (cid !== undefined) {
          actions.onCompareSelect(cid);
          return true;
        }
      }
      return false;
    case "compare_adopt_a":
      if (!(focused === Panel.Artifact && actions.compareMode)) return false;
      actions.onCompareAdopt("a");
      return true;
    case "compare_adopt_b":
      if (!(focused === Panel.Artifact && actions.compareMode)) return false;
      actions.onCompareAdopt("b");
      return true;
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
  const keymapPrefix = actions.keymapPrefix ?? [];

  // Command palette toggle (works in all modes except help). Both
  // dismissal AND opening route through onPaletteClose / onSpawnPalette
  // (which also clears adoptContext) to ensure a stale adopt target from
  // a prior 'a'-on-Frontier press cannot leak into the next spawn.
  if (isCtrl && input === "p") {
    if (mode === InputMode.CommandPalette) {
      actions.onPaletteClose();
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
    if (mode === InputMode.Normal && keymapPrefix.length > 0) {
      actions.onKeymapPrefixChange?.([]);
      return true;
    }
    if (mode !== InputMode.Normal) {
      // Leaving CommandPalette via Esc must clear adoptContext (set by the
      // 'a' Frontier-row keypress) and reset palette state — otherwise the
      // next unrelated palette open inherits a stale adopt target.
      if (mode === InputMode.CommandPalette) {
        actions.onPaletteClose();
      }
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

  // In help mode, help-toggle key exits; all other keys are consumed.
  if (mode === InputMode.Help) {
    if (isHelpToggleKey(key)) {
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

  // Command palette navigation + fuzzy filter
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
    if (input === "backspace") {
      actions.onPaletteBackspace();
      return true;
    }
    // Single printable characters → build fuzzy query
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      actions.onPaletteChar(input);
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
    if (input === "space") {
      actions.onMessageChar(" ");
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

  // Detail overlay is MODAL for section navigation: intercept j/k/arrows
  // BEFORE the resolved keymap so panel-specific bindings (e.g.
  // terminal_scroll_down/up, bound to j/k in the Terminal layer) cannot steal
  // them when a non-Detail panel retains focus while detail is open. Opening
  // detail only pushes nav state — it does not change panel focus — so without
  // this guard the focused panel's keymap layer wins. Skipped while a leader
  // prefix is mid-sequence so Space-chords still resolve.
  if (mode === InputMode.Normal && actions.nav.isDetailView && keymapPrefix.length === 0) {
    if (input === "j" || input === "down") {
      actions.onDetailSectionNext();
      return true;
    }
    if (input === "k" || input === "up") {
      actions.onDetailSectionPrev();
      return true;
    }
  }

  const resolvedKeymap = actions.resolvedKeymap;
  if (mode === InputMode.Normal && resolvedKeymap !== undefined) {
    const token = keyEventToToken(key);
    if (token !== undefined) {
      const nextPrefix = Object.freeze([...keymapPrefix, token]);
      const result = resolveKeySequence(resolvedKeymap.bindings, nextPrefix, {
        focusedPanel: focused,
      });
      switch (result.kind) {
        case "pending":
          actions.onKeymapPrefixChange?.(result.prefix);
          return true;
        case "match":
          actions.onKeymapPrefixChange?.([]);
          if (executeKeymapAction(result.binding, actions)) return true;
          if (keymapPrefix.length > 0) return true;
          break;
        case "miss":
          if (keymapPrefix.length > 0) {
            actions.onKeymapPrefixChange?.([]);
            return true;
          }
          return false;
      }
    }
  }

  // Help overlay toggle
  if (isHelpToggleKey(key)) {
    actions.panels.setMode(InputMode.Help);
    return true;
  }

  // Normal mode keybindings
  if (input === "q") {
    actions.onQuit();
    return true;
  }

  // Frontier panel: slice nav + adopt. Uses '[' / ']' for prev/next slice
  // (vim-style next-tab) so global Tab + 1-9 (panel cycle / panel focus)
  // remain available — keyboard-only operators must always be able to leave
  // the Frontier panel without resorting to the mouse.
  if (focused === Panel.Frontier) {
    if (input === "]") {
      actions.onFrontierTabNext();
      return true;
    }
    if (input === "[") {
      actions.onFrontierTabPrev();
      return true;
    }
    if (input === "a" && !actions.compareMode) {
      const entries = actions.frontierEntries();
      if (entries.length > 0 && actions.nav.state.cursor < entries.length) {
        const entry = entries[actions.nav.state.cursor];
        if (entry) {
          actions.onFrontierAdopt(entry.cid, entry.summary);
          return true;
        }
      }
    }
  }

  // Panel dispatch: driven by PANEL_REGISTRY (Issue 4A — eliminates DRY violation
  // and enables config-driven keybindings in the future).
  for (const def of PANEL_REGISTRY) {
    if (input === def.keybinding) {
      if (def.kind === "core") {
        actions.panels.focus(def.panel);
      } else {
        actions.panels.toggle(def.panel);
      }
      return true;
    }
  }

  // Tab/Shift+Tab: cycle focus (global — only reached when Frontier is not focused)
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
    if (input === "s") {
      actions.onArtifactDiffModeToggle();
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

  // Detail overlay: j/k move the focused section (no row cursor in detail).
  if (actions.nav.isDetailView) {
    if (input === "j" || input === "down") {
      actions.onDetailSectionNext();
      return true;
    }
    if (input === "k" || input === "up") {
      actions.onDetailSectionPrev();
      return true;
    }
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
    if (actions.compareMode && focused === Panel.Frontier) {
      const cids = actions.frontierCids();
      if (cids.length > 0) {
        const cid = cids[actions.nav.state.cursor];
        if (cid) actions.onCompareSelect(cid);
        return true;
      }
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

  if (input === "r") {
    actions.onRefresh();
    return true;
  }

  return false;
}
