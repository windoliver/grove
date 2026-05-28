import { nextZoom } from "./hooks/use-keyboard-handler.js";
import type { ZoomLevel } from "./panels/panel-manager.js";

/** State managed by the keyboard-driven reducer. */
export interface TuiKeyboardState {
  readonly vfsNavigateTrigger: number;
  readonly artifactIndex: number;
  readonly showArtifactDiff: boolean;
  readonly artifactDiffMode: "inline" | "split";
  readonly paletteIndex: number;
  readonly paletteQuery: string;
  readonly searchQuery: string;
  readonly searchBuffer: string;
  readonly messageBuffer: string;
  readonly messageRecipients: string;
  readonly goalBuffer: string;
  readonly compareMode: boolean;
  readonly compareCids: readonly string[];
  readonly activeFrontierSlice: string;
  readonly frontierTabKeys: readonly string[];
  readonly adoptContext: { readonly targetCid: string; readonly summary: string } | undefined;
  readonly zoomLevel: ZoomLevel;
  readonly terminalScrollOffset: number;
  readonly layoutMode: "grid" | "tab";
}

/** Actions for the TUI keyboard state reducer. */
export type TuiAction =
  | { readonly type: "VFS_NAVIGATE" }
  | { readonly type: "ARTIFACT_PREV" }
  | { readonly type: "ARTIFACT_NEXT" }
  | { readonly type: "ARTIFACT_DIFF_TOGGLE" }
  | { readonly type: "ARTIFACT_DIFF_MODE_TOGGLE" }
  | { readonly type: "PALETTE_UP" }
  | { readonly type: "PALETTE_DOWN"; readonly maxIndex: number }
  | { readonly type: "PALETTE_RESET" }
  | { readonly type: "PALETTE_CHAR"; readonly char: string }
  | { readonly type: "PALETTE_BACKSPACE" }
  | { readonly type: "SEARCH_START"; readonly currentQuery: string }
  | { readonly type: "SEARCH_CHAR"; readonly char: string }
  | { readonly type: "SEARCH_BACKSPACE" }
  | { readonly type: "SEARCH_SUBMIT" }
  | { readonly type: "MESSAGE_CHAR"; readonly char: string }
  | { readonly type: "MESSAGE_BACKSPACE" }
  | { readonly type: "MESSAGE_CLEAR" }
  | { readonly type: "BROADCAST_MODE" }
  | { readonly type: "DIRECT_MESSAGE_MODE" }
  | { readonly type: "GOAL_INPUT_MODE" }
  | { readonly type: "GOAL_CHAR"; readonly char: string }
  | { readonly type: "GOAL_BACKSPACE" }
  | { readonly type: "GOAL_SUBMIT" }
  | { readonly type: "COMPARE_TOGGLE" }
  | { readonly type: "COMPARE_SELECT"; readonly cid: string }
  | { readonly type: "COMPARE_ADOPT" }
  | { readonly type: "FRONTIER_SET_TABS"; readonly keys: readonly string[] }
  | { readonly type: "FRONTIER_SLICE_SET"; readonly key: string }
  | { readonly type: "FRONTIER_SLICE_NEXT" }
  | { readonly type: "FRONTIER_SLICE_PREV" }
  | { readonly type: "ADOPT_SET"; readonly targetCid: string; readonly summary: string }
  | { readonly type: "ADOPT_CLEAR" }
  | { readonly type: "ZOOM_CYCLE" }
  | { readonly type: "ZOOM_RESET" }
  | { readonly type: "TERMINAL_SCROLL_UP" }
  | { readonly type: "TERMINAL_SCROLL_DOWN" }
  | { readonly type: "TERMINAL_SCROLL_BOTTOM" }
  | { readonly type: "LAYOUT_TOGGLE" };

export const INITIAL_KEYBOARD_STATE: TuiKeyboardState = {
  vfsNavigateTrigger: 0,
  artifactIndex: 0,
  showArtifactDiff: false,
  artifactDiffMode: "inline",
  paletteIndex: 0,
  paletteQuery: "",
  searchQuery: "",
  searchBuffer: "",
  messageBuffer: "",
  messageRecipients: "",
  goalBuffer: "",
  compareMode: false,
  compareCids: [],
  activeFrontierSlice: "overview",
  frontierTabKeys: ["overview"],
  adoptContext: undefined,
  zoomLevel: "normal",
  terminalScrollOffset: 0,
  layoutMode: "tab",
};

/** Pure reducer for TUI keyboard state - testable and serializable. */
export function tuiReducer(state: TuiKeyboardState, action: TuiAction): TuiKeyboardState {
  switch (action.type) {
    case "VFS_NAVIGATE":
      return { ...state, vfsNavigateTrigger: state.vfsNavigateTrigger + 1 };
    case "ARTIFACT_PREV":
      return { ...state, artifactIndex: Math.max(0, state.artifactIndex - 1) };
    case "ARTIFACT_NEXT":
      return { ...state, artifactIndex: state.artifactIndex + 1 };
    case "ARTIFACT_DIFF_TOGGLE":
      return { ...state, showArtifactDiff: !state.showArtifactDiff };
    case "ARTIFACT_DIFF_MODE_TOGGLE":
      return {
        ...state,
        artifactDiffMode: state.artifactDiffMode === "inline" ? "split" : "inline",
      };
    case "PALETTE_UP":
      return { ...state, paletteIndex: Math.max(0, state.paletteIndex - 1) };
    case "PALETTE_DOWN":
      return { ...state, paletteIndex: Math.min(state.paletteIndex + 1, action.maxIndex) };
    case "PALETTE_RESET":
      return { ...state, paletteIndex: 0, paletteQuery: "" };
    case "PALETTE_CHAR":
      return { ...state, paletteQuery: state.paletteQuery + action.char, paletteIndex: 0 };
    case "PALETTE_BACKSPACE":
      return { ...state, paletteQuery: state.paletteQuery.slice(0, -1), paletteIndex: 0 };
    case "SEARCH_START":
      return { ...state, searchBuffer: action.currentQuery };
    case "SEARCH_CHAR":
      return { ...state, searchBuffer: state.searchBuffer + action.char };
    case "SEARCH_BACKSPACE":
      return { ...state, searchBuffer: state.searchBuffer.slice(0, -1) };
    case "SEARCH_SUBMIT":
      return { ...state, searchQuery: state.searchBuffer };
    case "MESSAGE_CHAR":
      return { ...state, messageBuffer: state.messageBuffer + action.char };
    case "MESSAGE_BACKSPACE":
      return { ...state, messageBuffer: state.messageBuffer.slice(0, -1) };
    case "MESSAGE_CLEAR":
      return { ...state, messageBuffer: "", messageRecipients: "" };
    case "BROADCAST_MODE":
      return { ...state, messageBuffer: "", messageRecipients: "@all" };
    case "DIRECT_MESSAGE_MODE":
      return { ...state, messageBuffer: "@", messageRecipients: "@direct" };
    case "GOAL_INPUT_MODE":
      return { ...state, goalBuffer: "" };
    case "GOAL_CHAR":
      return { ...state, goalBuffer: state.goalBuffer + action.char };
    case "GOAL_BACKSPACE":
      return { ...state, goalBuffer: state.goalBuffer.slice(0, -1) };
    case "GOAL_SUBMIT":
      return { ...state, goalBuffer: "" };
    case "COMPARE_TOGGLE":
      return {
        ...state,
        compareMode: !state.compareMode,
        compareCids: state.compareMode ? state.compareCids : [],
      };
    case "COMPARE_SELECT": {
      const prev = state.compareCids;
      if (prev.includes(action.cid)) {
        return { ...state, compareCids: prev.filter((c) => c !== action.cid) };
      }
      if (prev.length >= 2) {
        const second = prev[1] ?? prev[0] ?? action.cid;
        return { ...state, compareCids: [second, action.cid] };
      }
      return { ...state, compareCids: [...prev, action.cid] };
    }
    case "COMPARE_ADOPT":
      return { ...state, compareMode: false, compareCids: [] };
    case "FRONTIER_SET_TABS": {
      const keys = action.keys.length > 0 ? action.keys : ["overview"];
      const stillValid = keys.includes(state.activeFrontierSlice);
      return {
        ...state,
        frontierTabKeys: keys,
        activeFrontierSlice: stillValid ? state.activeFrontierSlice : "overview",
      };
    }
    case "FRONTIER_SLICE_SET":
      return state.frontierTabKeys.includes(action.key)
        ? { ...state, activeFrontierSlice: action.key }
        : state;
    case "FRONTIER_SLICE_NEXT": {
      const idx = state.frontierTabKeys.indexOf(state.activeFrontierSlice);
      const next = state.frontierTabKeys[(idx + 1) % state.frontierTabKeys.length];
      return next ? { ...state, activeFrontierSlice: next } : state;
    }
    case "FRONTIER_SLICE_PREV": {
      const idx = state.frontierTabKeys.indexOf(state.activeFrontierSlice);
      const prev =
        state.frontierTabKeys[
          (idx - 1 + state.frontierTabKeys.length) % state.frontierTabKeys.length
        ];
      return prev ? { ...state, activeFrontierSlice: prev } : state;
    }
    case "ADOPT_SET":
      return {
        ...state,
        adoptContext: { targetCid: action.targetCid, summary: action.summary },
      };
    case "ADOPT_CLEAR":
      return state.adoptContext === undefined ? state : { ...state, adoptContext: undefined };
    case "ZOOM_CYCLE":
      return { ...state, zoomLevel: nextZoom(state.zoomLevel) };
    case "ZOOM_RESET":
      return state.zoomLevel === "normal" ? state : { ...state, zoomLevel: "normal" };
    case "TERMINAL_SCROLL_UP":
      return { ...state, terminalScrollOffset: state.terminalScrollOffset + 5 };
    case "TERMINAL_SCROLL_DOWN":
      return { ...state, terminalScrollOffset: Math.max(0, state.terminalScrollOffset - 5) };
    case "TERMINAL_SCROLL_BOTTOM":
      return state.terminalScrollOffset === 0 ? state : { ...state, terminalScrollOffset: 0 };
    case "LAYOUT_TOGGLE":
      return { ...state, layoutMode: state.layoutMode === "tab" ? "grid" : "tab" };
  }
}
