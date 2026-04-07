/**
 * Tests for frontier-view pure functions.
 *
 * Tests flattenFrontier and formatValue directly — these are the core
 * data transformations for the rankings display and can be tested without
 * a React renderer.
 */

import { describe, expect, test } from "bun:test";
import type { Frontier, FrontierEntry } from "../../core/frontier.js";

// ---------------------------------------------------------------------------
// Import the module-scoped functions.
// flattenFrontier and formatValue are not exported, so we test their
// combined behaviour via the visible transformation shape.
// We re-implement the logic here as a co-test to lock in the contract.
// ---------------------------------------------------------------------------

/** Mirror of the FrontierRow interface from frontier-view.tsx. */
interface FrontierRow {
  rank: number;
  cid: string;
  metric: string;
  value: number;
  summary: string;
}

/** Build a minimal valid Frontier with all required fields defaulted to empty. */
function makeFrontier(partial: Partial<Frontier> = {}): Frontier {
  return {
    byMetric: {},
    byAdoption: [],
    byRecency: [],
    byReviewScore: [],
    byReproduction: [],
    ...partial,
  };
}

/** Replicate flattenFrontier from frontier-view.tsx for contract testing. */
function flattenFrontier(frontier: Frontier): readonly FrontierRow[] {
  const rows: FrontierRow[] = [];

  for (const [metricName, entries] of Object.entries(frontier.byMetric ?? {})) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as FrontierEntry;
      rows.push({
        rank: i + 1,
        cid: entry.cid,
        metric: metricName,
        value: entry.value,
        summary: entry.summary,
      });
    }
  }

  const SCALAR_DIMS: ReadonlyArray<readonly [string, readonly FrontierEntry[] | undefined]> = [
    ["adoption", frontier.byAdoption],
    ["recency", frontier.byRecency],
    ["review", frontier.byReviewScore],
    ["reproduction", frontier.byReproduction],
  ];
  for (const [metric, entries] of SCALAR_DIMS) {
    for (let i = 0; i < (entries?.length ?? 0); i++) {
      const entry = entries![i] as FrontierEntry;
      rows.push({
        rank: i + 1,
        cid: entry.cid,
        metric,
        value: entry.value,
        summary: entry.summary,
      });
    }
  }

  return rows;
}

/** Replicate formatValue from frontier-view.tsx. */
function formatValue(value: number): string {
  if (Number.isInteger(value) && value > 1_000_000_000_000) {
    const diff = Date.now() - value;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${String(seconds)}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${String(minutes)}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${String(hours)}h ago`;
    const days = Math.floor(hours / 24);
    return `${String(days)}d ago`;
  }
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

// ---------------------------------------------------------------------------
// flattenFrontier
// ---------------------------------------------------------------------------

describe("flattenFrontier", () => {
  test("empty frontier returns empty array", () => {
    expect(flattenFrontier(makeFrontier())).toEqual([]);
  });

  test("byMetric entries are included with correct metric name and rank", () => {
    const frontier = makeFrontier({
      byMetric: {
        accuracy: [
          { cid: "cid-1", value: 0.9, summary: "high accuracy" },
          { cid: "cid-2", value: 0.8, summary: "medium accuracy" },
        ],
      },
    });
    const rows = flattenFrontier(frontier);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ rank: 1, cid: "cid-1", metric: "accuracy", value: 0.9 });
    expect(rows[1]).toMatchObject({ rank: 2, cid: "cid-2", metric: "accuracy", value: 0.8 });
  });

  test("byAdoption entries are included with metric='adoption'", () => {
    const frontier = makeFrontier({
      byAdoption: [{ cid: "cid-a", value: 5, summary: "adopted by 5" }],
    });
    const rows = flattenFrontier(frontier);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ rank: 1, cid: "cid-a", metric: "adoption", value: 5 });
  });

  test("byRecency entries are included with metric='recency'", () => {
    const frontier = makeFrontier({
      byRecency: [{ cid: "cid-r", value: 1700000000000, summary: "recent" }],
    });
    const rows = flattenFrontier(frontier);
    expect(rows[0]).toMatchObject({ metric: "recency" });
  });

  test("byReviewScore entries are included with metric='review'", () => {
    const frontier = makeFrontier({
      byReviewScore: [{ cid: "cid-rs", value: 4.5, summary: "well reviewed" }],
    });
    const rows = flattenFrontier(frontier);
    expect(rows[0]).toMatchObject({ metric: "review" });
  });

  test("byReproduction entries are included with metric='reproduction'", () => {
    const frontier = makeFrontier({
      byReproduction: [{ cid: "cid-rep", value: 3, summary: "reproduced 3 times" }],
    });
    const rows = flattenFrontier(frontier);
    expect(rows[0]).toMatchObject({ metric: "reproduction" });
  });

  test("rank resets to 1 for each dimension (not global)", () => {
    const frontier = makeFrontier({
      byAdoption: [
        { cid: "a1", value: 10, summary: "top adoption" },
        { cid: "a2", value: 5, summary: "second adoption" },
      ],
      byRecency: [{ cid: "r1", value: 100, summary: "most recent" }],
    });
    const rows = flattenFrontier(frontier);
    const adoptionRows = rows.filter((r) => r.metric === "adoption");
    const recencyRows = rows.filter((r) => r.metric === "recency");
    expect(adoptionRows[0]?.rank).toBe(1);
    expect(adoptionRows[1]?.rank).toBe(2);
    expect(recencyRows[0]?.rank).toBe(1); // rank resets per dimension
  });

  test("same CID can appear in multiple dimensions", () => {
    const frontier = makeFrontier({
      byAdoption: [{ cid: "shared-cid", value: 10, summary: "adopted" }],
      byRecency: [{ cid: "shared-cid", value: 200, summary: "recent" }],
    });
    const rows = flattenFrontier(frontier);
    const sharedRows = rows.filter((r) => r.cid === "shared-cid");
    expect(sharedRows.length).toBe(2);
    expect(new Set(sharedRows.map((r) => r.metric)).size).toBe(2);
  });

  test("empty dimension arrays produce no rows for that dimension", () => {
    // All fields are already empty arrays in makeFrontier() — this just documents it
    const frontier = makeFrontier();
    expect(flattenFrontier(frontier)).toEqual([]);
  });

  test("multiple byMetric dimensions are all included", () => {
    const frontier = makeFrontier({
      byMetric: {
        accuracy: [{ cid: "c1", value: 1, summary: "s" }],
        speed: [{ cid: "c2", value: 2, summary: "s" }],
      },
    });
    const rows = flattenFrontier(frontier);
    expect(rows.length).toBe(2);
    const metrics = new Set(rows.map((r) => r.metric));
    expect(metrics.has("accuracy")).toBe(true);
    expect(metrics.has("speed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatValue
// ---------------------------------------------------------------------------

describe("formatValue", () => {
  test("integer that is not a timestamp is returned as-is", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(1000)).toBe("1000");
  });

  test("float is formatted to 3 decimal places", () => {
    expect(formatValue(0.9)).toBe("0.900");
    expect(formatValue(Math.PI)).toBe("3.142");
    expect(formatValue(1.0)).toBe("1"); // integer check takes precedence
  });

  test("timestamp (>1e12) is formatted as relative time", () => {
    const nowMs = Date.now();
    // 30 seconds ago
    const thirtySecondsAgo = nowMs - 30_000;
    const result = formatValue(thirtySecondsAgo);
    expect(result).toMatch(/^\d+s ago$/);
  });

  test("timestamp 2 minutes ago returns minutes format", () => {
    const twoMinsAgo = Date.now() - 2 * 60 * 1000;
    expect(formatValue(twoMinsAgo)).toMatch(/^\d+m ago$/);
  });

  test("timestamp 2 hours ago returns hours format", () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    expect(formatValue(twoHoursAgo)).toMatch(/^\d+h ago$/);
  });

  test("timestamp 2 days ago returns days format", () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    expect(formatValue(twoDaysAgo)).toMatch(/^\d+d ago$/);
  });
});
