/**
 * hint-map — central registry mapping PageKind (and panel/entity-detail
 * sub-keys) to the ordered list of keyboard shortcuts shown in the TUI
 * hint bar.
 *
 * Pure data module — no side effects, no subscriptions.
 * Issue #309: Context-Aware Hint Bar, Task 1.
 */

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
// Exported hint constants (all frozen)
// ---------------------------------------------------------------------------

export const DEFAULT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const PRESET_SELECT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Select" },
  { key: "?", label: "Details" },
  { key: "q", label: "Quit" },
]);

const GOAL_INPUT_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Continue" },
  { key: "Esc", label: "Back" },
  { key: "Ctrl+U", label: "Clear" },
]);

const LAUNCH_PREVIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Launch" },
  { key: "c", label: "CLI" },
  { key: "e", label: "Edit" },
  { key: "Esc", label: "Back" },
]);

const SPAWNING_HINTS: readonly KeyAction[] = Object.freeze([{ key: "Esc", label: "Cancel" }]);

const RUNNING_VIEW_HINTS: readonly KeyAction[] = Object.freeze([
  { key: ":", label: "Goto" },
  { key: "/", label: "Filter" },
  { key: "1-5", label: "Panel" },
  { key: "Esc", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const COMPLETE_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "NewSession" },
  { key: "q", label: "Quit" },
]);

const ADVANCED_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Ctrl+B", label: "Back" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const PANEL_GENERIC: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Detail" },
  { key: "Esc", label: "Close" },
  { key: "?", label: "Help" },
  { key: "q", label: "Quit" },
]);

const DAG_HINTS: readonly KeyAction[] = Object.freeze([
  { key: "Enter", label: "Focus" },
  { key: "Space", label: "Expand" },
  { key: "R", label: "Review" },
  { key: "M", label: "Merge" },
  { key: "L", label: "Logs" },
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
  "panel:agents": PANEL_GENERIC,
  "panel:sessions": PANEL_GENERIC,
  "panel:tasks": PANEL_GENERIC,
  "panel:reviews": PANEL_GENERIC,
  "panel:feed": PANEL_GENERIC,
  "panel:dag": DAG_HINTS,
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
