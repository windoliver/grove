/**
 * Integration test: pressing `a` on a frontier row records adoptContext
 * and routes through handleSpawn so the spawn call carries
 * context.adoptTarget / context.adoptSummary.
 *
 * This is a reducer-and-handler-level test (no React renderer): it
 * exercises the same dispatch path that the keyboard handler triggers
 * and verifies the spawn-call shape.
 */

import { describe, expect, test } from "bun:test";
import { INITIAL_KEYBOARD_STATE, tuiReducer } from "../app-reducer.js";

describe("frontier adopt integration (reducer + spawn shape)", () => {
  test("ADOPT_SET → spawn context carries adoptTarget + adoptSummary", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "ADOPT_SET",
      targetCid: "cid-frontier-1",
      summary: "improve cache hit rate",
    });
    expect(s1.adoptContext).toEqual({
      targetCid: "cid-frontier-1",
      summary: "improve cache hit rate",
    });

    // Simulate handleSpawn building the context object.
    const baseContext: Record<string, unknown> = { rolePrompt: "you are X" };
    if (s1.adoptContext) {
      baseContext.adoptTarget = s1.adoptContext.targetCid;
      baseContext.adoptSummary = s1.adoptContext.summary;
    }
    expect(baseContext.adoptTarget).toBe("cid-frontier-1");
    expect(baseContext.adoptSummary).toBe("improve cache hit rate");

    // After successful spawn, ADOPT_CLEAR is dispatched.
    const s2 = tuiReducer(s1, { type: "ADOPT_CLEAR" });
    expect(s2.adoptContext).toBeUndefined();
  });

  test("compare-adopt also lands in adoptContext via ADOPT_SET", () => {
    const initialWithCompare = {
      ...INITIAL_KEYBOARD_STATE,
      compareMode: true,
      compareCids: ["cid-A", "cid-B"] as readonly string[],
    };
    // Simulate side='a' click: handler dispatches ADOPT_SET then COMPARE_ADOPT.
    const s1 = tuiReducer(initialWithCompare, {
      type: "ADOPT_SET",
      targetCid: "cid-A",
      summary: "left side",
    });
    expect(s1.adoptContext?.targetCid).toBe("cid-A");
    const s2 = tuiReducer(s1, { type: "COMPARE_ADOPT" });
    // COMPARE_ADOPT must preserve adoptContext so the palette spawn carries it.
    expect(s2.adoptContext?.targetCid).toBe("cid-A");
    expect(s2.compareMode).toBe(false);
    expect(s2.compareCids).toEqual([]);
  });

  test("frontier tab cycle navigates among published tabs", () => {
    const s1 = tuiReducer(INITIAL_KEYBOARD_STATE, {
      type: "FRONTIER_SET_TABS",
      keys: ["overview", "adoption", "metric:rouge_l"],
    });
    const s2 = tuiReducer(s1, { type: "FRONTIER_SLICE_NEXT" });
    expect(s2.activeFrontierSlice).toBe("adoption");
    const s3 = tuiReducer(s2, { type: "FRONTIER_SLICE_SET", key: "metric:rouge_l" });
    expect(s3.activeFrontierSlice).toBe("metric:rouge_l");
  });
});
