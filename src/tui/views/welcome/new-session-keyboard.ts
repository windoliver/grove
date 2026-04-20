/** Pure keyboard routing for the new-session preset picker. */

import type { KeyEvent } from "@opentui/core";

export interface NewSessionState {
  readonly cursor: number;
  readonly presetCount: number;
  readonly detailOpen: boolean;
}

export interface NewSessionActions {
  /** Move cursor by signed delta; wire-up uses functional setState. */
  readonly moveCursor: (delta: number) => void;
  readonly toggleDetail: () => void;
  readonly onPick: (index: number) => void;
  readonly onBack: () => void;
}

export function routeNewSessionKey(
  key: KeyEvent,
  state: NewSessionState,
  actions: NewSessionActions,
): boolean {
  const name = key.name;
  if (name === "escape") {
    if (state.detailOpen) {
      actions.toggleDetail();
      return true;
    }
    actions.onBack();
    return true;
  }
  if (name === "j" || name === "down") {
    actions.moveCursor(1);
    return true;
  }
  if (name === "k" || name === "up") {
    actions.moveCursor(-1);
    return true;
  }
  if (name === "return") {
    actions.onPick(state.cursor);
    return true;
  }
  if (key.sequence === "?") {
    actions.toggleDetail();
    return true;
  }
  return false;
}
