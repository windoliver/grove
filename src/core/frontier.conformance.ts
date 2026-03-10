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
    expect(frontier.byReproduction).toHaveLength(0);
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
    test("counts adopts relations", async () => {
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

    test("counts derives_from relations toward adoption", async () => {
      const target = makeContribution({
        summary: "derived-target",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const child = makeContribution({
        summary: "child-work",
        kind: ContributionKind.Work,
        relations: [
          makeRelation({ targetCid: target.cid, relationType: RelationType.DerivesFrom }),
        ],
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([target, child]);
      const frontier = await calculator.compute();

      expect(frontier.byAdoption).toHaveLength(1);
      expect(frontier.byAdoption[0]?.cid).toBe(target.cid);
      expect(frontier.byAdoption[0]?.value).toBe(1);
    });

    test("sums derives_from and adopts from different contributors", async () => {
      const target = makeContribution({
        summary: "popular-target",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const deriver = makeContribution({
        summary: "deriver",
        kind: ContributionKind.Work,
        relations: [
          makeRelation({ targetCid: target.cid, relationType: RelationType.DerivesFrom }),
        ],
        createdAt: "2026-01-02T00:00:00Z",
      });
      const adopter = makeContribution({
        summary: "adopter",
        kind: ContributionKind.Adoption,
        relations: [makeRelation({ targetCid: target.cid, relationType: RelationType.Adopts })],
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([target, deriver, adopter]);
      const frontier = await calculator.compute();

      expect(frontier.byAdoption).toHaveLength(1);
      expect(frontier.byAdoption[0]?.cid).toBe(target.cid);
      expect(frontier.byAdoption[0]?.value).toBe(2);
    });

    test("single contributor with both derives_from and adopts counts as 2", async () => {
      const target = makeContribution({
        summary: "doubly-referenced",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const contributor = makeContribution({
        summary: "both-relations",
        kind: ContributionKind.Work,
        relations: [
          makeRelation({ targetCid: target.cid, relationType: RelationType.DerivesFrom }),
          makeRelation({ targetCid: target.cid, relationType: RelationType.Adopts }),
        ],
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([target, contributor]);
      const frontier = await calculator.compute();

      expect(frontier.byAdoption).toHaveLength(1);
      expect(frontier.byAdoption[0]?.cid).toBe(target.cid);
      // Two relations from same contributor = 2 (counts relations, not contributors)
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
  // byReproduction
  // -----------------------------------------------------------------------

  describe("byReproduction", () => {
    test("counts reproduces relations", async () => {
      const target = makeContribution({
        summary: "reproduced-target",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const repro1 = makeContribution({
        summary: "reproduction-1",
        kind: ContributionKind.Reproduction,
        relations: [makeRelation({ targetCid: target.cid, relationType: RelationType.Reproduces })],
        createdAt: "2026-01-02T00:00:00Z",
      });
      const repro2 = makeContribution({
        summary: "reproduction-2",
        kind: ContributionKind.Reproduction,
        relations: [makeRelation({ targetCid: target.cid, relationType: RelationType.Reproduces })],
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([target, repro1, repro2]);
      const frontier = await calculator.compute();

      expect(frontier.byReproduction).toHaveLength(1);
      expect(frontier.byReproduction[0]?.cid).toBe(target.cid);
      expect(frontier.byReproduction[0]?.value).toBe(2);
    });

    test("ranks by reproduction count descending", async () => {
      const target1 = makeContribution({
        summary: "often-reproduced",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const target2 = makeContribution({
        summary: "rarely-reproduced",
        createdAt: "2026-01-02T00:00:00Z",
      });

      const repro1a = makeContribution({
        summary: "repro-1a",
        kind: ContributionKind.Reproduction,
        relations: [
          makeRelation({ targetCid: target1.cid, relationType: RelationType.Reproduces }),
        ],
        createdAt: "2026-01-03T00:00:00Z",
      });
      const repro1b = makeContribution({
        summary: "repro-1b",
        kind: ContributionKind.Reproduction,
        relations: [
          makeRelation({ targetCid: target1.cid, relationType: RelationType.Reproduces }),
        ],
        createdAt: "2026-01-04T00:00:00Z",
      });
      const repro2a = makeContribution({
        summary: "repro-2a",
        kind: ContributionKind.Reproduction,
        relations: [
          makeRelation({ targetCid: target2.cid, relationType: RelationType.Reproduces }),
        ],
        createdAt: "2026-01-05T00:00:00Z",
      });

      await store.putMany([target1, target2, repro1a, repro1b, repro2a]);
      const frontier = await calculator.compute();

      expect(frontier.byReproduction.length).toBeGreaterThanOrEqual(2);
      expect(frontier.byReproduction[0]?.cid).toBe(target1.cid);
      expect(frontier.byReproduction[0]?.value).toBe(2);
      expect(frontier.byReproduction[1]?.cid).toBe(target2.cid);
      expect(frontier.byReproduction[1]?.value).toBe(1);
    });

    test("respects limit", async () => {
      const targets = Array.from({ length: 3 }, (_, i) =>
        makeContribution({
          summary: `target-${i}`,
          createdAt: `2026-01-0${i + 1}T00:00:00Z`,
        }),
      );
      await store.putMany(targets);

      const repros = targets.map((t, i) =>
        makeContribution({
          summary: `repro-${i}`,
          kind: ContributionKind.Reproduction,
          relations: [makeRelation({ targetCid: t.cid, relationType: RelationType.Reproduces })],
          createdAt: `2026-02-0${i + 1}T00:00:00Z`,
        }),
      );
      await store.putMany(repros);

      const frontier = await calculator.compute({ limit: 2 });
      expect(frontier.byReproduction).toHaveLength(2);
    });

    test("excludes challenged reproductions", async () => {
      const target = makeContribution({
        summary: "challenged-target",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const confirmed = makeContribution({
        summary: "confirmed-repro",
        kind: ContributionKind.Reproduction,
        relations: [
          makeRelation({
            targetCid: target.cid,
            relationType: RelationType.Reproduces,
            metadata: { result: "confirmed" },
          }),
        ],
        createdAt: "2026-01-02T00:00:00Z",
      });
      const challenged = makeContribution({
        summary: "challenged-repro",
        kind: ContributionKind.Reproduction,
        relations: [
          makeRelation({
            targetCid: target.cid,
            relationType: RelationType.Reproduces,
            metadata: { result: "challenged" },
          }),
        ],
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([target, confirmed, challenged]);
      const frontier = await calculator.compute();

      // Only the confirmed reproduction counts
      expect(frontier.byReproduction).toHaveLength(1);
      expect(frontier.byReproduction[0]?.cid).toBe(target.cid);
      expect(frontier.byReproduction[0]?.value).toBe(1);
    });

    test("counts partial reproductions", async () => {
      const target = makeContribution({
        summary: "partial-target",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const partial = makeContribution({
        summary: "partial-repro",
        kind: ContributionKind.Reproduction,
        relations: [
          makeRelation({
            targetCid: target.cid,
            relationType: RelationType.Reproduces,
            metadata: { result: "partial" },
          }),
        ],
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([target, partial]);
      const frontier = await calculator.compute();

      expect(frontier.byReproduction).toHaveLength(1);
      expect(frontier.byReproduction[0]?.value).toBe(1);
    });

    test("treats missing metadata as confirmed", async () => {
      const target = makeContribution({
        summary: "no-metadata-target",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const noMeta = makeContribution({
        summary: "no-metadata-repro",
        kind: ContributionKind.Reproduction,
        relations: [
          makeRelation({
            targetCid: target.cid,
            relationType: RelationType.Reproduces,
          }),
        ],
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([target, noMeta]);
      const frontier = await calculator.compute();

      // No metadata → treated as confirmed
      expect(frontier.byReproduction).toHaveLength(1);
      expect(frontier.byReproduction[0]?.value).toBe(1);
    });

    test("returns empty when no reproductions exist", async () => {
      const c = makeContribution({
        summary: "no-reproductions",
        createdAt: "2026-01-01T00:00:00Z",
      });

      await store.put(c);
      const frontier = await calculator.compute();

      expect(frontier.byReproduction).toHaveLength(0);
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

    test("by kind", async () => {
      const work = makeContribution({
        summary: "work-item",
        kind: ContributionKind.Work,
        createdAt: "2026-01-01T00:00:00Z",
      });
      const review = makeContribution({
        summary: "review-item",
        kind: ContributionKind.Review,
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([work, review]);
      const frontier = await calculator.compute({ kind: ContributionKind.Work });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(work.cid);
    });

    test("by mode", async () => {
      const evaluation = makeContribution({
        summary: "eval-item",
        mode: ContributionMode.Evaluation,
        scores: { acc: makeScore({ value: 0.9, direction: ScoreDirection.Maximize }) },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const exploration = makeContribution({
        summary: "explore-item",
        mode: ContributionMode.Exploration,
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([evaluation, exploration]);
      const frontier = await calculator.compute({ mode: ContributionMode.Exploration });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(exploration.cid);
    });

    test("by agentId", async () => {
      const agentA = makeContribution({
        summary: "agent-a-work",
        agent: { agentId: "agent-a" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const agentB = makeContribution({
        summary: "agent-b-work",
        agent: { agentId: "agent-b" },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([agentA, agentB]);
      const frontier = await calculator.compute({ agentId: "agent-a" });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(agentA.cid);
    });

    test("by agentName", async () => {
      const claude = makeContribution({
        summary: "claude-work",
        agent: { agentId: "a1", agentName: "claude" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const codex = makeContribution({
        summary: "codex-work",
        agent: { agentId: "a2", agentName: "codex" },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([claude, codex]);
      const frontier = await calculator.compute({ agentName: "claude" });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(claude.cid);
    });

    test("combined filters use AND semantics", async () => {
      const match = makeContribution({
        summary: "match-all",
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        tags: ["ml"],
        agent: { agentId: "a1", platform: "linux" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const wrongKind = makeContribution({
        summary: "wrong-kind",
        kind: ContributionKind.Review,
        mode: ContributionMode.Evaluation,
        tags: ["ml"],
        agent: { agentId: "a1", platform: "linux" },
        createdAt: "2026-01-02T00:00:00Z",
      });
      const wrongTag = makeContribution({
        summary: "wrong-tag",
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        tags: ["audio"],
        agent: { agentId: "a1", platform: "linux" },
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([match, wrongKind, wrongTag]);
      const frontier = await calculator.compute({
        kind: ContributionKind.Work,
        tags: ["ml"],
        platform: "linux",
      });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(match.cid);
    });
  });

  // -----------------------------------------------------------------------
  // Context filtering
  // -----------------------------------------------------------------------

  describe("context filtering", () => {
    test("filters by single context field", async () => {
      const h100 = makeContribution({
        summary: "h100-run",
        context: { hardware: "H100" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const a100 = makeContribution({
        summary: "a100-run",
        context: { hardware: "A100" },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([h100, a100]);
      const frontier = await calculator.compute({ context: { hardware: "H100" } });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(h100.cid);
    });

    test("filters by multiple context fields (AND semantics)", async () => {
      const match = makeContribution({
        summary: "h100-openwebtext",
        context: { hardware: "H100", dataset: "openwebtext" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const partialMatch = makeContribution({
        summary: "h100-other",
        context: { hardware: "H100", dataset: "c4" },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([match, partialMatch]);
      const frontier = await calculator.compute({
        context: { hardware: "H100", dataset: "openwebtext" },
      });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(match.cid);
    });

    test("excludes contributions without context field", async () => {
      const withContext = makeContribution({
        summary: "with-context",
        context: { hardware: "H100" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const noContext = makeContribution({
        summary: "no-context",
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([withContext, noContext]);
      const frontier = await calculator.compute({ context: { hardware: "H100" } });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(withContext.cid);
    });

    test("excludes contributions missing the specified context key", async () => {
      const withKey = makeContribution({
        summary: "has-hardware",
        context: { hardware: "H100", region: "us-west" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const missingKey = makeContribution({
        summary: "no-hardware",
        context: { region: "us-west" },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([withKey, missingKey]);
      const frontier = await calculator.compute({ context: { hardware: "H100" } });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(withKey.cid);
    });

    test("context filter combines with tag filter (AND semantics)", async () => {
      const match = makeContribution({
        summary: "h100-ml",
        context: { hardware: "H100" },
        tags: ["ml"],
        createdAt: "2026-01-01T00:00:00Z",
      });
      const wrongTag = makeContribution({
        summary: "h100-audio",
        context: { hardware: "H100" },
        tags: ["audio"],
        createdAt: "2026-01-02T00:00:00Z",
      });
      const wrongContext = makeContribution({
        summary: "a100-ml",
        context: { hardware: "A100" },
        tags: ["ml"],
        createdAt: "2026-01-03T00:00:00Z",
      });

      await store.putMany([match, wrongTag, wrongContext]);
      const frontier = await calculator.compute({
        tags: ["ml"],
        context: { hardware: "H100" },
      });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(match.cid);
    });

    test("matches nested objects regardless of key order", async () => {
      const contrib = makeContribution({
        summary: "nested-context",
        context: { config: { a: 1, b: 2 } },
        createdAt: "2026-01-01T00:00:00Z",
      });

      await store.put(contrib);

      // Query with keys in different order than stored
      const frontier = await calculator.compute({
        context: { config: { b: 2, a: 1 } },
      });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(contrib.cid);
    });

    test("matches numeric context values exactly", async () => {
      const gpuCount4 = makeContribution({
        summary: "4-gpu",
        context: { gpuCount: 4 },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const gpuCount8 = makeContribution({
        summary: "8-gpu",
        context: { gpuCount: 8 },
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([gpuCount4, gpuCount8]);
      const frontier = await calculator.compute({ context: { gpuCount: 4 } });

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(gpuCount4.cid);
    });
  });

  // -----------------------------------------------------------------------
  // Exploration mode inclusion
  // -----------------------------------------------------------------------

  describe("exploration mode inclusion", () => {
    test("exploration contributions appear in byRecency", async () => {
      const explore = makeContribution({
        summary: "exploratory-work",
        mode: ContributionMode.Exploration,
        createdAt: "2026-01-01T00:00:00Z",
      });

      await store.put(explore);
      const frontier = await calculator.compute();

      expect(frontier.byRecency).toHaveLength(1);
      expect(frontier.byRecency[0]?.cid).toBe(explore.cid);
    });

    test("exploration contributions appear in byAdoption when adopted", async () => {
      const explore = makeContribution({
        summary: "adopted-exploration",
        mode: ContributionMode.Exploration,
        createdAt: "2026-01-01T00:00:00Z",
      });

      const adopter = makeContribution({
        summary: "adopter",
        kind: ContributionKind.Adoption,
        relations: [makeRelation({ targetCid: explore.cid, relationType: RelationType.Adopts })],
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([explore, adopter]);
      const frontier = await calculator.compute();

      expect(frontier.byAdoption).toHaveLength(1);
      expect(frontier.byAdoption[0]?.cid).toBe(explore.cid);
    });

    test("exploration contributions appear in byReviewScore when reviewed", async () => {
      const explore = makeContribution({
        summary: "reviewed-exploration",
        mode: ContributionMode.Exploration,
        createdAt: "2026-01-01T00:00:00Z",
      });

      const review = makeContribution({
        summary: "review-of-exploration",
        kind: ContributionKind.Review,
        scores: { quality: makeScore({ value: 9, direction: ScoreDirection.Maximize }) },
        relations: [makeRelation({ targetCid: explore.cid, relationType: RelationType.Reviews })],
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([explore, review]);
      const frontier = await calculator.compute();

      expect(frontier.byReviewScore).toHaveLength(1);
      expect(frontier.byReviewScore[0]?.cid).toBe(explore.cid);
    });

    test("exploration contributions appear in byReproduction when reproduced", async () => {
      const explore = makeContribution({
        summary: "reproduced-exploration",
        mode: ContributionMode.Exploration,
        createdAt: "2026-01-01T00:00:00Z",
      });

      const repro = makeContribution({
        summary: "reproduction-of-exploration",
        kind: ContributionKind.Reproduction,
        relations: [
          makeRelation({ targetCid: explore.cid, relationType: RelationType.Reproduces }),
        ],
        createdAt: "2026-01-02T00:00:00Z",
      });

      await store.putMany([explore, repro]);
      const frontier = await calculator.compute();

      expect(frontier.byReproduction).toHaveLength(1);
      expect(frontier.byReproduction[0]?.cid).toBe(explore.cid);
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
