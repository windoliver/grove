/** Pure keyboard routing for the first-run customize screen. */

import type { KeyEvent } from "@opentui/core";

export type KeymapChoice = "vim" | "emacs" | "none";
export type CustomizeField = "preset" | "name" | "keymap";

export interface CustomizeState {
  readonly field: CustomizeField;
  readonly presetCursor: number;
  readonly presetCount: number;
  /** Non-empty if a name has been typed; the router only checks emptiness. */
  readonly nameIsEmpty: boolean;
  readonly keymap: KeymapChoice;
  readonly presetDetailOpen: boolean;
}

export interface CustomizeActions {
  readonly setField: (f: CustomizeField) => void;
  /** Move preset cursor by signed delta; wire-up clamps via functional setState. */
  readonly movePresetCursor: (delta: number) => void;
  readonly appendNameChar: (c: string) => void;
  readonly deleteNameChar: () => void;
  readonly setKeymap: (c: KeymapChoice) => void;
  readonly togglePresetDetail: () => void;
  readonly goBack: () => void;
  readonly launch: () => void;
}

const FIELD_ORDER: readonly CustomizeField[] = ["preset", "name", "keymap"];
const KEYMAP_ORDER: readonly KeymapChoice[] = ["vim", "emacs", "none"];

export function routeCustomizeKey(
  key: KeyEvent,
  state: CustomizeState,
  actions: CustomizeActions,
): boolean {
  const name = key.name;

  // Preset detail overlay is modal: only `?` and Esc dismiss it so the
  // operator isn't silently editing name/keymap behind the modal.
  if (state.presetDetailOpen) {
    if (key.sequence === "?") {
      actions.togglePresetDetail();
      return true;
    }
    if (name === "escape") {
      actions.togglePresetDetail();
      return true;
    }
    return true;
  }

  if (name === "escape") {
    actions.goBack();
    return true;
  }
  if (name === "tab") {
    const i = FIELD_ORDER.indexOf(state.field);
    const next = FIELD_ORDER[(i + 1) % FIELD_ORDER.length];
    if (next) actions.setField(next);
    return true;
  }

  if (state.field === "preset") {
    if (name === "j" || name === "down") {
      actions.movePresetCursor(1);
      return true;
    }
    if (name === "k" || name === "up") {
      actions.movePresetCursor(-1);
      return true;
    }
    if (key.sequence === "?") {
      actions.togglePresetDetail();
      return true;
    }
    if (name === "return") {
      if (!state.nameIsEmpty && state.presetCount > 0) actions.launch();
      return true;
    }
    return false;
  }

  if (state.field === "name") {
    if (name === "backspace") {
      actions.deleteNameChar();
      return true;
    }
    if (name === "space") {
      actions.appendNameChar(" ");
      return true;
    }
    if (name === "return") {
      if (!state.nameIsEmpty && state.presetCount > 0) actions.launch();
      return true;
    }
    if (typeof name === "string" && name.length === 1 && !key.ctrl) {
      actions.appendNameChar(name);
      return true;
    }
    return false;
  }

  // keymap field
  if (name === "l" || name === "right") {
    const i = KEYMAP_ORDER.indexOf(state.keymap);
    const next = KEYMAP_ORDER[(i + 1) % KEYMAP_ORDER.length];
    if (next) actions.setKeymap(next);
    return true;
  }
  if (name === "h" || name === "left") {
    const i = KEYMAP_ORDER.indexOf(state.keymap);
    const next = KEYMAP_ORDER[(i - 1 + KEYMAP_ORDER.length) % KEYMAP_ORDER.length];
    if (next) actions.setKeymap(next);
    return true;
  }
  if (name === "1") {
    actions.setKeymap("vim");
    return true;
  }
  if (name === "2") {
    actions.setKeymap("emacs");
    return true;
  }
  if (name === "3") {
    actions.setKeymap("none");
    return true;
  }
  if (name === "return") {
    if (!state.nameIsEmpty && state.presetCount > 0) actions.launch();
    return true;
  }
  return false;
}
