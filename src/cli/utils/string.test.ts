/**
 * Tests for Levenshtein distance and command suggestion utilities.
 */

import { describe, expect, test } from "bun:test";
import { levenshteinDistance, suggestCommand } from "./string.js";

describe("levenshteinDistance", () => {
  test("identical strings have distance 0", () => {
    expect(levenshteinDistance("contribute", "contribute")).toBe(0);
  });

  test("single character difference", () => {
    expect(levenshteinDistance("contribute", "contribte")).toBe(1);
  });

  test("completely different strings have high distance", () => {
    expect(levenshteinDistance("abc", "xyz")).toBe(3);
  });

  test("empty string to non-empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  test("both empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  test("transposition counts as 2 edits", () => {
    expect(levenshteinDistance("ab", "ba")).toBe(2);
  });
});

describe("suggestCommand", () => {
  const commands = ["contribute", "frontier", "log", "tree", "search", "claim", "status"];

  test("suggests closest match for typo", () => {
    expect(suggestCommand("contribte", commands)).toBe("contribute");
  });

  test("suggests closest match for missing letters", () => {
    expect(suggestCommand("frntier", commands)).toBe("frontier");
  });

  test("returns undefined for unrelated input", () => {
    expect(suggestCommand("xyzxyzxyz", commands)).toBeUndefined();
  });

  test("returns exact match when distance is 0", () => {
    expect(suggestCommand("log", commands)).toBe("log");
  });

  test("respects maxDistance parameter", () => {
    expect(suggestCommand("contribte", commands, 1)).toBe("contribute");
    expect(suggestCommand("xyz", commands, 0)).toBeUndefined();
  });

  test("handles empty command list", () => {
    expect(suggestCommand("anything", [])).toBeUndefined();
  });
});
