/**
 * Tests for validation error collection utility.
 */

import { describe, expect, test } from "bun:test";
import { collectErrors, formatValidationErrors, type ValidationError } from "./validate.js";

describe("collectErrors", () => {
  test("returns empty array when no checks fail", () => {
    const errors = collectErrors([
      [false, { field: "title", message: "title is required" }],
      [false, { field: "--amount", message: "--amount is required" }],
    ]);
    expect(errors).toEqual([]);
  });

  test("collects single failing check", () => {
    const errors = collectErrors([
      [true, { field: "title", message: "title is required" }],
      [false, { field: "--amount", message: "--amount is required" }],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("title");
  });

  test("collects multiple failing checks", () => {
    const errors = collectErrors([
      [true, { field: "title", message: "title is required" }],
      [true, { field: "--amount", message: "--amount is required" }],
      [true, { field: "--deadline", message: "--deadline is required" }],
    ]);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.field)).toEqual(["title", "--amount", "--deadline"]);
  });

  test("handles empty checks array", () => {
    const errors = collectErrors([]);
    expect(errors).toEqual([]);
  });
});

describe("formatValidationErrors", () => {
  test("returns null for zero errors", () => {
    expect(formatValidationErrors([])).toBeNull();
  });

  test("formats single error without bullet", () => {
    const errors: ValidationError[] = [{ field: "--amount", message: "--amount is required" }];
    const result = formatValidationErrors(errors);
    expect(result).toBe("Error: --amount is required");
  });

  test("formats single error with hint", () => {
    const errors: ValidationError[] = [{ field: "--amount", message: "--amount is required" }];
    const result = formatValidationErrors(errors, "Usage: grove bounty create ...");
    expect(result).toContain("Error: --amount is required");
    expect(result).toContain("Usage: grove bounty create ...");
  });

  test("formats multiple errors with count header and bullets", () => {
    const errors: ValidationError[] = [
      { field: "--amount", message: "--amount is required" },
      { field: "--deadline", message: "--deadline is required" },
    ];
    const result = formatValidationErrors(errors)!;
    expect(result).toContain("2 validation errors:");
    expect(result).toContain("\u2022 --amount is required");
    expect(result).toContain("\u2022 --deadline is required");
  });

  test("formats multiple errors with hint", () => {
    const errors: ValidationError[] = [
      { field: "title", message: "title is required" },
      { field: "--amount", message: "--amount is required" },
      { field: "--deadline", message: "--deadline is required" },
    ];
    const result = formatValidationErrors(errors, "Run --help for usage")!;
    expect(result).toContain("3 validation errors:");
    expect(result).toContain("Run --help for usage");
  });
});
