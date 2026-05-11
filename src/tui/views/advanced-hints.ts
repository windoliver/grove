/**
 * Hints for advanced (boardroom) mode (#309).
 *
 * Lives in views/ rather than app.tsx so the hint-map module doesn't
 * need to depend on the root orchestration component.
 */

import { defineHints, type KeyAction } from "../data/hint-map.js";

export const ADVANCED_HINTS: readonly KeyAction[] = defineHints([
  { key: "Ctrl+B", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);
