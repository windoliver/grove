import { describe, expect, test } from "bun:test";
import { INITIAL_KEYBOARD_STATE, tuiReducer } from "./app-reducer.js";

describe("frontier reducer slice", () => {
  test("FRONTIER_SET_TABS replaces tab keys, preserves valid active", () => {
    const s1 = tuiReducer(
      { ...INITIAL_KEYBOARD_STATE, activeFrontierSlice: "adoption" },
      { type: "FRONTIER_SET_TABS", keys: ["overview", "adoption", "recency"] },
    );
    expect(s1.frontierTabKeys).toEqual(["overview", "adoption", "recency"]);
    expect(s1.activeFrontierSlice).toBe("adoption");
  });

  test("FRONTIER_SET_TABS resets active to overview when key drops out", () => {
    const s1 = tuiReducer(
      { ...INITIAL_KEYBOARD_STATE, activeFrontierSlice: "metric:gone" },
      { type: "FRONTIER_SET_TABS", keys: ["overview", "adoption"] },
    );
    expect(s1.activeFrontierSlice).toBe("overview");
  });

  test("FRONTIER_SET_TABS empty keys → fallback to ['overview']", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "FRONTIER_SET_TABS", keys: [] });
    expect(s1.frontierTabKeys).toEqual(["overview"]);
    expect(s1.activeFrontierSlice).toBe("overview");
  });

  test("FRONTIER_SLICE_NEXT cycles and wraps", () => {
    const base = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "FRONTIER_SET_TABS",
      keys: ["overview", "adoption", "recency"],
    });
    const a = tuiReducer(base, { type: "FRONTIER_SLICE_NEXT" });
    expect(a.activeFrontierSlice).toBe("adoption");
    const b = tuiReducer(a, { type: "FRONTIER_SLICE_NEXT" });
    expect(b.activeFrontierSlice).toBe("recency");
    const c = tuiReducer(b, { type: "FRONTIER_SLICE_NEXT" });
    expect(c.activeFrontierSlice).toBe("overview");
  });

  test("FRONTIER_SLICE_PREV wraps backward", () => {
    const base = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "FRONTIER_SET_TABS",
      keys: ["overview", "adoption", "recency"],
    });
    const a = tuiReducer(base, { type: "FRONTIER_SLICE_PREV" });
    expect(a.activeFrontierSlice).toBe("recency");
  });

  test("FRONTIER_SLICE_SET ignores unknown key", () => {
    const s = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "FRONTIER_SLICE_SET", key: "bogus" });
    expect(s.activeFrontierSlice).toBe("overview");
  });

  test("ADOPT_SET / ADOPT_CLEAR", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "ADOPT_SET",
      targetCid: "cid-1",
      summary: "do thing",
    });
    expect(s1.adoptContext).toEqual({ targetCid: "cid-1", summary: "do thing" });
    const s2 = tuiReducer(s1, { type: "ADOPT_CLEAR" });
    expect(s2.adoptContext).toBeUndefined();
  });

  test("COMPARE_ADOPT preserves adoptContext (the compare-adopt flow sets it just before)", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "ADOPT_SET",
      targetCid: "cid-1",
      summary: "x",
    });
    const s2 = tuiReducer(s1, { type: "COMPARE_ADOPT" });
    expect(s2.adoptContext).toEqual({ targetCid: "cid-1", summary: "x" });
    expect(s2.compareMode).toBe(false);
    expect(s2.compareCids).toEqual([]);
  });
});
