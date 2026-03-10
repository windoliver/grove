import { describe, expect, test } from "bun:test";

import { formatDuration, parseDuration } from "./duration.js";

describe("parseDuration", () => {
  test("parses milliseconds", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  test("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  test("parses minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
  });

  test("parses hours", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  test("parses days", () => {
    expect(parseDuration("2d")).toBe(172_800_000);
  });

  test("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow(/Invalid duration/);
  });

  test("throws on missing unit", () => {
    expect(() => parseDuration("30")).toThrow(/Invalid duration/);
  });

  test("throws on unknown unit", () => {
    expect(() => parseDuration("30w")).toThrow(/Invalid duration/);
  });

  test("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow(/Invalid duration/);
  });

  test("throws on negative duration", () => {
    expect(() => parseDuration("-5m")).toThrow(/Invalid duration/);
  });

  test("throws on zero duration", () => {
    expect(() => parseDuration("0m")).toThrow(/Duration must be positive/);
  });

  test("handles large values", () => {
    expect(parseDuration("365d")).toBe(365 * 86_400_000);
  });
});

describe("formatDuration", () => {
  test("formats expired (zero or negative)", () => {
    expect(formatDuration(0)).toBe("expired");
    expect(formatDuration(-1000)).toBe("expired");
  });

  test("formats sub-second", () => {
    expect(formatDuration(500)).toBe("<1s");
  });

  test("formats seconds", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  test("formats minutes", () => {
    expect(formatDuration(1_800_000)).toBe("30m");
  });

  test("formats hours with minutes", () => {
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });

  test("formats exact hours", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  test("formats days with hours", () => {
    expect(formatDuration(93_600_000)).toBe("1d 2h");
  });

  test("formats exact days", () => {
    expect(formatDuration(86_400_000)).toBe("1d");
  });
});
