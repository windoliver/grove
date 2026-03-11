/**
 * Tests for shared duration utilities.
 */

import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "./duration.js";

describe("parseDuration", () => {
  test("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  test("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });

  test("parses hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  test("parses days", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  test("parses milliseconds", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  test("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
  });

  test("throws on zero", () => {
    expect(() => parseDuration("0s")).toThrow("Duration must be positive");
  });
});

describe("formatDuration", () => {
  test("formats expired", () => {
    expect(formatDuration(0)).toBe("expired");
    expect(formatDuration(-100)).toBe("expired");
  });

  test("formats seconds", () => {
    expect(formatDuration(30_000)).toBe("30s");
  });

  test("formats minutes", () => {
    expect(formatDuration(300_000)).toBe("5m");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });

  test("formats days", () => {
    expect(formatDuration(172_800_000)).toBe("2d");
  });

  test("formats days and hours", () => {
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });

  test("formats sub-second", () => {
    expect(formatDuration(500)).toBe("<1s");
  });
});
