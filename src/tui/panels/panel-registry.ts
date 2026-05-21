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
import type { TuiRegistryEntry } from "../plugins/registry.js";
import { type BuiltInPanelId, PanelId, panelToId } from "./panel-ids.js";

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

export const PRESET_PANEL_IDS: Readonly<Record<string, ReadonlySet<BuiltInPanelId>>> = {
  "review-loop": new Set([PanelId.Dag, PanelId.Detail, PanelId.Claims, PanelId.Terminal]),
  "swarm-ops": new Set([
    PanelId.Dag,
    PanelId.Detail,
    PanelId.Claims,
    PanelId.Terminal,
    PanelId.Frontier,
    PanelId.Outcomes,
    PanelId.Bounties,
  ]),
  "federated-swarm": new Set([
    PanelId.Dag,
    PanelId.Detail,
    PanelId.Claims,
    PanelId.Terminal,
    PanelId.Frontier,
    PanelId.Gossip,
  ]),
};

export function getPresetPanelIds(presetName?: string): ReadonlySet<BuiltInPanelId> | undefined {
  if (!presetName) return undefined;
  return PRESET_PANEL_IDS[presetName];
}

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
interface PanelDefBase {
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
  /**
   * Keyboard shortcut for this panel.
   * Core panels: key focuses the panel (1–4).
   * Operator panels: key toggles the panel on/off.
   */
  readonly keybinding: string;
}

export interface PanelDef extends PanelDefBase {
  readonly id: BuiltInPanelId;
  readonly slot: "operator-panel";
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
const PANEL_REGISTRY_BASE: readonly PanelDefBase[] = [
  // Row 0: DAG + Detail (core)
  {
    panel: Panel.Dag,
    label: PANEL_LABELS[Panel.Dag],
    rowGroup: 0,
    kind: "core",
    keybinding: "1",
    rowPartners: [Panel.Detail],
  },
  {
    panel: Panel.Detail,
    label: PANEL_LABELS[Panel.Detail],
    rowGroup: 0,
    kind: "core",
    keybinding: "2",
    rowPartners: [Panel.Dag],
  },

  // Row 1: Frontier (core)
  {
    panel: Panel.Frontier,
    label: PANEL_LABELS[Panel.Frontier],
    rowGroup: 1,
    kind: "core",
    keybinding: "3",
  },

  // Row 2: Claims (core)
  {
    panel: Panel.Claims,
    label: PANEL_LABELS[Panel.Claims],
    rowGroup: 2,
    kind: "core",
    keybinding: "4",
  },

  // Row 3: AgentList + Terminal (operator)
  {
    panel: Panel.AgentList,
    label: PANEL_LABELS[Panel.AgentList],
    rowGroup: 3,
    kind: "operator",
    keybinding: "5",
    rowPartners: [Panel.Terminal],
  },
  {
    panel: Panel.Terminal,
    label: PANEL_LABELS[Panel.Terminal],
    rowGroup: 3,
    kind: "operator",
    keybinding: "6",
    rowPartners: [Panel.AgentList],
  },

  // Row 4: Artifact + Vfs (operator)
  {
    panel: Panel.Artifact,
    label: PANEL_LABELS[Panel.Artifact],
    rowGroup: 4,
    kind: "operator",
    keybinding: "7",
    rowPartners: [Panel.Vfs],
  },
  {
    panel: Panel.Vfs,
    label: PANEL_LABELS[Panel.Vfs],
    rowGroup: 4,
    kind: "operator",
    keybinding: "8",
    rowPartners: [Panel.Artifact],
  },

  // Row 5: Activity + Search (operator)
  {
    panel: Panel.Activity,
    label: PANEL_LABELS[Panel.Activity],
    rowGroup: 5,
    kind: "operator",
    keybinding: "9",
    rowPartners: [Panel.Search],
  },
  {
    panel: Panel.Search,
    label: PANEL_LABELS[Panel.Search],
    rowGroup: 5,
    kind: "operator",
    keybinding: "0",
    rowPartners: [Panel.Activity],
  },

  // Row 6: Threads + Outcomes (operator)
  {
    panel: Panel.Threads,
    label: PANEL_LABELS[Panel.Threads],
    rowGroup: 6,
    kind: "operator",
    keybinding: "-",
    rowPartners: [Panel.Outcomes],
  },
  {
    panel: Panel.Outcomes,
    label: PANEL_LABELS[Panel.Outcomes],
    rowGroup: 6,
    kind: "operator",
    keybinding: "=",
    rowPartners: [Panel.Threads],
  },

  // Row 7: Bounties + Gossip (operator)
  {
    panel: Panel.Bounties,
    label: PANEL_LABELS[Panel.Bounties],
    rowGroup: 7,
    kind: "operator",
    keybinding: "[",
    rowPartners: [Panel.Gossip],
  },
  {
    panel: Panel.Gossip,
    label: PANEL_LABELS[Panel.Gossip],
    rowGroup: 7,
    kind: "operator",
    keybinding: "]",
    rowPartners: [Panel.Bounties],
  },

  // Row 8: Inbox + Decisions + GitHub (operator)
  {
    panel: Panel.Inbox,
    label: PANEL_LABELS[Panel.Inbox],
    rowGroup: 8,
    kind: "operator",
    keybinding: "\\",
    rowPartners: [Panel.Decisions, Panel.GitHub],
  },
  {
    panel: Panel.Decisions,
    label: PANEL_LABELS[Panel.Decisions],
    rowGroup: 8,
    kind: "operator",
    keybinding: ";",
    rowPartners: [Panel.Inbox, Panel.GitHub],
  },
  {
    panel: Panel.GitHub,
    label: PANEL_LABELS[Panel.GitHub],
    rowGroup: 8,
    kind: "operator",
    keybinding: "'",
    rowPartners: [Panel.Inbox, Panel.Decisions],
  },

  // Row 9: Plan (operator)
  {
    panel: Panel.Plan,
    label: PANEL_LABELS[Panel.Plan],
    rowGroup: 9,
    kind: "operator",
    keybinding: "`",
  },
] as const;

export const PANEL_REGISTRY: readonly PanelDef[] = Object.freeze(
  PANEL_REGISTRY_BASE.map((def) =>
    Object.freeze({
      ...def,
      id: panelToId(def.panel),
      slot: "operator-panel" as const,
    }),
  ),
);

// ---------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------

/** Returns the full panel registry. */
export function getRegistry(): readonly PanelDef[] {
  return PANEL_REGISTRY;
}

export function getPanelDefById(id: BuiltInPanelId): PanelDef | undefined {
  return PANEL_REGISTRY.find((def) => def.id === id);
}

export function getBuiltInTuiRegistryEntries(): readonly TuiRegistryEntry[] {
  return PANEL_REGISTRY.map((def, order) => ({
    id: def.id,
    label: def.label,
    slot: def.slot,
    order,
    source: "builtin",
    builtInPanel: def.panel,
  }));
}

/** Groups panel definitions by their row group number. */
export function getRowGroups(
  registry: readonly PanelDef[] = PANEL_REGISTRY,
): Map<number, readonly PanelDef[]> {
  const groups = new Map<number, PanelDef[]>();
  for (const def of registry) {
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
  registry: readonly PanelDef[] = PANEL_REGISTRY,
): readonly PanelDef[] {
  if (mode === "tab") {
    const def = registry.find((d) => d.panel === panelState.focused);
    return def !== undefined ? [def] : [];
  }

  // Grid mode: core panels always visible, operator panels per state.
  // Also filter by allowedPanels if provided (preset-based visibility).
  return registry.filter(
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
  registry: readonly PanelDef[] = PANEL_REGISTRY,
): ReadonlySet<Panel> {
  if (mode === "tab") {
    const def = registry.find((d) => d.panel === panelState.focused);
    return def !== undefined ? new Set([panelState.focused]) : new Set();
  }

  // Grid mode: every visible panel is active.
  const active = new Set<Panel>();
  for (const def of registry) {
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
  const def = PANEL_REGISTRY.find((d) => d.panel === panel);
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
