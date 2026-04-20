/** Pure keyboard routing for the first-run customize screen. */

import type { KeyEvent } from "@opentui/core";

export type KeymapChoice = "vim" | "emacs" | "none";
export type CustomizeField = "preset" | "name" | "keymap";

export interface CustomizeState {
  readonly field: CustomizeField;
  readonly presetCursor: number;
  readonly presetCount: number;
  readonly name: string;
  readonly keymap: KeymapChoice;
  readonly presetDetailOpen: boolean;
}

export interface CustomizeActions {
  readonly setField: (f: CustomizeField) => void;
  readonly setPresetCursor: (n: number) => void;
  readonly setName: (s: string) => void;
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
      actions.setPresetCursor(Math.min(state.presetCursor + 1, Math.max(0, state.presetCount - 1)));
      return true;
    }
    if (name === "k" || name === "up") {
      actions.setPresetCursor(Math.max(state.presetCursor - 1, 0));
      return true;
    }
    if (key.sequence === "?") {
      actions.togglePresetDetail();
      return true;
    }
    if (name === "return") {
      if (state.name.length > 0) actions.launch();
      return true;
    }
    return false;
  }

  if (state.field === "name") {
    if (name === "backspace") {
      actions.setName(state.name.slice(0, -1));
      return true;
    }
    if (name === "space") {
      actions.setName(`${state.name} `);
      return true;
    }
    if (name === "return") {
      if (state.name.length > 0) actions.launch();
      return true;
    }
    if (typeof name === "string" && name.length === 1 && !key.ctrl) {
      actions.setName(state.name + name);
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
    if (state.name.length > 0) actions.launch();
    return true;
  }
  return false;
}
