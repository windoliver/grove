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
