/**
 * Pure keyboard routing for RunningView.
 *
 * Follows the same pattern as use-keyboard-handler.ts (routeKey):
 * a pure function that takes (KeyEvent, State, Actions) and returns boolean.
 * No React dependencies — fully testable with plain unit tests.
 */

import type { KeyEvent } from "@opentui/core";
import type { ZoomLevel } from "../panels/panel-registry.js";

// ---------------------------------------------------------------------------
// Running panel identifiers
// ---------------------------------------------------------------------------

/** The 5 panels available in RunningView's progressive disclosure. */
export const RunningPanel = {
  Feed: 0,
  Agents: 1,
  Dag: 2,
  Terminal: 3,
  Trace: 4,
} as const;
export type RunningPanel = (typeof RunningPanel)[keyof typeof RunningPanel];

export const RUNNING_PANEL_COUNT = 5;

export const RUNNING_PANEL_LABELS: Readonly<Record<RunningPanel, string>> = {
  [RunningPanel.Feed]: "Feed",
  [RunningPanel.Agents]: "Agents",
  [RunningPanel.Dag]: "DAG",
  [RunningPanel.Terminal]: "Terminal",
  [RunningPanel.Trace]: "Trace",
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
  // Navigation
  readonly openDetail: () => void;
  readonly toggleAdvanced: () => void;
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
    if (input === "?" || (key.shift && input === "/")) {
      actions.dismissHelp();
      return true;
    }
    if (input === "escape") {
      actions.dismissHelp();
      return true;
    }
    return true; // Swallow keys in help mode
  }

  // ─── Normal mode ───

  // '?': toggle help overlay
  if (input === "?" || (key.shift && input === "/")) {
    actions.toggleHelp();
    return true;
  }

  // ':' or 'm': enter prompt mode to send message to agent
  if ((key.sequence === ":" || input === "m") && actions.hasSendToAgent && actions.hasActiveRoles) {
    actions.enterPromptMode();
    return true;
  }

  // Ctrl+F: toggle VFS browser
  if (isCtrl && input === "f") {
    actions.toggleVfs();
    return true;
  }

  // Ctrl+A: toggle advanced mode
  if (isCtrl && input === "a") {
    actions.toggleAdvanced();
    return true;
  }

  // Escape: layered dismissal — overlay → panel collapse
  if (input === "escape") {
    if (state.showVfs) {
      actions.dismissVfs();
      return true;
    }
    if (state.confirmQuit) {
      actions.setConfirmQuit(false);
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

  // y/n: approve/deny permission prompts
  if (input === "y" && actions.hasPermissions) {
    actions.approvePermission();
    return true;
  }
  if (input === "n" && actions.hasPermissions) {
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

  // Enter: open detail view for selected feed item
  if (input === "return" && actions.feedLength > 0) {
    actions.openDetail();
    return true;
  }

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
