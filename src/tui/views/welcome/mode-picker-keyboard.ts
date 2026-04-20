/**
 * Pure keyboard routing for the first-run mode picker.
 */

import type { KeyEvent } from "@opentui/core";
import type { WelcomeMode } from "./router.js";

export interface ModePickerState {
  readonly mode: WelcomeMode;
  readonly glossaryOpen: boolean;
}

export interface ModePickerActions {
  readonly setMode: (m: WelcomeMode) => void;
  readonly startWithDefaults: () => void;
  readonly goToCustomize: () => void;
  readonly openConnect: () => void;
  readonly toggleGlossary: () => void;
  readonly onQuit: () => void;
}

export function routeModePickerKey(
  key: KeyEvent,
  state: ModePickerState,
  actions: ModePickerActions,
): boolean {
  const name = key.name;

  // Glossary overlay is modal: only `?`, Esc (dismiss) and `q` (quit)
  // escape it. Everything else is swallowed so h/l/Enter/Tab/c don't leak
  // to the underlying picker while the user is reading.
  if (state.glossaryOpen) {
    if (key.sequence === "?") {
      actions.toggleGlossary();
      return true;
    }
    if (name === "escape") {
      actions.toggleGlossary();
      return true;
    }
    if (name === "q") {
      actions.onQuit();
      return true;
    }
    return true;
  }

  if (name === "l" || name === "right") {
    if (state.mode !== "connected") actions.setMode("connected");
    return true;
  }
  if (name === "h" || name === "left") {
    if (state.mode !== "local") actions.setMode("local");
    return true;
  }
  if (name === "return") {
    actions.startWithDefaults();
    return true;
  }
  if (name === "tab") {
    actions.goToCustomize();
    return true;
  }
  if (name === "c") {
    actions.openConnect();
    return true;
  }
  if (key.sequence === "?") {
    actions.toggleGlossary();
    return true;
  }
  if (name === "escape") {
    return false;
  }
  if (name === "q") {
    actions.onQuit();
    return true;
  }
  return false;
}
