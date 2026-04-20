import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "./relative-time.js";

const NOW = new Date("2026-04-19T12:00:00Z").getTime();

function iso(msOffset: number): string {
  return new Date(NOW - msOffset).toISOString();
}

describe("formatRelativeTime", () => {
  test("< 60 s → 'just now'", () => {
    expect(formatRelativeTime(iso(0), NOW)).toBe("just now");
    expect(formatRelativeTime(iso(30_000), NOW)).toBe("just now");
  });

  test("< 60 m → 'Nm'", () => {
    expect(formatRelativeTime(iso(60_000), NOW)).toBe("1m");
    expect(formatRelativeTime(iso(59 * 60_000), NOW)).toBe("59m");
  });

  test("< 24 h → 'Nh'", () => {
    expect(formatRelativeTime(iso(60 * 60_000), NOW)).toBe("1h");
    expect(formatRelativeTime(iso(23 * 60 * 60_000), NOW)).toBe("23h");
  });

  test("exactly 24 h → 'yesterday'", () => {
    expect(formatRelativeTime(iso(24 * 60 * 60_000), NOW)).toBe("yesterday");
  });

  test("< 7 d → 'Nd ago'", () => {
    expect(formatRelativeTime(iso(2 * 24 * 60 * 60_000), NOW)).toBe("2d ago");
    expect(formatRelativeTime(iso(6 * 24 * 60 * 60_000), NOW)).toBe("6d ago");
  });

  test("≥ 7 d → absolute short date", () => {
    // 10 days ago = 2026-04-09
    expect(formatRelativeTime(iso(10 * 24 * 60 * 60_000), NOW)).toMatch(
      /Apr\s+9/,
    );
  });

  test("invalid input returns empty string", () => {
    expect(formatRelativeTime(undefined, NOW)).toBe("");
    expect(formatRelativeTime("not-a-date", NOW)).toBe("");
  });
});
