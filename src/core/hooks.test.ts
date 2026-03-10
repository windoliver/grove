/**
 * Tests for hook configuration schema and helpers.
 */

import { describe, expect, test } from "bun:test";

import { HooksConfigSchema, hookCommand, hookTimeout } from "./hooks.js";

describe("HooksConfigSchema", () => {
  test("accepts empty config", () => {
    const result = HooksConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts string hooks", () => {
    const result = HooksConfigSchema.safeParse({
      after_checkout: "pip install -r requirements.txt",
      before_contribute: "pytest tests/",
      after_contribute: "rm -rf __pycache__",
    });
    expect(result.success).toBe(true);
  });

  test("accepts object hooks with timeout", () => {
    const result = HooksConfigSchema.safeParse({
      before_contribute: { cmd: "pytest tests/ --tb=short", timeout: 600 },
    });
    expect(result.success).toBe(true);
  });

  test("accepts mixed string and object hooks", () => {
    const result = HooksConfigSchema.safeParse({
      after_checkout: "npm install",
      before_contribute: { cmd: "npm test", timeout: 120 },
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty string hook", () => {
    const result = HooksConfigSchema.safeParse({
      after_checkout: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects object hook with empty cmd", () => {
    const result = HooksConfigSchema.safeParse({
      before_contribute: { cmd: "" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown hook names (strict mode)", () => {
    const result = HooksConfigSchema.safeParse({
      unknown_hook: "echo hi",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string, non-object hook value", () => {
    const result = HooksConfigSchema.safeParse({
      after_checkout: 42,
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative timeout", () => {
    const result = HooksConfigSchema.safeParse({
      before_contribute: { cmd: "test", timeout: -1 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects zero timeout", () => {
    const result = HooksConfigSchema.safeParse({
      before_contribute: { cmd: "test", timeout: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects fractional timeout", () => {
    const result = HooksConfigSchema.safeParse({
      before_contribute: { cmd: "test", timeout: 1.5 },
    });
    expect(result.success).toBe(false);
  });
});

describe("hookCommand", () => {
  test("extracts command from string entry", () => {
    expect(hookCommand("echo hello")).toBe("echo hello");
  });

  test("extracts command from object entry", () => {
    expect(hookCommand({ cmd: "pytest", timeout: 60 })).toBe("pytest");
  });
});

describe("hookTimeout", () => {
  test("returns default for string entry", () => {
    expect(hookTimeout("echo hello", 300)).toBe(300);
  });

  test("returns per-hook timeout from object entry", () => {
    expect(hookTimeout({ cmd: "test", timeout: 60 }, 300)).toBe(60);
  });

  test("returns default when object has no timeout", () => {
    expect(hookTimeout({ cmd: "test" }, 300)).toBe(300);
  });
});
