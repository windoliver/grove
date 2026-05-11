/** Hints for the complete screen (#309). */
import type { KeyAction } from "../data/hint-map.js";

export const COMPLETE_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "NewSession" },
  { key: "q", label: "Quit" },
]);
