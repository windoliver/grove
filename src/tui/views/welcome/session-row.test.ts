import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../provider.js";
import { computeSessionRowFields } from "./session-row.js";

const NOW = new Date("2026-04-19T12:00:00Z").getTime();

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    goal: "refactor welcome",
    status: "active",
    createdAt: new Date(NOW - 3 * 60_000).toISOString(), // 3m ago
    contributionCount: 42,
    topology: undefined,
    ...over,
  } as SessionRecord;
}

describe("computeSessionRowFields", () => {
  test("focused active session renders rich two-line output", () => {
    const r = computeSessionRowFields(session({ presetName: "reviewer-pair" }), {
      focused: true,
      now: NOW,
    });
    expect(r.dot).toBe("●");
    expect(r.primary).toContain("refactor welcome");
    expect(r.primary).toContain("3m");
    expect(r.primary).toContain("42c");
    expect(r.secondary).toContain("reviewer-pair");
    expect(r.rich).toBe(true);
  });

  test("unfocused completed session renders compact one-line", () => {
    const r = computeSessionRowFields(session({ status: "completed", contributionCount: 12 }), {
      focused: false,
      now: NOW,
    });
    expect(r.dot).toBe("○");
    expect(r.primary).toContain("12c");
    expect(r.secondary).toBeUndefined();
    expect(r.rich).toBe(false);
  });

  test("missing goal falls back to 'untitled'", () => {
    const r = computeSessionRowFields(session({ goal: undefined }), {
      focused: false,
      now: NOW,
    });
    expect(r.primary).toContain("untitled");
  });

  test("long goal is truncated to 50 chars", () => {
    const goal = "x".repeat(80);
    const r = computeSessionRowFields(session({ goal }), {
      focused: false,
      now: NOW,
    });
    expect(r.primary.length).toBeLessThanOrEqual(100); // includes metadata
    expect(r.primary).toContain("x".repeat(50));
    expect(r.primary).not.toContain("x".repeat(51));
  });

  test("archived session uses hollow dot like completed", () => {
    const r = computeSessionRowFields(session({ status: "archived" }), {
      focused: false,
      now: NOW,
    });
    expect(r.dot).toBe("○");
  });

  test("completed session includes semantic stop status when present", () => {
    const r = computeSessionRowFields(
      session({ status: "completed", stopStatus: "plateau", stopReason: "No improvement" }),
      {
        focused: false,
        now: NOW,
      },
    );

    expect(r.primary).toContain("plateau");
  });
});
