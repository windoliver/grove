/**
 * Panel focus state machine for multi-panel layout.
 *
 * Manages which panel is focused, which optional panels are visible,
 * and the current input mode. Pure state transitions exported for testing.
 */

import { useCallback, useState } from "react";

// ---------------------------------------------------------------------------
// Panel identifiers
// ---------------------------------------------------------------------------

/** Panel identifiers — protocol core (1-4), operator tooling (5-12). */
export const Panel = {
  Dag: 1,
  Detail: 2,
  Frontier: 3,
  Claims: 4,
  AgentList: 5,
  Terminal: 6,
  Artifact: 7,
  Vfs: 8,
  Activity: 9,
  Search: 10,
  Threads: 11,
  Outcomes: 12,
  Bounties: 13,
  Gossip: 14,
  Inbox: 15,
  Decisions: 16,
  GitHub: 17,
} as const;
export type Panel = (typeof Panel)[keyof typeof Panel];

/** Panel labels for display. */
export const PANEL_LABELS: Readonly<Record<Panel, string>> = {
  [Panel.Dag]: "DAG",
  [Panel.Detail]: "Detail",
  [Panel.Frontier]: "Frontier",
  [Panel.Claims]: "Claims",
  [Panel.AgentList]: "Agents",
  [Panel.Terminal]: "Terminal",
  [Panel.Artifact]: "Artifact",
  [Panel.Vfs]: "VFS",
  [Panel.Activity]: "Activity",
  [Panel.Search]: "Search",
  [Panel.Threads]: "Threads",
  [Panel.Outcomes]: "Outcomes",
  [Panel.Bounties]: "Bounties",
  [Panel.Gossip]: "Gossip",
  [Panel.Inbox]: "Inbox",
  [Panel.Decisions]: "Decisions",
  [Panel.GitHub]: "GitHub",
};

/** Protocol core panels — always visible. */
export const CORE_PANELS: readonly Panel[] = [
  Panel.Dag,
  Panel.Detail,
  Panel.Frontier,
  Panel.Claims,
];

/** Operator panels — toggled on demand. */
export const OPERATOR_PANELS: readonly Panel[] = [
  Panel.AgentList,
  Panel.Terminal,
  Panel.Artifact,
  Panel.Vfs,
  Panel.Activity,
  Panel.Search,
  Panel.Threads,
  Panel.Outcomes,
  Panel.Bounties,
  Panel.Gossip,
  Panel.Inbox,
  Panel.Decisions,
  Panel.GitHub,
];

// ---------------------------------------------------------------------------
// Input mode
// ---------------------------------------------------------------------------

/** Input mode hierarchy: command palette > help > search input > message input > terminal input > normal. */
export const InputMode = {
  Normal: "normal",
  TerminalInput: "terminal_input",
  CommandPalette: "command_palette",
  SearchInput: "search_input",
  MessageInput: "message_input",
  Help: "help",
} as const;
export type InputMode = (typeof InputMode)[keyof typeof InputMode];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Panel focus state. */
export interface PanelFocusState {
  /** Currently focused panel. */
  readonly focused: Panel;
  /** Set of visible operator panels (core panels are always visible). */
  readonly visibleOperator: ReadonlySet<Panel>;
  /** Current input mode. */
  readonly mode: InputMode;
}

// ---------------------------------------------------------------------------
// Pure state transitions
// ---------------------------------------------------------------------------

/** Create the initial panel focus state. */
export function initialPanelState(): PanelFocusState {
  return {
    focused: Panel.Dag,
    visibleOperator: new Set(),
    mode: InputMode.Normal,
  };
}

/** Focus a specific panel (only if visible). */
export function panelFocus(state: PanelFocusState, panel: Panel): PanelFocusState {
  if (!isPanelVisible(state, panel)) return state;
  if (state.focused === panel) return state;
  return { ...state, focused: panel };
}

/** Toggle an operator panel's visibility. */
export function panelToggle(state: PanelFocusState, panel: Panel): PanelFocusState {
  // Can only toggle operator panels (5-8)
  if (panel < Panel.AgentList) return state;

  const next = new Set(state.visibleOperator);
  if (next.has(panel)) {
    next.delete(panel);
    // If the toggled-off panel was focused, refocus to DAG
    const focused = state.focused === panel ? Panel.Dag : state.focused;
    return { ...state, visibleOperator: next, focused };
  }
  next.add(panel);
  // Focus the newly visible panel
  return { ...state, visibleOperator: next, focused: panel };
}

/** Cycle focus to the next visible panel. */
export function panelCycleNext(state: PanelFocusState): PanelFocusState {
  const visible = getVisiblePanels(state);
  const idx = visible.indexOf(state.focused);
  const next = visible[(idx + 1) % visible.length];
  if (next === undefined || next === state.focused) return state;
  return { ...state, focused: next };
}

/** Cycle focus to the previous visible panel. */
export function panelCyclePrev(state: PanelFocusState): PanelFocusState {
  const visible = getVisiblePanels(state);
  const idx = visible.indexOf(state.focused);
  const next = visible[(idx - 1 + visible.length) % visible.length];
  if (next === undefined || next === state.focused) return state;
  return { ...state, focused: next };
}

/** Enter a specific input mode. */
export function panelSetMode(state: PanelFocusState, mode: InputMode): PanelFocusState {
  if (state.mode === mode) return state;
  return { ...state, mode };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Check if a panel is currently visible. */
export function isPanelVisible(state: PanelFocusState, panel: Panel): boolean {
  if (panel <= Panel.Claims) return true; // Core panels always visible
  return state.visibleOperator.has(panel);
}

/** Get all visible panels in order. */
export function getVisiblePanels(state: PanelFocusState): readonly Panel[] {
  const result: Panel[] = [...CORE_PANELS];
  for (const p of OPERATOR_PANELS) {
    if (state.visibleOperator.has(p)) {
      result.push(p);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Panel focus actions returned by the hook. */
export interface PanelFocusActions {
  readonly state: PanelFocusState;
  readonly focus: (panel: Panel) => void;
  readonly toggle: (panel: Panel) => void;
  readonly cycleNext: () => void;
  readonly cyclePrev: () => void;
  readonly setMode: (mode: InputMode) => void;
  readonly isVisible: (panel: Panel) => boolean;
  readonly visiblePanels: readonly Panel[];
}

/** Hook for multi-panel focus management. */
export function usePanelFocus(): PanelFocusActions {
  const [state, setState] = useState<PanelFocusState>(initialPanelState);

  return {
    state,
    focus: useCallback((p: Panel) => setState((s) => panelFocus(s, p)), []),
    toggle: useCallback((p: Panel) => setState((s) => panelToggle(s, p)), []),
    cycleNext: useCallback(() => setState((s) => panelCycleNext(s)), []),
    cyclePrev: useCallback(() => setState((s) => panelCyclePrev(s)), []),
    setMode: useCallback((m: InputMode) => setState((s) => panelSetMode(s, m)), []),
    isVisible: isPanelVisible.bind(null, state),
    visiblePanels: getVisiblePanels(state),
  };
}
