/** Hints for the launch-preview screen (#309). Used for both `agent-detect` and `launch-preview` PageKinds. */
import type { KeyAction } from "../data/hint-map.js";

export const LAUNCH_PREVIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Launch" },
  { key: "c", label: "CLI" },
  { key: "e", label: "Edit" },
  { key: "Esc", label: "Back" },
]);
