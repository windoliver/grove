/**
 * Conformance test suite for FrontierCalculator implementations.
 *
 * Uses a factory pattern so any ContributionStore + FrontierCalculator combo
 * can be validated against the same behavioural expectations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FrontierCalculator } from "./frontier.js";
import { ContributionKind, ContributionMode, RelationType, ScoreDirection } from "./models.js";
import type { ContributionStore } from "./store.js";
import { makeContribution, makeRelation, makeScore } from "./test-helpers.js";

export function runFrontierCalculatorTests(
  factory: () => Promise<{
    store: ContributionStore;
    calculator: FrontierCalculator;
    cleanup: () => Promise<void>;
  }>,
): void {
  let store: ContributionStore;
  let calculator: FrontierCalculator;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const ctx = await factory();
    store = ctx.store;
    calculator = ctx.calculator;
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // -----------------------------------------------------------------------
  // Empty store
  // -----------------------------------------------------------------------

  test("empty store produces empty frontier", async () => {
    const frontier = await calculator.compute();
    expect(Object.keys(frontier.byMetric)).toHaveLength(0);
    expect(frontier.byAdoption).toHaveLength(0);
    expect(frontier.byRecency).toHaveLength(0);
    expect(frontier.byReviewScore).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // byRecency
  // -----------------------------------------------------------------------

  describe("byRecency", () => {
    test("sorts by createdAt descending", async () => {
      const c1 = makeContribution({
        summary: "oldest",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const c2 = makeContribution({
        summary: "middle",
        createdAt: "2026-01-02T00:00:00Z",
      });
      const c3 = makeContribution({
        summary: "newest",
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([c1, c2, c3]);
      const frontier = await calculator.compute();

      expect(frontier.byRecency).toHaveLength(3);
      expect(frontier.byRecency[0]?.cid).toBe(c3.cid);
      expect(frontier.byRecency[1]?.cid).toBe(c2.cid);
      expect(frontier.byRecency[2]?.cid).toBe(c1.cid);
    });

    test("respects limit", async () => {
      const c1 = makeContribution({
        summary: "first",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const c2 = makeContribution({
        summary: "second",
        createdAt: "2026-01-02T00:00:00Z",
      });
      const c3 = makeContribution({
        summary: "third",
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([c1, c2, c3]);
      const frontier = await calculator.compute({ limit: 2 });

      expect(frontier.byRecency).toHaveLength(2);
      expect(frontier.byRecency[0]?.cid).toBe(c3.cid);
      expect(frontier.byRecency[1]?.cid).toBe(c2.cid);
    });
  });

  // -----------------------------------------------------------------------
  // byMetric
  // -----------------------------------------------------------------------

  describe("byMetric", () => {
    test("ranks by score value (minimize)", async () => {
      const c1 = makeContribution({
        summary: "high-loss",
        scores: { loss: makeScore({ value: 0.9, direction: ScoreDirection.Minimize }) },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const c2 = makeContribution({
        summary: "low-loss",
        scores: { loss: makeScore({ value: 0.1, direction: ScoreDirection.Minimize }) },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([c1, c2]);
      const frontier = await calculator.compute();

      expect(frontier.byMetric.loss).toHaveLength(2);
      expect(frontier.byMetric.loss?.[0]?.cid).toBe(c2.cid); // lower is better
      expect(frontier.byMetric.loss?.[1]?.cid).toBe(c1.cid);
    });

    test("ranks by score value (maximize)", async () => {
      const c1 = makeContribution({
        summary: "low-throughput",
        scores: {
          throughput: makeScore({ value: 100, direction: ScoreDirection.Maximize }),
        },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const c2 = makeContribution({
        summary: "high-throughput",
        scores: {
          throughput: makeScore({ value: 9000, direction: ScoreDirection.Maximize }),
        },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([c1, c2]);
      const frontier = await calculator.compute();

      expect(frontier.byMetric.throughput).toHaveLength(2);
      expect(frontier.byMetric.throughput?.[0]?.cid).toBe(c2.cid); // higher is better
      expect(frontier.byMetric.throughput?.[1]?.cid).toBe(c1.cid);
    });

    test("excludes exploration mode contributions", async () => {
      const eval1 = makeContribution({
        summary: "evaluated",
        mode: ContributionMode.Evaluation,
        scores: { acc: makeScore({ value: 0.8, direction: ScoreDirection.Maximize }) },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const explore = makeContribution({
        summary: "exploratory",
        mode: ContributionMode.Exploration,
        scores: { acc: makeScore({ value: 0.99, direction: ScoreDirection.Maximize }) },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([eval1, explore]);
      const frontier = await calculator.compute();

      expect(frontier.byMetric.acc).toHaveLength(1);
      expect(frontier.byMetric.acc?.[0]?.cid).toBe(eval1.cid);
    });

    test("with query.metric only computes that metric", async () => {
      const c = makeContribution({
        summary: "multi-score",
        scores: {
          loss: makeScore({ value: 0.5, direction: ScoreDirection.Minimize }),
          acc: makeScore({ value: 0.9, direction: ScoreDirection.Maximize }),
        },
        createdAt: "2026-01-01T00:00:00Z",
      });

      await store.put(c);
      const frontier = await calculator.compute({ metric: "loss" });

      expect(Object.keys(frontier.byMetric)).toEqual(["loss"]);
      expect(frontier.byMetric.loss).toHaveLength(1);
    });

    test("contributions with multiple metrics appear in multiple byMetric entries", async () => {
      const c = makeContribution({
        summary: "dual-metric",
        scores: {
          loss: makeScore({ value: 0.3, direction: ScoreDirection.Minimize }),
          acc: makeScore({ value: 0.95, direction: ScoreDirection.Maximize }),
        },
        createdAt: "2026-01-01T00:00:00Z",
      });

      await store.put(c);
      const frontier = await calculator.compute();

      expect(frontier.byMetric.loss).toHaveLength(1);
      expect(frontier.byMetric.loss?.[0]?.cid).toBe(c.cid);
      expect(frontier.byMetric.acc).toHaveLength(1);
      expect(frontier.byMetric.acc?.[0]?.cid).toBe(c.cid);
    });
  });

  // -----------------------------------------------------------------------
  // byAdoption
  // -----------------------------------------------------------------------

  describe("byAdoption", () => {
    test("counts adoption relations", async () => {
      const target = makeContribution({
        summary: "adopted-target",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const adopter1 = makeContribution({
        summary: "adopter-1",
        kind: ContributionKind.Adoption,
        relations: [makeRelation({ targetCid: target.cid, relationType: RelationType.Adopts })],
        createdAt: "2026-01-02T00:00:00Z",
      });
      const adopter2 = makeContribution({
        summary: "adopter-2",
        kind: ContributionKind.Adoption,
        relations: [makeRelation({ targetCid: target.cid, relationType: RelationType.Adopts })],
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([target, adopter1, adopter2]);
      const frontier = await calculator.compute();

      expect(frontier.byAdoption).toHaveLength(1);
      expect(frontier.byAdoption[0]?.cid).toBe(target.cid);
      expect(frontier.byAdoption[0]?.value).toBe(2);
    });

    test("returns empty when no adoptions exist", async () => {
      const c = makeContribution({
        summary: "no-adopters",
        createdAt: "2026-01-01T00:00:00Z",
      });

      await store.put(c);
      const frontier = await calculator.compute();

      expect(frontier.byAdoption).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // byReviewScore
  // -----------------------------------------------------------------------

  describe("byReviewScore", () => {
    test("averages review scores", async () => {
      const target = makeContribution({
        summary: "reviewed-target",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const review1 = makeContribution({
        summary: "review-1",
        kind: ContributionKind.Review,
        scores: { quality: makeScore({ value: 8, direction: ScoreDirection.Maximize }) },
        relations: [makeRelation({ targetCid: target.cid, relationType: RelationType.Reviews })],
        createdAt: "2026-01-02T00:00:00Z",
      });
      const review2 = makeContribution({
        summary: "review-2",
        kind: ContributionKind.Review,
        scores: { quality: makeScore({ value: 6, direction: ScoreDirection.Maximize }) },
        relations: [makeRelation({ targetCid: target.cid, relationType: RelationType.Reviews })],
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([target, review1, review2]);
      const frontier = await calculator.compute();

      expect(frontier.byReviewScore).toHaveLength(1);
      expect(frontier.byReviewScore[0]?.cid).toBe(target.cid);
      expect(frontier.byReviewScore[0]?.value).toBe(7); // (8+6)/2
    });

    test("respects minimize direction in review scores", async () => {
      const target1 = makeContribution({
        summary: "low-loss-target",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const target2 = makeContribution({
        summary: "high-loss-target",
        createdAt: "2026-01-02T00:00:00Z",
      });

      // Reviews with minimize scores: lower is better
      const review1 = makeContribution({
        summary: "review-low",
        kind: ContributionKind.Review,
        scores: { loss: makeScore({ value: 0.1, direction: ScoreDirection.Minimize }) },
        relations: [makeRelation({ targetCid: target1.cid, relationType: RelationType.Reviews })],
        createdAt: "2026-01-03T00:00:00Z",
      });
      const review2 = makeContribution({
        summary: "review-high",
        kind: ContributionKind.Review,
        scores: { loss: makeScore({ value: 0.9, direction: ScoreDirection.Minimize }) },
        relations: [makeRelation({ targetCid: target2.cid, relationType: RelationType.Reviews })],
        createdAt: "2026-01-04T00:00:00Z",
      });

      await store.putMany([target1, target2, review1, review2]);
      const frontier = await calculator.compute();

      expect(frontier.byReviewScore).toHaveLength(2);
      // With minimize: lower value (0.1) should rank first
      expect(frontier.byReviewScore[0]?.cid).toBe(target1.cid);
      expect(frontier.byReviewScore[1]?.cid).toBe(target2.cid);
    });

    test("returns empty when no reviews exist", async () => {
      const c = makeContribution({
        summary: "no-reviews",
        createdAt: "2026-01-01T00:00:00Z",
      });

      await store.put(c);
      const frontier = await calculator.compute();

      expect(frontier.byReviewScore).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Filtering
  // -----------------------------------------------------------------------

  describe("filtering", () => {
    test("by tags", async () => {
      const tagged = makeContribution({
        summary: "tagged",
        tags: ["ml", "vision"],
        createdAt: "2026-01-01T00:00:00Z",
      });
      const untagged = makeContribution({
        summary: "untagged",
        tags: ["audio"],
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([tagged, untagged]);
      const frontier = await calculator.compute({ tags: ["ml", "vision"] });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(tagged.cid);
    });

    test("by platform", async () => {
      const linux = makeContribution({
        summary: "linux-run",
        agent: { agentId: "a1", platform: "linux" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const mac = makeContribution({
        summary: "mac-run",
        agent: { agentId: "a2", platform: "macos" },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([linux, mac]);
      const frontier = await calculator.compute({ platform: "linux" });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(linux.cid);
    });
  });

  // -----------------------------------------------------------------------
  // Tie-breaking
  // -----------------------------------------------------------------------

  test("tie-breaking is deterministic (by CID)", async () => {
    const c1 = makeContribution({
      summary: "tie-a",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const c2 = makeContribution({
      summary: "tie-b",
      createdAt: "2026-01-01T00:00:00Z", // same timestamp
    });

    await store.putMany([c1, c2]);
    const frontier = await calculator.compute();

    expect(frontier.byRecency).toHaveLength(2);
    // Both have same value; should be sorted by CID lexicographically
    const cids = frontier.byRecency.map((e) => e.cid);
    const sorted = [...cids].sort();
    expect(cids).toEqual(sorted);
  });

  // -----------------------------------------------------------------------
  // query.limit applies to all rankings
  // -----------------------------------------------------------------------

  test("query.limit applies to all rankings", async () => {
    const contributions = Array.from({ length: 5 }, (_, i) =>
      makeContribution({
        summary: `contrib-${i}`,
        scores: { acc: makeScore({ value: i * 0.1, direction: ScoreDirection.Maximize }) },
        createdAt: `2026-01-0${i + 1}T00:00:00Z`,
      }),
    );

    await store.putMany(contributions);
    const frontier = await calculator.compute({ limit: 2 });

    expect(frontier.byRecency).toHaveLength(2);
    expect(frontier.byMetric.acc).toHaveLength(2);
  });
}
