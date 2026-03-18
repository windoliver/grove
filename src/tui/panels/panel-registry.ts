/**
 * Panel registry — data-driven panel definitions.
 *
 * Each panel declares its row group (for grid layout), visibility rules
 * (which presets show it), and layout metadata. Both grid and tab layout
 * modes consume this registry.
 *
 * This module is pure data and functions — no React, no side effects.
 */

import type { PanelFocusState } from "../hooks/use-panel-focus.js";
import { isPanelVisible, PANEL_LABELS, Panel } from "../hooks/use-panel-focus.js";

// ---------------------------------------------------------------------------
// Per-preset panel visibility
// ---------------------------------------------------------------------------

/** Panels allowed per preset. Unlisted presets allow all panels. */
export const PRESET_PANELS: Readonly<Record<string, ReadonlySet<Panel>>> = {
  "review-loop": new Set([Panel.Dag, Panel.Detail, Panel.Claims, Panel.Terminal]),
  "swarm-ops": new Set([
    Panel.Dag,
    Panel.Detail,
    Panel.Claims,
    Panel.Terminal,
    Panel.Frontier,
    Panel.Outcomes,
    Panel.Bounties,
  ]),
  "federated-swarm": new Set([
    Panel.Dag,
    Panel.Detail,
    Panel.Claims,
    Panel.Terminal,
    Panel.Frontier,
    Panel.Gossip,
  ]),
};

/** Get the allowed panels for a preset. Returns undefined if all panels are allowed. */
export function getPresetPanels(presetName?: string): ReadonlySet<Panel> | undefined {
  if (!presetName) return undefined;
  return PRESET_PANELS[presetName];
}

// ---------------------------------------------------------------------------
// Layout types
// ---------------------------------------------------------------------------

/** Zoom level for panel layout. */
export type ZoomLevel = "normal" | "half" | "full";

/** Layout mode for the panel manager. */
export type LayoutMode = "grid" | "tab";

// ---------------------------------------------------------------------------
// Panel definition
// ---------------------------------------------------------------------------

/** Layout metadata for a panel definition. */
export interface PanelDef {
  /** The Panel enum value. */
  readonly panel: Panel;
  /** Display label (from PANEL_LABELS). */
  readonly label: string;
  /** Row group for grid layout (panels in the same row group share a row). */
  readonly rowGroup: number;
  /** Whether this is a core panel (always visible) or operator panel (toggled). */
  readonly kind: "core" | "operator";
  /** Row partner panels (panels that share the same row in grid mode). */
  readonly rowPartners?: readonly Panel[];
}

// ---------------------------------------------------------------------------
// Registry data
// ---------------------------------------------------------------------------

/**
 * The canonical panel registry.
 *
 * Row groups:
 *   0 — Dag + Detail       (core)
 *   1 — Frontier           (core)
 *   2 — Claims             (core)
 *   3 — AgentList + Terminal (operator)
 *   4 — Artifact + Vfs     (operator)
 *   5 — Activity + Search  (operator)
 *   6 — Threads + Outcomes (operator)
 *   7 — Bounties + Gossip  (operator)
 *   8 — Inbox + Decisions + GitHub (operator)
 */
export const PANEL_REGISTRY: readonly PanelDef[] = [
  // Row 0: DAG + Detail (core)
  {
    panel: Panel.Dag,
    label: PANEL_LABELS[Panel.Dag],
    rowGroup: 0,
    kind: "core",
    rowPartners: [Panel.Detail],
  },
  {
    panel: Panel.Detail,
    label: PANEL_LABELS[Panel.Detail],
    rowGroup: 0,
    kind: "core",
    rowPartners: [Panel.Dag],
  },

  // Row 1: Frontier (core)
  {
    panel: Panel.Frontier,
    label: PANEL_LABELS[Panel.Frontier],
    rowGroup: 1,
    kind: "core",
  },

  // Row 2: Claims (core)
  {
    panel: Panel.Claims,
    label: PANEL_LABELS[Panel.Claims],
    rowGroup: 2,
    kind: "core",
  },

  // Row 3: AgentList + Terminal (operator)
  {
    panel: Panel.AgentList,
    label: PANEL_LABELS[Panel.AgentList],
    rowGroup: 3,
    kind: "operator",
    rowPartners: [Panel.Terminal],
  },
  {
    panel: Panel.Terminal,
    label: PANEL_LABELS[Panel.Terminal],
    rowGroup: 3,
    kind: "operator",
    rowPartners: [Panel.AgentList],
  },

  // Row 4: Artifact + Vfs (operator)
  {
    panel: Panel.Artifact,
    label: PANEL_LABELS[Panel.Artifact],
    rowGroup: 4,
    kind: "operator",
    rowPartners: [Panel.Vfs],
  },
  {
    panel: Panel.Vfs,
    label: PANEL_LABELS[Panel.Vfs],
    rowGroup: 4,
    kind: "operator",
    rowPartners: [Panel.Artifact],
  },

  // Row 5: Activity + Search (operator)
  {
    panel: Panel.Activity,
    label: PANEL_LABELS[Panel.Activity],
    rowGroup: 5,
    kind: "operator",
    rowPartners: [Panel.Search],
  },
  {
    panel: Panel.Search,
    label: PANEL_LABELS[Panel.Search],
    rowGroup: 5,
    kind: "operator",
    rowPartners: [Panel.Activity],
  },

  // Row 6: Threads + Outcomes (operator)
  {
    panel: Panel.Threads,
    label: PANEL_LABELS[Panel.Threads],
    rowGroup: 6,
    kind: "operator",
    rowPartners: [Panel.Outcomes],
  },
  {
    panel: Panel.Outcomes,
    label: PANEL_LABELS[Panel.Outcomes],
    rowGroup: 6,
    kind: "operator",
    rowPartners: [Panel.Threads],
  },

  // Row 7: Bounties + Gossip (operator)
  {
    panel: Panel.Bounties,
    label: PANEL_LABELS[Panel.Bounties],
    rowGroup: 7,
    kind: "operator",
    rowPartners: [Panel.Gossip],
  },
  {
    panel: Panel.Gossip,
    label: PANEL_LABELS[Panel.Gossip],
    rowGroup: 7,
    kind: "operator",
    rowPartners: [Panel.Bounties],
  },

  // Row 8: Inbox + Decisions + GitHub (operator)
  {
    panel: Panel.Inbox,
    label: PANEL_LABELS[Panel.Inbox],
    rowGroup: 8,
    kind: "operator",
    rowPartners: [Panel.Decisions, Panel.GitHub],
  },
  {
    panel: Panel.Decisions,
    label: PANEL_LABELS[Panel.Decisions],
    rowGroup: 8,
    kind: "operator",
    rowPartners: [Panel.Inbox, Panel.GitHub],
  },
  {
    panel: Panel.GitHub,
    label: PANEL_LABELS[Panel.GitHub],
    rowGroup: 8,
    kind: "operator",
    rowPartners: [Panel.Inbox, Panel.Decisions],
  },

  // Row 9: Plan (operator)
  {
    panel: Panel.Plan,
    label: PANEL_LABELS[Panel.Plan],
    rowGroup: 9,
    kind: "operator",
  },
] as const;

// ---------------------------------------------------------------------------
// Lookup helpers (lazily cached)
// ---------------------------------------------------------------------------

/** Cached panel-to-def lookup map, built on first access. */
let _panelLookup: ReadonlyMap<Panel, PanelDef> | undefined;

/** Get the PanelDef for a given panel. Returns undefined for unknown panels. */
function lookupPanel(panel: Panel): PanelDef | undefined {
  if (_panelLookup === undefined) {
    const map = new Map<Panel, PanelDef>();
    for (const def of PANEL_REGISTRY) {
      map.set(def.panel, def);
    }
    _panelLookup = map;
  }
  return _panelLookup.get(panel);
}

// ---------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------

/** Returns the full panel registry. */
export function getRegistry(): readonly PanelDef[] {
  return PANEL_REGISTRY;
}

/** Groups panel definitions by their row group number. */
export function getRowGroups(): Map<number, readonly PanelDef[]> {
  const groups = new Map<number, PanelDef[]>();
  for (const def of PANEL_REGISTRY) {
    let group = groups.get(def.rowGroup);
    if (group === undefined) {
      group = [];
      groups.set(def.rowGroup, group);
    }
    group.push(def);
  }
  return groups;
}

/**
 * Returns visible panels for the given layout mode.
 *
 * - **grid**: core panels + visible operator panels (the standard multi-panel
 *   grid). Visibility of operator panels is determined by
 *   `panelState.visibleOperator`.
 * - **tab**: only the currently focused panel is returned.
 */
export function getVisiblePanelsForLayout(
  panelState: PanelFocusState,
  mode: LayoutMode,
  allowedPanels?: ReadonlySet<Panel>,
): readonly PanelDef[] {
  if (mode === "tab") {
    const def = lookupPanel(panelState.focused);
    return def !== undefined ? [def] : [];
  }

  // Grid mode: core panels always visible, operator panels per state.
  // Also filter by allowedPanels if provided (preset-based visibility).
  return PANEL_REGISTRY.filter(
    (def) =>
      isPanelVisible(panelState, def.panel) &&
      (allowedPanels === undefined || allowedPanels.has(def.panel)),
  );
}

/**
 * Returns the set of panels that should actively poll data for the given
 * layout mode.
 *
 * - **grid**: all currently visible panels should poll.
 * - **tab**: only the focused panel should poll.
 */
export function getActivePanelsForLayout(
  panelState: PanelFocusState,
  mode: LayoutMode,
): ReadonlySet<Panel> {
  if (mode === "tab") {
    return new Set([panelState.focused]);
  }

  // Grid mode: every visible panel is active.
  const active = new Set<Panel>();
  for (const def of PANEL_REGISTRY) {
    if (isPanelVisible(panelState, def.panel)) {
      active.add(def.panel);
    }
  }
  return active;
}

/**
 * Compute the flex value for a row group given the current zoom level.
 *
 * - **normal**: returns the base flex value for every row.
 * - **half**: the focused row receives `base * 3`, other rows receive `1`.
 * - **full**: returns the base flex (only the focused row is rendered by the
 *   caller, so competing rows are not shown).
 *
 * @param rowGroup      - The row group to compute flex for.
 * @param focusedRowGroup - The row group that currently has focus.
 * @param zoomLevel     - The active zoom level.
 * @param baseFlex      - The base flex weight for the row (default `1`).
 */
export function getRowFlex(
  rowGroup: number,
  focusedRowGroup: number,
  zoomLevel: ZoomLevel,
  baseFlex: number = 1,
): number {
  if (zoomLevel === "normal") return baseFlex;
  if (zoomLevel === "half") return rowGroup === focusedRowGroup ? baseFlex * 3 : 1;
  // "full" — only the focused row is rendered; flex value is irrelevant for
  // hidden rows, but return baseFlex for the shown row to be safe.
  return baseFlex;
}

/**
 * Get the row group number for a panel. Convenience wrapper around the
 * registry lookup.
 *
 * Returns `0` for unknown panels (matches the default in the original
 * `panelRowGroup()` switch statement).
 */
export function panelRowGroup(panel: Panel): number {
  const def = lookupPanel(panel);
  return def !== undefined ? def.rowGroup : 0;
}

/**
 * Returns whether a row group should be shown at the given zoom level.
 *
 * - **normal** / **half**: all rows are shown.
 * - **full**: only the focused row group is shown.
 */
export function isRowVisible(
  rowGroup: number,
  focusedRowGroup: number,
  zoomLevel: ZoomLevel,
): boolean {
  if (zoomLevel !== "full") return true;
  return rowGroup === focusedRowGroup;
}
