/**
 * Keyboard input routing for the TUI.
 *
 * Handles tab switching (1-4), panel toggles (5-8), vim navigation (j/k),
 * drill-down (Enter/Esc), pagination (n/p), refresh (r), and quit (q).
 *
 * Uses OpenTUI's useKeyboard hook.
 */

import { useKeyboard } from "@opentui/react";
import type { NavigationActions } from "./use-navigation.js";
import { Tab } from "./use-navigation.js";

/** Keybinding handler options. */
export interface KeybindingOptions {
  readonly nav: NavigationActions;
  /** Number of items in the current list view. */
  readonly listLength: number;
  /** Callback when Enter is pressed on a list item. Receives cursor index. */
  readonly onSelect?: ((index: number) => void) | undefined;
  /** Callback when r is pressed. */
  readonly onRefresh?: (() => void) | undefined;
  /** Callback when / is pressed to toggle filter. */
  readonly onFilter?: (() => void) | undefined;
  /** Callback when q is pressed. */
  readonly onQuit?: (() => void) | undefined;
  /** Page size for n/p pagination. */
  readonly pageSize?: number | undefined;
  /** Total items for pagination bounds checking. */
  readonly totalItems?: number | undefined;
}

/** Hook that wires up keyboard input to navigation actions. */
export function useKeybindings(opts: KeybindingOptions): void {
  const {
    nav,
    listLength,
    onSelect,
    onRefresh,
    onFilter,
    onQuit,
    pageSize = 20,
    totalItems = 0,
  } = opts;

  useKeyboard((key) => {
    const input = key.name;
    const isReturn = input === "return";
    const isEscape = input === "escape";
    const isDown = input === "down";
    const isUp = input === "up";

    // Tab switching: 1-4
    if (input === "1") {
      nav.switchTab(Tab.Dashboard);
      return;
    }
    if (input === "2") {
      nav.switchTab(Tab.Dag);
      return;
    }
    if (input === "3") {
      nav.switchTab(Tab.Claims);
      return;
    }
    if (input === "4") {
      nav.switchTab(Tab.Activity);
      return;
    }

    // Vim navigation: j/k or arrow keys
    if (input === "j" || isDown) {
      nav.cursorDown(Math.max(0, listLength - 1));
      return;
    }
    if (input === "k" || isUp) {
      nav.cursorUp();
      return;
    }

    // Drill-down: Enter to select, Escape to go back
    if (isReturn && onSelect && listLength > 0) {
      onSelect(nav.state.cursor);
      return;
    }
    if (isEscape) {
      if (nav.isDetailView) {
        nav.popDetail();
      }
      return;
    }

    // Pagination: n/p
    if (input === "n") {
      nav.nextPage(pageSize, totalItems);
      return;
    }
    if (input === "p") {
      nav.prevPage(pageSize);
      return;
    }

    // Actions
    if (input === "r" && onRefresh) {
      onRefresh();
      return;
    }
    if (input === "/" && onFilter) {
      onFilter();
      return;
    }
    if (input === "q" && onQuit) {
      onQuit();
    }
  });
}
