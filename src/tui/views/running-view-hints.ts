/** Hints for the running view (#309). Panel toggle keys are 1-4 (see running-keyboard.ts). */
import type { KeyAction } from "../data/hint-map.js";

export const RUNNING_VIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: ":", label: "Goto" },
  { key: "/", label: "Filter" },
  { key: "1-4", label: "Panel" },
  { key: "Esc", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);
