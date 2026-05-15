import { describe, expect, test } from "bun:test";
import { type CasMutationResult, isMismatch, isOk } from "./cas.js";

describe("CasMutationResult", () => {
  test("isOk narrows to ok variant", () => {
    const r: CasMutationResult<{ x: number }> = { kind: "ok", view: { x: 1 } };
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.view.x).toBe(1);
  });

  test("isMismatch narrows to rv-mismatch variant", () => {
    const r: CasMutationResult<{ x: number }> = {
      kind: "rv-mismatch",
      current: { resourceVersion: "7", generation: 3 },
    };
    expect(isMismatch(r)).toBe(true);
    if (isMismatch(r)) expect(r.current.resourceVersion).toBe("7");
  });

  test("isOk returns false for mismatch", () => {
    const r: CasMutationResult<{ x: number }> = {
      kind: "rv-mismatch",
      current: { resourceVersion: "1", generation: 1 },
    };
    expect(isOk(r)).toBe(false);
  });

  test("isMismatch returns false for ok", () => {
    const r: CasMutationResult<{ x: number }> = { kind: "ok", view: { x: 42 } };
    expect(isMismatch(r)).toBe(false);
  });
});
