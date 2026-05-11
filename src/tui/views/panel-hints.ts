/**
 * Per-panel KeyAction[] constants for the running view's panel zoom
 * pages (#309). Keyed by the `panel` param of `Page` with kind="panel".
 *
 * DAG's chain is the issue #309 acceptance literal — `[Space]Expand`,
 * `[R]Review`, `[M]Merge`, `[L]Logs` are forward-looking placeholders for
 * the DAG drill-in work in epic #284. The hint surface lands here per
 * #309's spec; the keyboard routes for those actions are implemented in
 * follow-up issues (#311 xray DAG view + Epic C drill-in work). Only
 * `[Enter]Focus` is currently wired (via running-keyboard's normal-mode
 * "1-4" panel toggle reaching the DAG panel).
 */

import { defineHints, type KeyAction } from "../data/hint-map.js";

const GENERIC: readonly KeyAction[] = defineHints([
  { key: "Enter", label: "Detail" },
  { key: "Esc", label: "Close" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const DAG: readonly KeyAction[] = defineHints([
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
