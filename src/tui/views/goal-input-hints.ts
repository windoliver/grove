/** Hints for the goal-input screen (#309). */
import { defineHints, type KeyAction } from "../data/hint-map.js";

export const GOAL_INPUT_HINTS: readonly KeyAction[] = defineHints([
  { key: "Enter", label: "Continue" },
  { key: "Esc", label: "Back" },
  { key: "Ctrl+U", label: "Clear" },
]);
