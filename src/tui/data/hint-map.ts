/**
 * hint-map — central registry mapping PageKind (and panel/entity-detail
 * sub-keys) to the ordered list of keyboard shortcuts shown in the TUI
 * hint bar.
 *
 * Pure data module — no side effects, no subscriptions.
 * Issue #309: Context-Aware Hint Bar, Task 1.
 *
 * Each view module DEFINES its own hint constant; this module imports and
 * assembles them into the STATIC lookup map.
 */

import { ADVANCED_HINTS } from "../app.js";
import { LAUNCH_PREVIEW_HINTS } from "../screens/agent-detect.js";
import { COMPLETE_HINTS } from "../screens/complete-view.js";
import { GOAL_INPUT_HINTS } from "../screens/goal-input.js";
import { PRESET_SELECT_HINTS } from "../screens/preset-select.js";
import { RUNNING_VIEW_HINTS } from "../screens/running-view.js";
import { SPAWNING_HINTS } from "../screens/spawn-progress.js";
import { PANEL_HINTS } from "../views/panel-hints.js";
import type { Page } from "./pages-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single keyboard shortcut entry shown in the hint bar. */
export interface KeyAction {
  readonly key: string;
  readonly label: string;
}

// ---------------------------------------------------------------------------
// Default hints (defined here — not view-specific)
// ---------------------------------------------------------------------------

export const DEFAULT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

// ---------------------------------------------------------------------------
// Static lookup map
// ---------------------------------------------------------------------------

/**
 * Internal map keyed by:
 *   - Plain PageKind strings for top-level pages.
 *   - `"panel:<name>"` for panel sub-kinds.
 *   - `"entity-detail:<kind>"` for entity-detail sub-kinds.
 */
const STATIC: Readonly<Record<string, readonly KeyAction[]>> = Object.freeze({
  // Top-level page kinds
  "preset-select": PRESET_SELECT_HINTS,
  "goal-input": GOAL_INPUT_HINTS,
  "agent-detect": LAUNCH_PREVIEW_HINTS,
  "launch-preview": LAUNCH_PREVIEW_HINTS,
  spawning: SPAWNING_HINTS,
  running: RUNNING_VIEW_HINTS,
  complete: COMPLETE_HINTS,
  advanced: ADVANCED_HINTS,

  // panel sub-kinds
  "panel:agents": PANEL_HINTS.agents,
  "panel:dag": PANEL_HINTS.dag,
  "panel:sessions": PANEL_HINTS.sessions,
  "panel:tasks": PANEL_HINTS.tasks,
  "panel:reviews": PANEL_HINTS.reviews,
  "panel:feed": PANEL_HINTS.feed,
} satisfies Record<string, readonly KeyAction[]>);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the ordered list of `KeyAction` hints for the given page.
 *
 * Lookup rules:
 *  1. `page.kind === "panel"` → look up `"panel:" + page.params?.panel`.
 *  2. `page.kind === "entity-detail"` → look up `"entity-detail:" + page.params?.kind`.
 *  3. Otherwise → look up by `page.kind`.
 *
 * Falls back to `DEFAULT_HINTS` if the key is missing or the param is absent.
 *
 * Pure function — no side effects.
 */
export function hintsForPage(page: Page): readonly KeyAction[] {
  let lookupKey: string;

  if (page.kind === "panel") {
    const panelName = page.params?.panel;
    if (!panelName) return DEFAULT_HINTS;
    lookupKey = `panel:${panelName}`;
  } else if (page.kind === "entity-detail") {
    const entityKind = page.params?.kind;
    if (!entityKind) return DEFAULT_HINTS;
    lookupKey = `entity-detail:${entityKind}`;
  } else {
    lookupKey = page.kind as string;
  }

  return STATIC[lookupKey] ?? DEFAULT_HINTS;
}
