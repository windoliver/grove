/**
 * Pure keyboard routing for RunningView.
 *
 * Follows the same pattern as use-keyboard-handler.ts (routeKey):
 * a pure function that takes (KeyEvent, State, Actions) and returns boolean.
 * No React dependencies — fully testable with plain unit tests.
 */

import type { KeyEvent } from "@opentui/core";
import { isHelpToggleKey } from "../hooks/shared-keyboard-core.js";
import type { ZoomLevel } from "../panels/panel-registry.js";

// ---------------------------------------------------------------------------
// Running panel identifiers
// ---------------------------------------------------------------------------

/** The 9 panels available in RunningView's progressive disclosure. */
export const RunningPanel = {
  Feed: 0,
  Agents: 1,
  Dag: 2,
  Terminal: 3,
  Trace: 4,
  Handoffs: 5,
  Sessions: 6,
  Tasks: 7,
  Reviews: 8,
} as const;
export type RunningPanel = (typeof RunningPanel)[keyof typeof RunningPanel];

export const RUNNING_PANEL_COUNT = 9;

export const RUNNING_PANEL_LABELS: Readonly<Record<RunningPanel, string>> = {
  [RunningPanel.Feed]: "Feed",
  [RunningPanel.Agents]: "Agents",
  [RunningPanel.Dag]: "DAG",
  [RunningPanel.Terminal]: "Terminal",
  [RunningPanel.Trace]: "Trace",
  [RunningPanel.Handoffs]: "Handoffs",
  [RunningPanel.Sessions]: "Sessions",
  [RunningPanel.Tasks]: "Tasks",
  [RunningPanel.Reviews]: "Reviews",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Keyboard-relevant state for the running view. */
export interface RunningKeyboardState {
  /** Currently expanded panel, or null for feed-only view. */
  readonly expandedPanel: RunningPanel | null;
  /** Zoom level of the expanded panel. */
  readonly zoomLevel: ZoomLevel;
  /** Whether the help overlay is showing. */
  readonly showHelp: boolean;
  /** Whether the VFS browser overlay is showing. */
  readonly showVfs: boolean;
  /** Whether quit confirmation is active. */
  readonly confirmQuit: boolean;
  /** Whether prompt input mode is active. */
  readonly promptMode: boolean;
  /** Current prompt text. */
  readonly promptText: string;
  /** C2 cmd-mode (goto/filter) — separate from legacy message mode. */
  readonly cmdMode: import("../components/prompt.js").PromptMode;
  /** Current C2 cmd text. */
  readonly cmdText: string;
  /** C2 (#302): retained filter query after Enter exits filter mode. Esc-from-normal clears it. */
  readonly filterQuery: string;
  /**
   * C6 (#304) round-2: when a confirmAndMutate modal is open, defer y/n
   * permission shortcuts so a confirm/cancel keystroke does NOT also
   * approve/deny a pending tmux permission prompt.
   */
  readonly confirmModalOpen: boolean;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** All mutable actions the running keyboard handler can trigger. */
export interface RunningKeyboardActions {
  // Panel
  readonly expandPanel: (panel: RunningPanel) => void;
  readonly collapsePanel: () => void;
  readonly toggleFullscreen: () => void;
  // Overlays
  readonly toggleHelp: () => void;
  readonly dismissHelp: () => void;
  readonly toggleVfs: () => void;
  readonly dismissVfs: () => void;
  readonly setConfirmQuit: (v: boolean) => void;
  readonly showQuitDialog: () => void;
  // Prompt
  readonly enterPromptMode: () => void;
  readonly exitPromptMode: () => void;
  readonly appendPromptChar: (char: string) => void;
  readonly deletePromptChar: () => void;
  readonly cyclePromptTarget: () => void;
  readonly submitPrompt: () => void;
  // Cmd-mode (C2): goto + filter prompt
  readonly enterGotoMode: () => void;
  readonly enterFilterMode: () => void;
  readonly cmdAppendChar: (char: string) => void;
  readonly cmdDeleteChar: () => void;
  readonly cmdTabComplete: () => void;
  readonly cmdSubmit: () => void;
  readonly cmdClearText: () => void;
  readonly cmdExit: () => void;
  /** C2 (#302): clear retained filter query (Esc from normal mode when filter is active). */
  readonly clearFilterQuery: () => void;
  // Feed
  readonly feedCursorDown: () => void;
  readonly feedCursorUp: () => void;
  readonly feedScrollToBottom: () => void;
  readonly scrollToAskUser: () => void;
  // Trace pane (split-pane agent trace viewer)
  readonly traceSelectDown: () => void;
  readonly traceSelectUp: () => void;
  readonly traceScrollDown: () => void;
  readonly traceScrollUp: () => void;
  readonly traceScrollToBottom: () => void;
  readonly traceScrollToTop: () => void;
  readonly traceCycleAgent: () => void;
  // Handoff panel
  readonly handoffCursorDown: () => void;
  readonly handoffCursorUp: () => void;
  readonly resendSelectedHandoff: () => void;
  readonly rerouteSelectedHandoff: () => void;
  readonly cancelSelectedHandoff: () => void;
  readonly manualResolveSelectedHandoff: () => void;
  // Navigation
  readonly openDetail: () => void;
  readonly enterInspect: () => void;
  readonly quit: () => void;
  // Permission
  readonly approvePermission: () => void;
  readonly denyPermission: () => void;
  // Context flags (not actions, just state the handler needs to make decisions)
  readonly hasPermissions: boolean;
  readonly hasActiveRoles: boolean;
  readonly hasSendToAgent: boolean;
  readonly feedLength: number;
  readonly hasAskUser: boolean;
}

// ---------------------------------------------------------------------------
// Pure state transitions
// ---------------------------------------------------------------------------

/** Expand a panel. If already expanded, toggle it off. */
export function expandPanel(
  expandedPanel: RunningPanel | null,
  zoomLevel: ZoomLevel,
  panel: RunningPanel,
): { expandedPanel: RunningPanel | null; zoomLevel: ZoomLevel } {
  if (expandedPanel === panel) {
    // Toggle off — collapse
    return { expandedPanel: null, zoomLevel: "normal" };
  }
  // Expand at half-screen (or keep current zoom if switching panels)
  return { expandedPanel: panel, zoomLevel: zoomLevel === "normal" ? "half" : zoomLevel };
}

/** Toggle fullscreen on the currently expanded panel. */
export function toggleFullscreen(
  expandedPanel: RunningPanel | null,
  zoomLevel: ZoomLevel,
): { expandedPanel: RunningPanel | null; zoomLevel: ZoomLevel } {
  if (expandedPanel === null) {
    // No panel expanded — no-op
    return { expandedPanel, zoomLevel };
  }
  // Toggle between half and full
  const nextZoom: ZoomLevel = zoomLevel === "full" ? "half" : "full";
  return { expandedPanel, zoomLevel: nextZoom };
}

/** Collapse the expanded panel back to feed-only view. */
export function collapsePanel(): { expandedPanel: RunningPanel | null; zoomLevel: ZoomLevel } {
  return { expandedPanel: null, zoomLevel: "normal" };
}

// ---------------------------------------------------------------------------
// Keyboard routing
// ---------------------------------------------------------------------------

/**
 * Route a key event to the appropriate action.
 *
 * Returns true if the key was handled, false otherwise.
 * This is a pure function — all side effects go through the actions object.
 */
export function routeRunningKey(
  key: KeyEvent,
  state: RunningKeyboardState,
  actions: RunningKeyboardActions,
): boolean {
  const input = key.name;
  const isCtrl = key.ctrl;

  // ─── C2 cmd-mode (goto/filter): swallows all keys ───
  if (state.cmdMode !== "none") {
    if (input === "escape") {
      if (state.cmdText.length > 0) actions.cmdClearText();
      else actions.cmdExit();
      return true;
    }
    if (input === "return") {
      actions.cmdSubmit();
      return true;
    }
    if (input === "tab" && state.cmdMode === "goto") {
      actions.cmdTabComplete();
      return true;
    }
    if (input === "backspace") {
      actions.cmdDeleteChar();
      return true;
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      actions.cmdAppendChar(key.sequence);
      return true;
    }
    if (input === "space") {
      actions.cmdAppendChar(" ");
      return true;
    }
    return true; // swallow unhandled keys in cmd-mode
  }

  // ─── Prompt input mode (swallows all keys) ───
  if (state.promptMode) {
    if (input === "escape") {
      actions.exitPromptMode();
      return true;
    }
    if (input === "return" && state.promptText.trim()) {
      actions.submitPrompt();
      return true;
    }
    if (input === "tab") {
      actions.cyclePromptTarget();
      return true;
    }
    if (input === "backspace") {
      actions.deletePromptChar();
      return true;
    }
    if (key.sequence && key.sequence.length === 1 && !isCtrl && !key.meta) {
      actions.appendPromptChar(key.sequence);
      return true;
    }
    if (input === "space") {
      actions.appendPromptChar(" ");
      return true;
    }
    return true; // Swallow unhandled keys in prompt mode
  }

  // ─── Help overlay (? toggles off, other keys swallowed) ───
  if (state.showHelp) {
    if (isHelpToggleKey(key) || input === "escape") {
      actions.dismissHelp();
      return true;
    }
    return true; // Swallow keys in help mode
  }

  // ─── Normal mode ───

  // '?': toggle help overlay
  if (isHelpToggleKey(key)) {
    actions.toggleHelp();
    return true;
  }

  // ':' enters C2 goto/command mode
  if (key.sequence === ":") {
    actions.enterGotoMode();
    return true;
  }

  // '/' enters C2 filter mode
  if (key.sequence === "/") {
    actions.enterFilterMode();
    return true;
  }

  // 'm' enters message-send mode (legacy prompt flow)
  if (input === "m" && actions.hasSendToAgent && actions.hasActiveRoles) {
    actions.enterPromptMode();
    return true;
  }

  // Ctrl+F: toggle VFS browser
  if (isCtrl && input === "f") {
    actions.toggleVfs();
    return true;
  }

  // Ctrl+G: enter inspect mode (Ctrl+I shares byte 0x09 with Tab — unusable in terminals)
  if (isCtrl && input === "g") {
    actions.enterInspect();
    return true;
  }

  // Escape: layered dismissal — overlay → filter clear → panel collapse
  if (input === "escape") {
    if (state.showVfs) {
      actions.dismissVfs();
      return true;
    }
    if (state.confirmQuit) {
      actions.setConfirmQuit(false);
      return true;
    }
    // C2 (#302): clear retained filter query before collapsing the panel.
    // Mirrors k9s "Esc-Esc clears filter" — first Esc exits filter prompt
    // (handled in cmdMode block); second Esc (now in normal mode) clears
    // the retained query.
    if (state.filterQuery !== "") {
      actions.clearFilterQuery();
      return true;
    }
    if (state.expandedPanel !== null) {
      actions.collapsePanel();
      return true;
    }
    return true;
  }

  // q: quit with dialog confirmation
  if (input === "q") {
    if (state.showVfs) {
      actions.dismissVfs();
      return true;
    }
    actions.showQuitDialog();
    return true;
  }

  // y/n: approve/deny permission prompts.
  // C6 (#304) round-2: skip when the confirmAndMutate modal is open;
  // the modal owns these keys and a permission approve/deny here would
  // double-fire from a single keystroke.
  if (input === "y" && actions.hasPermissions && !state.confirmModalOpen) {
    actions.approvePermission();
    return true;
  }
  if (input === "n" && actions.hasPermissions && !state.confirmModalOpen) {
    actions.denyPermission();
    return true;
  }

  // e: toggle trace pane (split-pane agent trace viewer)
  if (input === "e") {
    actions.expandPanel(RunningPanel.Trace);
    return true;
  }

  // f: toggle fullscreen on expanded panel
  if (input === "f" && state.expandedPanel !== null) {
    actions.toggleFullscreen();
    return true;
  }

  // 1-4: expand/toggle panels
  if (input === "1") {
    actions.expandPanel(RunningPanel.Feed);
    return true;
  }
  if (input === "2") {
    actions.expandPanel(RunningPanel.Agents);
    return true;
  }
  if (input === "3") {
    actions.expandPanel(RunningPanel.Dag);
    return true;
  }
  if (input === "4") {
    actions.expandPanel(RunningPanel.Terminal);
    return true;
  }
  if (input === "5") {
    actions.expandPanel(RunningPanel.Handoffs);
    return true;
  }

  // ─── Trace pane mode: J/K→trace scroll, j/k→agent list, G/g→jump ───
  // Shift variants checked first since input === "j" matches both j and Shift+j.
  if (state.expandedPanel === RunningPanel.Trace) {
    // J/K (shift): scroll trace output (right column) — must be before j/k
    if (key.shift && input === "j") {
      actions.traceScrollDown();
      return true;
    }
    if (key.shift && input === "k") {
      actions.traceScrollUp();
      return true;
    }
    // G: jump to bottom (resume auto-scroll)
    if (key.shift && input === "g") {
      actions.traceScrollToBottom();
      return true;
    }
    // j/k: navigate agent list (left column)
    if (input === "j" || input === "down") {
      actions.traceSelectDown();
      return true;
    }
    if (input === "k" || input === "up") {
      actions.traceSelectUp();
      return true;
    }
    // g: jump to top
    if (input === "g") {
      actions.traceScrollToTop();
      return true;
    }
    // Tab: cycle to next agent
    if (input === "tab") {
      actions.traceCycleAgent();
      return true;
    }
    return false;
  }

  if (state.expandedPanel === RunningPanel.Handoffs) {
    if (input === "j" || input === "down") {
      actions.handoffCursorDown();
      return true;
    }
    if (input === "k" || input === "up") {
      actions.handoffCursorUp();
      return true;
    }
    if (input === "s") {
      actions.resendSelectedHandoff();
      return true;
    }
    if (input === "r") {
      actions.rerouteSelectedHandoff();
      return true;
    }
    if (input === "x") {
      actions.cancelSelectedHandoff();
      return true;
    }
    if (input === "v") {
      actions.manualResolveSelectedHandoff();
      return true;
    }
    return false;
  }

  // Enter: reserved for a future contribution-detail route. Previously
  // routed to openDetail which was wired to onEnterInspect — that gave
  // Enter an accidental inspect-entry path, violating the documented
  // "Ctrl+G only" contract (#191 round 3). Until a real detail view
  // exists, Enter on a feed item is a no-op.

  // r: respond to ask_user question (scroll to it)
  if (input === "r" && actions.hasAskUser) {
    actions.scrollToAskUser();
    return true;
  }

  // j/k: scroll feed (default when Trace pane is not expanded)
  if (input === "j" || input === "down") {
    actions.feedCursorDown();
    return true;
  }
  if (input === "k" || input === "up") {
    actions.feedCursorUp();
    return true;
  }

  // G (Shift+G): jump to bottom of feed and re-enable auto-follow
  if (key.shift && input === "g") {
    actions.feedScrollToBottom();
    return true;
  }

  return false;
}
