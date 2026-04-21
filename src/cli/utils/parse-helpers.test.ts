import { describe, expect, test } from "bun:test";
import { UsageError } from "../errors.js";
import { parseLimit, parseOffset, requirePositional } from "./parse-helpers.js";

describe("parseLimit", () => {
  test("returns default when omitted", () => {
    expect(parseLimit(undefined, 25)).toBe(25);
  });

  test("parses a valid positive integer", () => {
    expect(parseLimit("42", 10)).toBe(42);
  });

  test("rejects non-integer text", () => {
    expect(() => parseLimit("abc", 10)).toThrow(UsageError);
  });

  test("rejects partially numeric text", () => {
    expect(() => parseLimit("10abc", 10)).toThrow(UsageError);
  });

  test("rejects scientific notation", () => {
    expect(() => parseLimit("1e3", 10)).toThrow(UsageError);
  });

  test("rejects zero", () => {
    expect(() => parseLimit("0", 10)).toThrow(UsageError);
  });
});

describe("parseOffset", () => {
  test("defaults to zero when omitted", () => {
    expect(parseOffset(undefined)).toBe(0);
  });

  test("parses a valid non-negative integer", () => {
    expect(parseOffset("12")).toBe(12);
  });

  test("rejects negative values", () => {
    expect(() => parseOffset("-1")).toThrow(UsageError);
  });

  test("rejects partially numeric text", () => {
    expect(() => parseOffset("7days")).toThrow(UsageError);
  });

  test("rejects scientific notation", () => {
    expect(() => parseOffset("2e2")).toThrow(UsageError);
  });
});

describe("requirePositional", () => {
  test("returns positional value when present", () => {
    expect(requirePositional(["cid-123"], 0, "cid")).toBe("cid-123");
  });

  test("throws when positional value is missing", () => {
    expect(() => requirePositional([], 0, "cid")).toThrow(UsageError);
  });
});
