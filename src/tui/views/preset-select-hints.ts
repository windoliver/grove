/** Hints for the preset-select screen (#309). */
import type { KeyAction } from "../data/hint-map.js";

export const PRESET_SELECT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Select" },
  { key: "?", label: "Details" },
  { key: "q", label: "Quit" },
]);
