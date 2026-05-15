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

import { COMPLETE_HINTS } from "../views/complete-hints.js";
import { GOAL_INPUT_HINTS } from "../views/goal-input-hints.js";
import { INSPECT_HINTS } from "../views/inspect-hints.js";
import { LAUNCH_PREVIEW_HINTS } from "../views/launch-preview-hints.js";
import { PANEL_HINTS } from "../views/panel-hints.js";
import { PRESET_SELECT_HINTS } from "../views/preset-select-hints.js";
import { RUNNING_VIEW_HINTS } from "../views/running-view-hints.js";
import type { Page } from "./pages-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single keyboard shortcut entry shown in the hint bar. */
export interface KeyAction {
  readonly key: string;
  readonly label: string;
}

/**
 * Deep-freeze a KeyAction[] literal — freezes each entry object AND the
 * array. Use this when defining hint constants so consumers can't mutate
 * `entry.key` / `entry.label` and corrupt all future renders for that
 * hint set (module-singletons are returned by reference from
 * `hintsForPage`).
 */
export function defineHints(actions: readonly KeyAction[]): readonly KeyAction[] {
  return Object.freeze(actions.map((a) => Object.freeze({ ...a })));
}

// ---------------------------------------------------------------------------
// Default hints (defined here — not view-specific)
// ---------------------------------------------------------------------------

export const DEFAULT_HINTS: readonly KeyAction[] = defineHints([
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
  // Spawning is transient and has NO active keyboard handlers
  // (SpawnProgress takes no onCancel/onQuit/onHelp). Return an empty
  // frozen array so HintBar renders nothing — we deliberately do NOT
  // fall back to DEFAULT_HINTS here because [?]Help and [q]Quit are
  // also unwired on this screen.
  spawning: Object.freeze([]),
  running: RUNNING_VIEW_HINTS,
  complete: COMPLETE_HINTS,
  inspect: INSPECT_HINTS,

  // panel sub-kinds
  "panel:agents": PANEL_HINTS.agents,
  "panel:dag": PANEL_HINTS.dag,
  "panel:sessions": PANEL_HINTS.sessions,
  "panel:tasks": PANEL_HINTS.tasks,
  "panel:reviews": PANEL_HINTS.reviews,
  "panel:terminal": PANEL_HINTS.terminal,
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
