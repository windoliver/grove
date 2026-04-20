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
  readonly filterText: string;
  readonly archiveVisible: boolean;
}

/** Side-effecting hooks wired by the fast-path component. */
export interface FastPathActions {
  readonly setCursor: (next: number) => void;
  readonly enterFilter: () => void;
  readonly exitFilter: () => void;
  readonly setFilterText: (next: string) => void;
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
      actions.exitFilter();
      return true;
    }
    if (name === "backspace") {
      actions.setFilterText(state.filterText.slice(0, -1));
      return true;
    }
    if (name === "space") {
      actions.setFilterText(`${state.filterText} `);
      return true;
    }
    if (typeof name === "string" && name.length === 1 && !key.ctrl) {
      actions.setFilterText(state.filterText + name);
      return true;
    }
    return false;
  }

  // Normal mode
  if (name === "j" || name === "down") {
    const max = Math.max(0, state.visibleSessionIds.length - 1);
    actions.setCursor(Math.min(state.cursor + 1, max));
    return true;
  }
  if (name === "k" || name === "up") {
    actions.setCursor(Math.max(state.cursor - 1, 0));
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
