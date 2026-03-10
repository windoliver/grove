/**
 * Tests for CLI format utilities.
 */

import { describe, expect, test } from "bun:test";

import type { Score } from "../core/models.js";
import { makeContribution } from "../core/test-helpers.js";
import {
  contributionToRow,
  formatContributions,
  formatScore,
  formatTable,
  formatTimestamp,
  truncateCid,
} from "./format.js";

// ---------------------------------------------------------------------------
// truncateCid
// ---------------------------------------------------------------------------

describe("truncateCid", () => {
  test("truncates a blake3 CID", () => {
    const cid = "blake3:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    expect(truncateCid(cid)).toBe("blake3:abcdef123456..");
  });

  test("respects custom length", () => {
    const cid = "blake3:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    expect(truncateCid(cid, 6)).toBe("blake3:abcdef..");
  });

  test("handles non-blake3 CID", () => {
    const cid = "sha256:abcdef";
    expect(truncateCid(cid, 12)).toBe("sha256:abcde");
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe("formatTimestamp", () => {
  test("formats recent timestamps as relative", () => {
    const now = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    expect(formatTimestamp(now)).toMatch(/^\d+s ago$/);
  });

  test("formats minutes ago", () => {
    const ts = new Date(Date.now() - 300_000).toISOString(); // 5m ago
    expect(formatTimestamp(ts)).toMatch(/^\d+m ago$/);
  });

  test("formats hours ago", () => {
    const ts = new Date(Date.now() - 7_200_000).toISOString(); // 2h ago
    expect(formatTimestamp(ts)).toMatch(/^\d+h ago$/);
  });

  test("formats days ago", () => {
    const ts = new Date(Date.now() - 172_800_000).toISOString(); // 2d ago
    expect(formatTimestamp(ts)).toMatch(/^\d+d ago$/);
  });

  test("formats old dates as ISO date", () => {
    expect(formatTimestamp("2024-01-15T12:00:00Z")).toBe("2024-01-15");
  });
});

// ---------------------------------------------------------------------------
// formatScore
// ---------------------------------------------------------------------------

describe("formatScore", () => {
  test("formats integer score", () => {
    const score: Score = { value: 42, direction: "maximize" };
    expect(formatScore(score)).toBe("42");
  });

  test("formats decimal score with 4 digits", () => {
    const score: Score = { value: 0.95123, direction: "minimize" };
    expect(formatScore(score)).toBe("0.9512");
  });

  test("includes unit when present", () => {
    const score: Score = { value: 3.5, direction: "maximize", unit: "ms" };
    expect(formatScore(score)).toBe("3.5000 ms");
  });
});

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

describe("formatTable", () => {
  test("returns no-results for empty rows", () => {
    const cols = [{ header: "A", key: "a" }];
    expect(formatTable(cols, [])).toBe("(no results)");
  });

  test("formats a basic table", () => {
    const cols = [
      { header: "NAME", key: "name" },
      { header: "VALUE", key: "value", align: "right" as const },
    ];
    const rows = [
      { name: "alpha", value: "10" },
      { name: "beta", value: "200" },
    ];

    const output = formatTable(cols, rows);
    const lines = output.split("\n");

    expect(lines.length).toBe(4); // header + separator + 2 rows
    expect(lines[0]).toContain("NAME");
    expect(lines[0]).toContain("VALUE");
    expect(lines[1]).toMatch(/^-+/); // separator
    expect(lines[2]).toContain("alpha");
    expect(lines[3]).toContain("beta");
  });

  test("respects maxWidth by truncating", () => {
    const cols = [{ header: "X", key: "x", maxWidth: 8 }];
    const rows = [{ x: "a very long string that should be truncated" }];

    const output = formatTable(cols, rows);
    expect(output).toContain("a very..");
  });

  test("right-aligns when specified", () => {
    const cols = [{ header: "NUM", key: "n", align: "right" as const }];
    const rows = [{ n: "42" }];

    const output = formatTable(cols, rows);
    const dataLine = output.split("\n")[2];
    expect(dataLine).toBeDefined();
    // Right-aligned: value should be at the end
    expect(dataLine?.trimEnd()).toMatch(/42$/);
  });
});

// ---------------------------------------------------------------------------
// contributionToRow / formatContributions
// ---------------------------------------------------------------------------

describe("formatContributions", () => {
  test("formats contributions as a table", () => {
    const c1 = makeContribution({
      summary: "Initial work",
      agent: { agentId: "agent-1", agentName: "Alice" },
    });
    const c2 = makeContribution({
      summary: "Follow-up",
      agent: { agentId: "agent-2" },
      createdAt: "2026-01-02T00:00:00Z",
    });

    const output = formatContributions([c1, c2]);
    expect(output).toContain("CID");
    expect(output).toContain("KIND");
    expect(output).toContain("Initial work");
    expect(output).toContain("Follow-up");
    expect(output).toContain("Alice");
    expect(output).toContain("agent-2"); // fallback to agentId
  });

  test("returns no results for empty list", () => {
    expect(formatContributions([])).toBe("(no results)");
  });
});

describe("contributionToRow", () => {
  test("prefers agentName over agentId", () => {
    const c = makeContribution({ agent: { agentId: "id-1", agentName: "Bob" } });
    const row = contributionToRow(c);
    expect(row.agent).toBe("Bob");
  });

  test("falls back to agentId when no agentName", () => {
    const c = makeContribution({ agent: { agentId: "id-1" } });
    const row = contributionToRow(c);
    expect(row.agent).toBe("id-1");
  });
});
