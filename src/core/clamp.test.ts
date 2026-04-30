import { describe, expect, mock, test } from "bun:test";
import { clampInt } from "./clamp.js";

describe("clampInt", () => {
  test("returns parsed value when within range", () => {
    expect(clampInt({ raw: "5000", fallback: 100, min: 1, max: 10_000, name: "X" })).toBe(5000);
  });

  test("returns fallback when raw is undefined", () => {
    const warn = mock(() => {});
    expect(clampInt({ raw: undefined, fallback: 42, min: 1, max: 100, name: "X", warn })).toBe(42);
    expect(warn.mock.calls.length).toBe(0); // unset is normal, no warn
  });

  test("returns fallback when raw is empty string", () => {
    expect(clampInt({ raw: "", fallback: 7, min: 1, max: 100, name: "X" })).toBe(7);
  });

  test("warns and returns fallback when raw is unparseable", () => {
    const warn = mock(() => {});
    expect(clampInt({ raw: "abc", fallback: 9, min: 1, max: 100, name: "Y", warn })).toBe(9);
    expect(warn.mock.calls.length).toBe(1);
    expect(String((warn.mock.calls as unknown as unknown[][])[0]?.[0])).toContain("Y");
  });

  test("warns and returns fallback when raw is below min", () => {
    const warn = mock(() => {});
    expect(clampInt({ raw: "0", fallback: 10, min: 1, max: 100, name: "Z", warn })).toBe(10);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("warns and returns fallback when raw is above max", () => {
    const warn = mock(() => {});
    expect(clampInt({ raw: "999", fallback: 10, min: 1, max: 100, name: "Z", warn })).toBe(10);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("rejects fractional input", () => {
    const warn = mock(() => {});
    expect(clampInt({ raw: "1.5", fallback: 2, min: 1, max: 100, name: "F", warn })).toBe(2);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("accepts boundary values", () => {
    expect(clampInt({ raw: "1", fallback: 5, min: 1, max: 100, name: "B" })).toBe(1);
    expect(clampInt({ raw: "100", fallback: 5, min: 1, max: 100, name: "B" })).toBe(100);
  });
});
