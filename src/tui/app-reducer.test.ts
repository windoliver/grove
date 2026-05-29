import { describe, expect, test } from "bun:test";
import { INITIAL_KEYBOARD_STATE, tuiReducer } from "./app-reducer.js";

describe("artifact diff mode (#192)", () => {
  test("defaults to inline", () => {
    expect(INITIAL_KEYBOARD_STATE.artifactDiffMode).toBe("inline");
  });
  test("ARTIFACT_DIFF_MODE_TOGGLE flips inline <-> split", () => {
    const once = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "ARTIFACT_DIFF_MODE_TOGGLE" });
    expect(once.artifactDiffMode).toBe("split");
    const twice = tuiReducer(once, { type: "ARTIFACT_DIFF_MODE_TOGGLE" });
    expect(twice.artifactDiffMode).toBe("inline");
  });
});

describe("detail section focus (#192)", () => {
  test("defaults to 0", () => {
    expect(INITIAL_KEYBOARD_STATE.detailFocusedSection).toBe(0);
  });
  test("NEXT increments, PREV decrements (may go negative; view applies modulo)", () => {
    const a = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "DETAIL_SECTION_NEXT" });
    expect(a.detailFocusedSection).toBe(1);
    const b = tuiReducer(a, { type: "DETAIL_SECTION_PREV" });
    expect(b.detailFocusedSection).toBe(0);
    const c = tuiReducer(b, { type: "DETAIL_SECTION_PREV" });
    expect(c.detailFocusedSection).toBe(-1);
  });
  test("RESET returns to 0", () => {
    const a = tuiReducer(INITIAL_KEYBOARD_STATE, { type: "DETAIL_SECTION_NEXT" });
    expect(tuiReducer(a, { type: "DETAIL_SECTION_RESET" }).detailFocusedSection).toBe(0);
  });
});
