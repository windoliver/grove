/**
 * Per-panel KeyAction[] constants for the running view's panel zoom
 * pages (#309). Keyed by the `panel` param of `Page` with kind="panel".
 *
 * DAG's chain is the issue #309 acceptance literal.
 */

import type { KeyAction } from "../data/hint-map.js";

const GENERIC: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Detail" },
  { key: "Esc", label: "Close" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const DAG: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Focus" },
  { key: "Space", label: "Expand" },
  { key: "R", label: "Review" },
  { key: "M", label: "Merge" },
  { key: "L", label: "Logs" },
]);

/** Keyed by panel name → KeyAction hints for that panel. */
export interface PanelHints {
  readonly agents: readonly KeyAction[];
  readonly dag: readonly KeyAction[];
  readonly sessions: readonly KeyAction[];
  readonly tasks: readonly KeyAction[];
  readonly reviews: readonly KeyAction[];
  readonly feed: readonly KeyAction[];
}

export const PANEL_HINTS: PanelHints = Object.freeze({
  agents: GENERIC,
  dag: DAG,
  sessions: GENERIC,
  tasks: GENERIC,
  reviews: GENERIC,
  feed: GENERIC,
} satisfies PanelHints);
