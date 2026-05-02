/**
 * Tests for shared formatting utilities.
 */

import { describe, expect, test } from "bun:test";
import type { Score } from "../core/models.js";
import {
  compareTimestamps,
  compareTimestampsAscNewestLast,
  compareTimestampsDesc,
  contributionToRow,
  formatScore,
  formatTimestamp,
  frontierEntryToRow,
  stripAnsi,
  truncateCid,
} from "./format.js";

describe("stripAnsi", () => {
  test("strips private-mode CSI sequences", () => {
    expect(stripAnsi("\x1b[?25lhidden\x1b[?25h")).toBe("hidden");
  });

  test("strips OSC sequences terminated by ST", () => {
    expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });
});

describe("truncateCid", () => {
  test("truncates blake3 CID", () => {
    const cid = "blake3:abcdef123456789012345678";
    expect(truncateCid(cid)).toBe("blake3:abcdef123456..");
  });

  test("truncates non-blake3 CID", () => {
    expect(truncateCid("sha256:abcdef1234567890")).toBe("sha256:abcde");
  });

  test("custom length", () => {
    const cid = "blake3:abcdef123456789012345678";
    expect(truncateCid(cid, 6)).toBe("blake3:abcdef..");
  });
});

describe("formatTimestamp", () => {
  test("formats seconds ago", () => {
    const now = new Date(Date.now() - 30_000).toISOString();
    expect(formatTimestamp(now)).toBe("30s ago");
  });

  test("formats minutes ago", () => {
    const now = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatTimestamp(now)).toBe("5m ago");
  });

  test("formats hours ago", () => {
    const now = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatTimestamp(now)).toBe("3h ago");
  });

  test("formats days ago", () => {
    const now = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(formatTimestamp(now)).toBe("10d ago");
  });

  test("formats future timestamp as absolute", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(formatTimestamp(future)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("compareTimestamps", () => {
  test("returns negative when a is older", () => {
    expect(compareTimestamps("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")).toBeLessThan(0);
  });

  test("returns positive when a is newer", () => {
    expect(compareTimestamps("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")).toBeGreaterThan(0);
  });

  test("returns 0 for equal timestamps", () => {
    expect(compareTimestamps("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(0);
  });

  test("handles timezone offsets chronologically", () => {
    // 2026-01-02T00:00:00+05:00 == 2026-01-01T19:00:00Z (older than 20:00Z)
    const offset = "2026-01-02T00:00:00+05:00";
    const utc = "2026-01-01T20:00:00Z";
    // Lexicographic compare would say `offset` > `utc`. Chronological says
    // `offset` is older.
    expect(compareTimestamps(offset, utc)).toBeLessThan(0);
    expect(compareTimestamps(utc, offset)).toBeGreaterThan(0);
    // Lexicographic sanity: regression check that the bug existed.
    expect(offset.localeCompare(utc)).toBeGreaterThan(0);
  });

  test("undefined sorts as last (NaN-safe)", () => {
    expect(compareTimestamps(undefined, "2026-01-01T00:00:00Z")).toBeGreaterThan(0);
    expect(compareTimestamps("2026-01-01T00:00:00Z", undefined)).toBeLessThan(0);
    expect(compareTimestamps(undefined, undefined)).toBe(0);
  });

  test("malformed strings sort last", () => {
    expect(compareTimestamps("not-a-date", "2026-01-01T00:00:00Z")).toBeGreaterThan(0);
  });
});

describe("compareTimestampsDesc", () => {
  test("returns positive when a is older (so b sorts first)", () => {
    expect(compareTimestampsDesc("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")).toBeGreaterThan(
      0,
    );
  });

  test("returns negative when a is newer (so a sorts first)", () => {
    expect(compareTimestampsDesc("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")).toBeLessThan(0);
  });

  test("invalid sorts LAST even in DESC (regression — naive reversal would put bad data first)", () => {
    // Codex round-8 finding: passing args reversed to compareTimestamps
    // would put NaN BEFORE valid timestamps, displacing real data from
    // a slice(0, N) cap. The dedicated DESC helper preserves invalid-last.
    const sorted = [
      { ts: "2026-01-01T00:00:00Z" },
      { ts: undefined },
      { ts: "2026-01-03T00:00:00Z" },
      { ts: "not-a-date" },
      { ts: "2026-01-02T00:00:00Z" },
    ].sort((a, b) => compareTimestampsDesc(a.ts, b.ts));
    // First three slots must be the three valid timestamps in DESC order;
    // invalids land at the tail.
    expect(sorted[0]?.ts).toBe("2026-01-03T00:00:00Z");
    expect(sorted[1]?.ts).toBe("2026-01-02T00:00:00Z");
    expect(sorted[2]?.ts).toBe("2026-01-01T00:00:00Z");
    // Last two are invalid (order between them is undefined, just assert
    // both are bad).
    const lastTwo = sorted.slice(3).map((x) => x.ts);
    expect(lastTwo.every((t) => t === undefined || t === "not-a-date")).toBe(true);
  });

  test("handles timezone offsets chronologically", () => {
    const offset = "2026-01-02T00:00:00+05:00";
    const utc = "2026-01-01T20:00:00Z";
    // offset is chronologically OLDER → DESC should put utc first.
    expect(compareTimestampsDesc(utc, offset)).toBeLessThan(0);
  });
});

describe("compareTimestampsAscNewestLast", () => {
  test("ascending order for valid timestamps", () => {
    const sorted = [
      { ts: "2026-01-03T00:00:00Z" },
      { ts: "2026-01-01T00:00:00Z" },
      { ts: "2026-01-02T00:00:00Z" },
    ].sort((a, b) => compareTimestampsAscNewestLast(a.ts, b.ts));
    expect(sorted.map((x) => x.ts)).toEqual([
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "2026-01-03T00:00:00Z",
    ]);
  });

  test("invalid sorts FIRST so tail is always the newest valid (regression for codex round-9)", () => {
    // The running feed's auto-follow targets `feed.length - 1` as
    // "newest". With invalid-last, a malformed-timestamp row would steal
    // the cursor's focus from the real newest contribution.
    const sorted = [
      { ts: "2026-01-02T00:00:00Z" },
      { ts: undefined },
      { ts: "2026-01-01T00:00:00Z" },
      { ts: "not-a-date" },
      { ts: "2026-01-03T00:00:00Z" },
    ].sort((a, b) => compareTimestampsAscNewestLast(a.ts, b.ts));
    // Tail must be the newest valid timestamp.
    expect(sorted[sorted.length - 1]?.ts).toBe("2026-01-03T00:00:00Z");
    // Tail-1 must be the second-newest valid.
    expect(sorted[sorted.length - 2]?.ts).toBe("2026-01-02T00:00:00Z");
    // Tail-3 must be the oldest valid.
    expect(sorted[sorted.length - 3]?.ts).toBe("2026-01-01T00:00:00Z");
  });

  test("handles timezone offsets chronologically", () => {
    const offset = "2026-01-02T00:00:00+05:00";
    const utc = "2026-01-01T20:00:00Z";
    // offset (=01T19:00Z) is older than utc (=01T20:00Z) → ASC puts offset first.
    expect(compareTimestampsAscNewestLast(offset, utc)).toBeLessThan(0);
  });
});

describe("formatScore", () => {
  test("formats integer score", () => {
    const score: Score = { value: 42, direction: "maximize" };
    expect(formatScore(score)).toBe("42");
  });

  test("formats decimal score", () => {
    const score: Score = { value: 0.9876, direction: "maximize" };
    expect(formatScore(score)).toBe("0.9876");
  });

  test("includes unit", () => {
    const score: Score = { value: 95, direction: "maximize", unit: "%" };
    expect(formatScore(score)).toBe("95 %");
  });
});

describe("contributionToRow", () => {
  test("converts contribution to display row", () => {
    const contribution = {
      cid: "blake3:abcdef123456789012345678",
      manifestVersion: 1,
      kind: "work" as const,
      mode: "evaluation" as const,
      summary: "Test contribution",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "agent-1", agentName: "Alice" },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };

    const row = contributionToRow(contribution);
    expect(row.cid).toBe("blake3:abcdef123456..");
    expect(row.kind).toBe("work");
    expect(row.summary).toBe("Test contribution");
    expect(row.agent).toBe("Alice");
    expect(row.created).toBe("1m ago");
  });

  test("uses agentId when agentName is absent", () => {
    const contribution = {
      cid: "blake3:xyz",
      manifestVersion: 1,
      kind: "review" as const,
      mode: "exploration" as const,
      summary: "Review",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "agent-2" },
      createdAt: new Date().toISOString(),
    };

    const row = contributionToRow(contribution);
    expect(row.agent).toBe("agent-2");
  });

  test("wide mode shows full CID", () => {
    const fullCid = "blake3:abcdef123456789012345678";
    const contribution = {
      cid: fullCid,
      manifestVersion: 1,
      kind: "work" as const,
      mode: "evaluation" as const,
      summary: "Test",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "a" },
      createdAt: new Date().toISOString(),
    };

    const row = contributionToRow(contribution, { wide: true });
    expect(row.cid).toBe(fullCid);
  });
});

describe("frontierEntryToRow", () => {
  const makeEntry = () => ({
    cid: "blake3:abcdef123456789012345678",
    summary: "Best result",
    value: 0.95,
    contribution: {
      cid: "blake3:abcdef123456789012345678",
      manifestVersion: 1,
      kind: "work" as const,
      mode: "evaluation" as const,
      summary: "Best result",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "agent-1", agentName: "Alice" },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    },
  });

  test("truncates CID by default", () => {
    const row = frontierEntryToRow(makeEntry());
    expect(row.cid).toBe("blake3:abcdef123456..");
    expect(row.summary).toBe("Best result");
    expect(row.value).toBe("0.95");
    expect(row.agent).toBe("Alice");
  });

  test("wide mode shows full CID", () => {
    const entry = makeEntry();
    const row = frontierEntryToRow(entry, { wide: true });
    expect(row.cid).toBe(entry.cid);
  });

  test("uses agentId when agentName is absent", () => {
    const entry = {
      ...makeEntry(),
      contribution: {
        ...makeEntry().contribution,
        agent: { agentId: "bot-1" } as { agentId: string; agentName?: string },
      },
    };
    const row = frontierEntryToRow(entry);
    expect(row.agent).toBe("bot-1");
  });
});
