/**
 * Deep structural assertions for the code exploration scenario.
 *
 * Validates: exploration mode frontier (no metrics), search, thread
 * traversal, reply counts, and mode filtering.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deriveLifecycleState, LifecycleState } from "../../src/core/lifecycle.js";
import { verifyCid } from "../../src/core/manifest.js";
import { ContributionKind, ContributionMode } from "../../src/core/models.js";
import {
  cleanupGrove,
  type GroveContext,
  resetTimestamps,
  runScenario,
  type ScenarioResult,
  setupGrove,
} from "./scenario.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let ctx: GroveContext;
let result: ScenarioResult;

beforeAll(async () => {
  resetTimestamps();
  ctx = setupGrove();
  result = await runScenario(ctx);
});

afterAll(() => {
  cleanupGrove(ctx);
});

// ---------------------------------------------------------------------------
// 1. Exploration mode basics
// ---------------------------------------------------------------------------

describe("exploration mode basics", () => {
  test("all contributions are in exploration mode", () => {
    for (const c of result.allContributions) {
      expect(c.mode).toBe(ContributionMode.Exploration);
    }
  });

  test("CIDs are valid and verified", () => {
    for (const c of result.allContributions) {
      expect(c.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
      expect(verifyCid(c)).toBe(true);
    }
  });

  test("contributions are frozen", () => {
    for (const c of result.allContributions) {
      expect(Object.isFrozen(c)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No-metric frontier
// ---------------------------------------------------------------------------

describe("no-metric frontier", () => {
  test("byMetric has no training metrics for exploration contributions", async () => {
    const frontier = await ctx.frontier.compute({ mode: ContributionMode.Exploration });
    const metricKeys = Object.keys(frontier.byMetric);
    // No training metrics should appear — only exploration contributions here
    expect(metricKeys).not.toContain("val_bpb");
    expect(metricKeys).not.toContain("peak_vram_gb");
    // byMetric entries (if any) should only reference exploration-mode contributions
    for (const entries of Object.values(frontier.byMetric)) {
      for (const entry of entries) {
        expect(entry.contribution.mode).toBe(ContributionMode.Exploration);
      }
    }
  });

  test("byRecency orders newest first", async () => {
    const frontier = await ctx.frontier.compute({ mode: ContributionMode.Exploration });
    const recency = frontier.byRecency;
    expect(recency.length).toBeGreaterThanOrEqual(1);

    // Verify descending chronological order
    for (let i = 1; i < recency.length; i++) {
      const prev = new Date(recency[i - 1].contribution.createdAt).getTime();
      const curr = new Date(recency[i].contribution.createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  test("byReviewScore captures review quality scores", async () => {
    const frontier = await ctx.frontier.compute({ mode: ContributionMode.Exploration });
    // findingA was reviewed with quality=9 — it must appear in byReviewScore
    const reviewScored = frontier.byReviewScore;
    expect(reviewScored.length).toBeGreaterThanOrEqual(1);
    expect(reviewScored[0].cid).toBe(result.findingA.cid);
    expect(reviewScored[0].value).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 3. Search
// ---------------------------------------------------------------------------

describe("search", () => {
  test("full-text search finds by summary keyword", async () => {
    const results = await ctx.contributionStore.search("connection pool");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((c) => c.cid === result.findingA.cid)).toBe(true);
  });

  test("search finds by description keyword", async () => {
    const results = await ctx.contributionStore.search("pgBouncer");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((c) => c.cid === result.reviewC.cid)).toBe(true);
  });

  test("search with kind filter narrows results", async () => {
    // "endpoint" appears in responseB's summary (N+1 query in user endpoint)
    const discussions = await ctx.contributionStore.search("endpoint", {
      kind: ContributionKind.Discussion,
    });
    expect(discussions.length).toBeGreaterThanOrEqual(1);
    for (const c of discussions) {
      expect(c.kind).toBe(ContributionKind.Discussion);
    }
    expect(discussions.some((c) => c.cid === result.responseB.cid)).toBe(true);
  });

  test("search with tag filter narrows results", async () => {
    // "query" appears in responseB's summary; responseB is tagged with n-plus-one
    const tagged = await ctx.contributionStore.search("query", {
      tags: ["n-plus-one"],
    });
    expect(tagged.length).toBeGreaterThanOrEqual(1);
    for (const c of tagged) {
      expect(c.tags).toContain("n-plus-one");
    }
    expect(tagged.some((c) => c.cid === result.responseB.cid)).toBe(true);
  });

  test("search returns empty for non-matching query", async () => {
    const results = await ctx.contributionStore.search("xyznonexistent");
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Thread traversal
// ---------------------------------------------------------------------------

describe("thread traversal", () => {
  test("thread from finding A contains all replies", async () => {
    const thread = await ctx.contributionStore.thread(result.findingA.cid);
    // Root (findingA) + responseB (responds_to A) + followUpA (responds_to B)
    // reviewC uses "reviews" relation, not "responds_to", so it's NOT in the thread
    expect(thread.length).toBeGreaterThanOrEqual(2);

    // Root is at depth 0
    expect(thread[0].contribution.cid).toBe(result.findingA.cid);
    expect(thread[0].depth).toBe(0);
  });

  test("thread respects depth ordering", async () => {
    const thread = await ctx.contributionStore.thread(result.findingA.cid);

    // responseB responds_to findingA → depth 1
    const responseBNode = thread.find((n) => n.contribution.cid === result.responseB.cid);
    expect(responseBNode).toBeDefined();
    expect(responseBNode!.depth).toBe(1);

    // followUpA responds_to responseB → depth 2
    const followUpNode = thread.find((n) => n.contribution.cid === result.followUpA.cid);
    expect(followUpNode).toBeDefined();
    expect(followUpNode!.depth).toBe(2);
  });

  test("thread with maxDepth truncates", async () => {
    const shallow = await ctx.contributionStore.thread(result.findingA.cid, { maxDepth: 1 });
    // Should include root (depth 0) + direct replies (depth 1) but not depth 2
    const maxDepth = Math.max(...shallow.map((n) => n.depth));
    expect(maxDepth).toBeLessThanOrEqual(1);
  });

  test("thread with limit caps results", async () => {
    const limited = await ctx.contributionStore.thread(result.findingA.cid, { limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  test("thread of nonexistent CID returns empty", async () => {
    const empty = await ctx.contributionStore.thread(
      "blake3:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(empty).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Reply counts
// ---------------------------------------------------------------------------

describe("reply counts", () => {
  test("findingA has direct replies", async () => {
    const counts = await ctx.contributionStore.replyCounts([result.findingA.cid]);
    const count = counts.get(result.findingA.cid);
    expect(count).toBeDefined();
    // responseB responds_to findingA → 1 reply
    expect(count!).toBeGreaterThanOrEqual(1);
  });

  test("responseB has a reply (followUpA)", async () => {
    const counts = await ctx.contributionStore.replyCounts([result.responseB.cid]);
    const count = counts.get(result.responseB.cid);
    expect(count).toBeDefined();
    expect(count!).toBe(1);
  });

  test("followUpA has no replies (leaf node)", async () => {
    const counts = await ctx.contributionStore.replyCounts([result.followUpA.cid]);
    expect(counts.get(result.followUpA.cid)).toBe(0);
  });

  test("batch reply counts for all contributions", async () => {
    const cids = result.allContributions.map((c) => c.cid);
    const counts = await ctx.contributionStore.replyCounts(cids);
    expect(counts.size).toBe(cids.length);
    // Every CID should have an entry (even if 0)
    for (const cid of cids) {
      expect(counts.has(cid)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Mode filtering in queries
// ---------------------------------------------------------------------------

describe("mode filtering", () => {
  test("list with exploration mode returns all contributions", async () => {
    const exploration = await ctx.contributionStore.list({
      mode: ContributionMode.Exploration,
    });
    expect(exploration).toHaveLength(4);
  });

  test("list with evaluation mode returns nothing", async () => {
    const evaluation = await ctx.contributionStore.list({
      mode: ContributionMode.Evaluation,
    });
    expect(evaluation).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Lifecycle in exploration mode
// ---------------------------------------------------------------------------

describe("lifecycle in exploration mode", () => {
  test("finding A is under_review (has review relation)", async () => {
    const state = await deriveLifecycleState(result.findingA.cid, ctx.contributionStore);
    expect(state).toBe(LifecycleState.UnderReview);
  });

  test("unreviewed discussion is published", async () => {
    const state = await deriveLifecycleState(result.followUpA.cid, ctx.contributionStore);
    expect(state).toBe(LifecycleState.Published);
  });
});
