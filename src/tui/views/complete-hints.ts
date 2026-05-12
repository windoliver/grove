/** Hints for the complete screen (#309). */
import { defineHints, type KeyAction } from "../data/hint-map.js";

export const COMPLETE_HINTS: readonly KeyAction[] = defineHints([
  { key: "Enter", label: "NewSession" },
  { key: "q", label: "Quit" },
]);
