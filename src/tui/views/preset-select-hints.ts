/** Hints for the preset-select screen (#309). */
import { defineHints, type KeyAction } from "../data/hint-map.js";

export const PRESET_SELECT_HINTS: readonly KeyAction[] = defineHints([
  { key: "Enter", label: "Select" },
  { key: "?", label: "Details" },
  { key: "q", label: "Quit" },
]);
