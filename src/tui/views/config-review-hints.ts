/** Hints for the config-review screen (#201). */
import { defineHints, type KeyAction } from "../data/hint-map.js";

export const CONFIG_REVIEW_HINTS: readonly KeyAction[] = defineHints([
  { key: "j/k", label: "Navigate" },
  { key: "e", label: "Edit" },
  { key: "space", label: "Toggle mode" },
  { key: "d", label: "Reset" },
  { key: "Enter", label: "Continue" },
  { key: "Esc", label: "Back" },
]);
