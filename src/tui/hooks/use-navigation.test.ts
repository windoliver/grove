/**
 * Tests for the navigation state machine.
 *
 * Tests pure state transitions directly (no React rendering needed).
 */

import { describe, expect, test } from "bun:test";
import {
  detailCid,
  initialNavState,
  isDetailView,
  navCursorDown,
  navCursorUp,
  navNextPage,
  navPopDetail,
  navPrevPage,
  navPushDetail,
  navSwitchTab,
  TAB_LABELS,
  Tab,
} from "./use-navigation.js";

describe("initialNavState", () => {
  test("starts on Dashboard tab with empty state", () => {
    const state = initialNavState();
    expect(state.activeTab).toBe(Tab.Dashboard);
    expect(state.detailStack).toEqual([]);
    expect(state.cursor).toBe(0);
    expect(state.pageOffset).toBe(0);
  });
});

describe("TAB_LABELS", () => {
  test("has labels for all tabs", () => {
    expect(TAB_LABELS).toEqual(["Dashboard", "DAG", "Claims", "Activity"]);
  });
});

describe("navSwitchTab", () => {
  test("switches to target tab and resets all state", () => {
    const state = navSwitchTab(Tab.Claims);
    expect(state.activeTab).toBe(Tab.Claims);
    expect(state.cursor).toBe(0);
    expect(state.pageOffset).toBe(0);
    expect(state.detailStack).toEqual([]);
  });
});

describe("detail stack", () => {
  test("pushDetail adds CID to stack", () => {
    const s0 = initialNavState();
    const s1 = navPushDetail(s0, "cid-1");
    expect(s1.detailStack).toEqual(["cid-1"]);
    expect(isDetailView(s1)).toBe(true);
    expect(detailCid(s1)).toBe("cid-1");
  });

  test("pushDetail resets cursor", () => {
    const s0 = { ...initialNavState(), cursor: 5 };
    const s1 = navPushDetail(s0, "cid-1");
    expect(s1.cursor).toBe(0);
  });

  test("multiple pushes build a stack", () => {
    let state = initialNavState();
    state = navPushDetail(state, "cid-1");
    state = navPushDetail(state, "cid-2");
    state = navPushDetail(state, "cid-3");
    expect(state.detailStack).toEqual(["cid-1", "cid-2", "cid-3"]);
    expect(detailCid(state)).toBe("cid-3");
  });

  test("popDetail removes last CID", () => {
    let state = initialNavState();
    state = navPushDetail(state, "cid-1");
    state = navPushDetail(state, "cid-2");
    state = navPopDetail(state);
    expect(state.detailStack).toEqual(["cid-1"]);
    expect(detailCid(state)).toBe("cid-1");
  });

  test("popDetail on empty stack remains empty", () => {
    const state = navPopDetail(initialNavState());
    expect(state.detailStack).toEqual([]);
    expect(isDetailView(state)).toBe(false);
    expect(detailCid(state)).toBeUndefined();
  });
});

describe("cursor movement", () => {
  test("cursorDown increments up to maxIndex", () => {
    let state = initialNavState();
    state = navCursorDown(state, 5);
    expect(state.cursor).toBe(1);
    state = navCursorDown(state, 5);
    expect(state.cursor).toBe(2);
  });

  test("cursorDown clamps at maxIndex", () => {
    const state = { ...initialNavState(), cursor: 5 };
    const result = navCursorDown(state, 5);
    expect(result.cursor).toBe(5);
    // Returns same reference when no change
    expect(result).toBe(state);
  });

  test("cursorUp decrements to 0", () => {
    let state = { ...initialNavState(), cursor: 3 };
    state = navCursorUp(state);
    expect(state.cursor).toBe(2);
  });

  test("cursorUp clamps at 0", () => {
    const state = initialNavState();
    const result = navCursorUp(state);
    expect(result.cursor).toBe(0);
    expect(result).toBe(state);
  });
});

describe("pagination", () => {
  test("nextPage advances by pageSize", () => {
    const state = initialNavState();
    const result = navNextPage(state, 20, 100);
    expect(result.pageOffset).toBe(20);
    expect(result.cursor).toBe(0);
  });

  test("nextPage does not advance past totalItems", () => {
    const state = { ...initialNavState(), pageOffset: 80 };
    const result = navNextPage(state, 20, 100);
    expect(result).toBe(state); // no change
  });

  test("prevPage goes back by pageSize", () => {
    const state = { ...initialNavState(), pageOffset: 40 };
    const result = navPrevPage(state, 20);
    expect(result.pageOffset).toBe(20);
    expect(result.cursor).toBe(0);
  });

  test("prevPage clamps at 0", () => {
    const state = initialNavState();
    const result = navPrevPage(state, 20);
    expect(result).toBe(state); // no change
  });
});

describe("isDetailView and detailCid", () => {
  test("isDetailView false when stack empty", () => {
    expect(isDetailView(initialNavState())).toBe(false);
  });

  test("detailCid undefined when stack empty", () => {
    expect(detailCid(initialNavState())).toBeUndefined();
  });

  test("detailCid returns last item in stack", () => {
    let state = navPushDetail(initialNavState(), "a");
    state = navPushDetail(state, "b");
    expect(detailCid(state)).toBe("b");
  });
});
