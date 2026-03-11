/**
 * Navigation hook for tab switching and detail drill-down.
 *
 * The state machine logic is pure (exported for testing).
 * The hook provides a React binding on top.
 */

import { useCallback, useState } from "react";

/** Tab identifiers. */
export const Tab = {
  Dashboard: 0,
  Dag: 1,
  Claims: 2,
  Activity: 3,
} as const;
export type Tab = (typeof Tab)[keyof typeof Tab];

/** Tab labels for display. */
export const TAB_LABELS: readonly string[] = ["Dashboard", "DAG", "Claims", "Activity"];

/** Navigation state. */
export interface NavigationState {
  /** Currently active tab index. */
  readonly activeTab: Tab;
  /** Stack of contribution CIDs for detail drill-down. Empty = no detail view. */
  readonly detailStack: readonly string[];
  /** Current cursor index within the active list. */
  readonly cursor: number;
  /** Current page offset for pagination. */
  readonly pageOffset: number;
}

// ---------------------------------------------------------------------------
// Pure state machine transitions (exported for testing)
// ---------------------------------------------------------------------------

/** Create the initial navigation state. */
export function initialNavState(): NavigationState {
  return { activeTab: Tab.Dashboard, detailStack: [], cursor: 0, pageOffset: 0 };
}

/** Switch to a tab, resetting detail/cursor/page state. */
export function navSwitchTab(tab: Tab): NavigationState {
  return { activeTab: tab, detailStack: [], cursor: 0, pageOffset: 0 };
}

/** Push a CID onto the detail stack. */
export function navPushDetail(state: NavigationState, cid: string): NavigationState {
  return { ...state, detailStack: [...state.detailStack, cid], cursor: 0 };
}

/** Pop the detail stack. */
export function navPopDetail(state: NavigationState): NavigationState {
  return { ...state, detailStack: state.detailStack.slice(0, -1), cursor: 0 };
}

/** Move cursor up (clamped to 0). */
export function navCursorUp(state: NavigationState): NavigationState {
  const next = Math.max(0, state.cursor - 1);
  return next === state.cursor ? state : { ...state, cursor: next };
}

/** Move cursor down (clamped to maxIndex). */
export function navCursorDown(state: NavigationState, maxIndex: number): NavigationState {
  const next = Math.min(maxIndex, state.cursor + 1);
  return next === state.cursor ? state : { ...state, cursor: next };
}

/** Go to next page. */
export function navNextPage(
  state: NavigationState,
  pageSize: number,
  totalItems: number,
): NavigationState {
  const next = state.pageOffset + pageSize;
  if (next >= totalItems) return state;
  return { ...state, pageOffset: next, cursor: 0 };
}

/** Go to previous page. */
export function navPrevPage(state: NavigationState, pageSize: number): NavigationState {
  const next = Math.max(0, state.pageOffset - pageSize);
  if (next === state.pageOffset) return state;
  return { ...state, pageOffset: next, cursor: 0 };
}

/** Check if the state has a detail view open. */
export function isDetailView(state: NavigationState): boolean {
  return state.detailStack.length > 0;
}

/** Get the current detail CID, if any. */
export function detailCid(state: NavigationState): string | undefined {
  return state.detailStack[state.detailStack.length - 1];
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Navigation actions returned by the hook. */
export interface NavigationActions {
  readonly state: NavigationState;
  readonly switchTab: (tab: Tab) => void;
  readonly pushDetail: (cid: string) => void;
  readonly popDetail: () => void;
  readonly isDetailView: boolean;
  readonly detailCid: string | undefined;
  readonly cursorUp: () => void;
  readonly cursorDown: (maxIndex: number) => void;
  readonly nextPage: (pageSize: number, totalItems: number) => void;
  readonly prevPage: (pageSize: number) => void;
  readonly resetCursor: () => void;
}

/** Hook for TUI navigation state. */
export function useNavigation(): NavigationActions {
  const [state, setState] = useState<NavigationState>(initialNavState);

  return {
    state,
    switchTab: useCallback((tab: Tab) => setState(navSwitchTab(tab)), []),
    pushDetail: useCallback((cid: string) => setState((s) => navPushDetail(s, cid)), []),
    popDetail: useCallback(() => setState((s) => navPopDetail(s)), []),
    isDetailView: isDetailView(state),
    detailCid: detailCid(state),
    cursorUp: useCallback(() => setState((s) => navCursorUp(s)), []),
    cursorDown: useCallback((max: number) => setState((s) => navCursorDown(s, max)), []),
    nextPage: useCallback(
      (ps: number, total: number) => setState((s) => navNextPage(s, ps, total)),
      [],
    ),
    prevPage: useCallback((ps: number) => setState((s) => navPrevPage(s, ps)), []),
    resetCursor: useCallback(() => setState((s) => ({ ...s, cursor: 0 })), []),
  };
}
