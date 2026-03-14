/**
 * Tests for CLI error types.
 */

import { describe, expect, test } from "bun:test";
import { UsageError } from "./errors.js";

describe("UsageError", () => {
  test("has exitCode 2", () => {
    const err = new UsageError("bad flag");
    expect(err.exitCode).toBe(2);
  });

  test("is an instance of Error", () => {
    const err = new UsageError("bad flag");
    expect(err).toBeInstanceOf(Error);
  });

  test("has name UsageError", () => {
    const err = new UsageError("bad flag");
    expect(err.name).toBe("UsageError");
  });

  test("preserves message", () => {
    const err = new UsageError("--amount is required");
    expect(err.message).toBe("--amount is required");
  });
});
