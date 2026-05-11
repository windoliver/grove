/**
 * Per-panel KeyAction[] constants for the running view's panel zoom
 * pages (#309). Keyed by the `panel` param of `Page` with kind="panel".
 *
 * DAG hints — forward-looking placeholders
 * ----------------------------------------
 * The DAG chain `[Enter]Focus [Space]Expand [R]Review [M]Merge [L]Logs`
 * is the issue #309 acceptance literal verbatim, mandated by the issue
 * spec. NONE of these keys are wired to DAG-specific actions in #309 —
 * issue #309 only delivers the hint-bar infrastructure. The actual key
 * routes land with the DAG drill-in work in Epic C follow-up issues
 * (#311 xray DAG view + entity-detail navigation).
 *
 * Today on `panel:dag`:
 * - Enter → routes through running-view's normal-mode keyboard to the
 *   feed-detail / advanced-mode toggle (NOT panel-aware Focus yet).
 * - Space / R / M / L → no panel:dag-specific handler; fall through to
 *   their global RunningView routes (mostly no-ops on this panel).
 *
 * The hint surface is stable and conforms to the issue acceptance; the
 * behind-the-key handlers are the contract of the DAG drill-in issues.
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
