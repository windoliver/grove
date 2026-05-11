/** Hints for the goal-input screen (#309). */
import type { KeyAction } from "../data/hint-map.js";

export const GOAL_INPUT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Continue" },
  { key: "Esc", label: "Back" },
  { key: "Ctrl+U", label: "Clear" },
]);
