/**
 * Hint-bar shortcuts shown on the Supervision screen — successor to
 * RUNNING_VIEW_HINTS now that running-view.tsx has retired.
 */
import { defineHints, type KeyAction } from "../../data/hint-map.js";

export const SUPERVISION_HINTS: readonly KeyAction[] = defineHints([
  { key: "h/j/k/l", label: "Move" },
  { key: "↵", label: "Drill" },
  { key: "A", label: "Approve" },
  { key: "/", label: "Filter" },
  { key: "s", label: "Sort" },
  { key: "f", label: "States" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);
