/**
 * Pure keyboard routing for the welcome fast-path.
 *
 * State shape is minimal: cursor, visible session ids (filtered + archive
 * toggle applied by the caller), and filter-mode flags. Actions are pure
 * callbacks invoked by the caller.
 *
 * Mirrors the pattern in `screens/running-keyboard.ts`.
 */

import type { KeyEvent } from "@opentui/core";

/** Mutable state as seen by the fast-path keyboard handler. */
export interface FastPathState {
  readonly cursor: number;
  readonly visibleSessionIds: readonly string[];
  readonly filterMode: boolean;
  readonly archiveVisible: boolean;
}

/**
 * Side-effecting hooks wired by the fast-path component.
 *
 * Filter edits are expressed as deltas (append/delete) rather than
 * whole-string replacements so the wire-up can use functional setState and
 * avoid dropping rapid keystrokes to stale-closure races.
 */
export interface FastPathActions {
  /**
   * Move the cursor by a signed delta; wire-up is expected to use
   * functional setState so rapid j/k doesn't stall on stale state.
   */
  readonly moveCursor: (delta: number) => void;
  readonly enterFilter: () => void;
  /** Esc in filter mode — exits AND clears the typed filter text. */
  readonly exitFilter: () => void;
  /** Enter in filter mode — exits filter mode keeping the current text. */
  readonly commitFilter: () => void;
  readonly appendFilterChar: (c: string) => void;
  readonly deleteFilterChar: () => void;
  readonly toggleArchive: () => void;
  readonly onResume: (sessionId: string) => void;
  readonly onNewSession: () => void;
  readonly onConnect: () => void;
  readonly onQuit: () => void;
}

/** Route a single key event. Returns true if the event was consumed. */
export function routeFastPathKey(
  key: KeyEvent,
  state: FastPathState,
  actions: FastPathActions,
): boolean {
  const name = key.name;

  if (state.filterMode) {
    if (name === "escape") {
      actions.exitFilter();
      return true;
    }
    if (name === "return") {
      actions.commitFilter();
      return true;
    }
    if (name === "backspace") {
      actions.deleteFilterChar();
      return true;
    }
    if (name === "space") {
      actions.appendFilterChar(" ");
      return true;
    }
    if (typeof name === "string" && name.length === 1 && !key.ctrl) {
      actions.appendFilterChar(name);
      return true;
    }
    return false;
  }

  // Normal mode
  if (name === "j" || name === "down") {
    actions.moveCursor(1);
    return true;
  }
  if (name === "k" || name === "up") {
    actions.moveCursor(-1);
    return true;
  }
  if (name === "return") {
    const id = state.visibleSessionIds[state.cursor];
    if (id) actions.onResume(id);
    return true;
  }
  if (name === "n") {
    actions.onNewSession();
    return true;
  }
  if (name === "c") {
    actions.onConnect();
    return true;
  }
  if (name === "a") {
    actions.toggleArchive();
    return true;
  }
  if (key.sequence === "/") {
    actions.enterFilter();
    return true;
  }
  if (name === "q") {
    actions.onQuit();
    return true;
  }
  return false;
}
