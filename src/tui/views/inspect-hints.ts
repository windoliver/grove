/**
 * Hints for the inspect overlay opened from RunningView (#191).
 *
 * Lives in views/ rather than app.tsx so the hint-map module doesn't
 * need to depend on the root orchestration component.
 */

import { defineHints, type KeyAction } from "../data/hint-map.js";

export const INSPECT_HINTS: readonly KeyAction[] = defineHints([
  { key: "Ctrl+G", label: "Back" },
  { key: "Esc", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);
