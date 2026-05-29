import { describe, expect, test } from "bun:test";
import { resolveBuiltinKeymap } from "./keymap.js";
import { candidateContinuations } from "./leader-chord.js";

describe("candidateContinuations", () => {
  test("lists next-key options for a pending leader prefix", () => {
    const km = resolveBuiltinKeymap("default");
    const cands = candidateContinuations(km.bindings, ["space"]);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => typeof c.key === "string" && typeof c.label === "string")).toBe(true);
  });
  test("returns [] for a prefix with no children", () => {
    const km = resolveBuiltinKeymap("default");
    expect(candidateContinuations(km.bindings, ["nonexistent-token"])).toEqual([]);
  });
});
