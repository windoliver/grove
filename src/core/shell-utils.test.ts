import { describe, expect, test } from "bun:test";
import { shellEscape } from "./shell-utils.js";

describe("shellEscape", () => {
  test("wraps simple string in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  test("escapes single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  test("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  test("handles string with spaces", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
  });

  test("handles string with special characters", () => {
    expect(shellEscape("$HOME && rm -rf /")).toBe("'$HOME && rm -rf /'");
  });

  test("handles multiple single quotes", () => {
    expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });
});
