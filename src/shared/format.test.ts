/**
 * Tests for shared formatting utilities.
 */

import { describe, expect, test } from "bun:test";
import type { Score } from "../core/models.js";
import { contributionToRow, formatScore, formatTimestamp, truncateCid } from "./format.js";

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
});
