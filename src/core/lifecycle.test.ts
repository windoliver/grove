import { describe, expect, test } from "bun:test";
import type { GroveContract } from "./contract.js";
import {
  deriveLifecycleState,
  deriveLifecycleStates,
  evaluateStopConditions,
  LifecycleState,
} from "./lifecycle.js";
import type { Contribution } from "./models.js";
import {
  type ContributionInput,
  ContributionKind,
  ContributionMode,
  RelationType,
  ScoreDirection,
} from "./models.js";
import { makeContribution } from "./test-helpers.js";
import { InMemoryContributionStore } from "./testing.js";

// ---------------------------------------------------------------------------
// Helper to create contributions with specific relations
// ---------------------------------------------------------------------------

let uniqueCounter = 0;

function uniqueTimestamp(): string {
  uniqueCounter += 1;
  const hours = Math.floor(uniqueCounter / 3600) % 24;
  const minutes = Math.floor((uniqueCounter % 3600) / 60);
  const seconds = uniqueCounter % 60;
  return `2026-01-01T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}Z`;
}

function makeUniqueContribution(overrides?: Partial<ContributionInput>): Contribution {
  const ts = uniqueTimestamp();
  return makeContribution({
    summary: `Contribution ${uniqueCounter}`,
    createdAt: ts,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle State Derivation
// ---------------------------------------------------------------------------

describe("deriveLifecycleState", () => {
  test("returns 'published' for contribution with no incoming relations", async () => {
    const contrib = makeUniqueContribution();
    const store = new InMemoryContributionStore([contrib]);
    const state = await deriveLifecycleState(contrib.cid, store);
    expect(state).toBe(LifecycleState.Published);
  });

  test("returns 'under_review' when contribution has incoming reviews", async () => {
    const target = makeUniqueContribution({ summary: "Target work" });
    const review = makeUniqueContribution({
      kind: ContributionKind.Review,
      summary: "Review of target",
      relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
    });
    const store = new InMemoryContributionStore([target, review]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.UnderReview);
  });

  test("returns 'reproduced' when contribution has confirmed reproduction", async () => {
    const target = makeUniqueContribution({ summary: "Original work" });
    const repro = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Reproduction",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "confirmed" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, repro]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Reproduced);
  });

  test("returns 'reproduced' when reproduction has no metadata (default confirmed)", async () => {
    const target = makeUniqueContribution({ summary: "Original work" });
    const repro = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Reproduction no metadata",
      relations: [{ targetCid: target.cid, relationType: RelationType.Reproduces }],
    });
    const store = new InMemoryContributionStore([target, repro]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Reproduced);
  });

  test("returns 'challenged' when reproduction has result=challenged", async () => {
    const target = makeUniqueContribution({ summary: "Challenged work" });
    const repro = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Challenging reproduction",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "challenged" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, repro]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Challenged);
  });

  test("'challenged' beats 'reproduced' when both exist", async () => {
    const target = makeUniqueContribution({ summary: "Mixed repro" });
    const confirmed = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Confirmed repro",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "confirmed" },
        },
      ],
    });
    const challenged = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Challenged repro",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "challenged" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, confirmed, challenged]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Challenged);
  });

  test("returns 'adopted' when contribution has incoming adopts", async () => {
    const target = makeUniqueContribution({ summary: "Adopted work" });
    const adoption = makeUniqueContribution({
      kind: ContributionKind.Adoption,
      summary: "Adoption",
      relations: [{ targetCid: target.cid, relationType: RelationType.Adopts }],
    });
    const store = new InMemoryContributionStore([target, adoption]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Adopted);
  });

  test("'adopted' beats 'reproduced'", async () => {
    const target = makeUniqueContribution({ summary: "Adopted+reproduced" });
    const repro = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Repro",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "confirmed" },
        },
      ],
    });
    const adoption = makeUniqueContribution({
      kind: ContributionKind.Adoption,
      summary: "Adoption",
      relations: [{ targetCid: target.cid, relationType: RelationType.Adopts }],
    });
    const store = new InMemoryContributionStore([target, repro, adoption]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Adopted);
  });

  test("returns 'superseded' when derives_from has metadata.relationship=supersedes", async () => {
    const target = makeUniqueContribution({ summary: "Superseded work" });
    const newer = makeUniqueContribution({
      summary: "Superseding work",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.DerivesFrom,
          metadata: { relationship: "supersedes" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, newer]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Superseded);
  });

  test("'superseded' beats 'challenged'", async () => {
    const target = makeUniqueContribution({ summary: "Superseded+challenged" });
    const challenged = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Challenge",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "challenged" },
        },
      ],
    });
    const superseder = makeUniqueContribution({
      summary: "Superseder",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.DerivesFrom,
          metadata: { relationship: "supersedes" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, challenged, superseder]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Superseded);
  });

  test("normal derives_from does NOT cause superseded", async () => {
    const target = makeUniqueContribution({ summary: "Extended work" });
    const derived = makeUniqueContribution({
      summary: "Derived work",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.DerivesFrom,
          metadata: { relationship: "extension" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, derived]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Published);
  });
});

// ---------------------------------------------------------------------------
// Batch lifecycle state derivation
// ---------------------------------------------------------------------------

describe("deriveLifecycleStates", () => {
  test("returns empty map for empty input", async () => {
    const store = new InMemoryContributionStore();
    const states = await deriveLifecycleStates([], store);
    expect(states.size).toBe(0);
  });

  test("derives states for multiple contributions in one pass", async () => {
    const published = makeUniqueContribution({ summary: "Published" });
    const reviewed = makeUniqueContribution({ summary: "Reviewed" });
    const review = makeUniqueContribution({
      kind: ContributionKind.Review,
      summary: "A review",
      relations: [{ targetCid: reviewed.cid, relationType: RelationType.Reviews }],
    });

    const store = new InMemoryContributionStore([published, reviewed, review]);
    const states = await deriveLifecycleStates([published.cid, reviewed.cid], store);

    expect(states.get(published.cid)).toBe(LifecycleState.Published);
    expect(states.get(reviewed.cid)).toBe(LifecycleState.UnderReview);
  });
});

// ---------------------------------------------------------------------------
// Stop Condition Evaluation
// ---------------------------------------------------------------------------

describe("evaluateStopConditions", () => {
  test("returns not stopped when no stop conditions defined", async () => {
    const contract: GroveContract = { contractVersion: 1, name: "test" };
    const store = new InMemoryContributionStore();
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(Object.keys(result.conditions)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // max_rounds_without_improvement
  // -----------------------------------------------------------------------

  describe("max_rounds_without_improvement", () => {
    test("not met when fewer contributions than threshold", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { maxRoundsWithoutImprovement: 5 },
      };
      const contribs = [
        makeUniqueContribution({
          scores: { val_bpb: { value: 1.0, direction: ScoreDirection.Minimize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.max_rounds_without_improvement?.met).toBe(false);
    });

    test("not met when improvement exists in last N", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { maxRoundsWithoutImprovement: 3 },
      };
      // 5 contributions, the best score (0.5) is in the last 3
      const contribs = Array.from({ length: 5 }, (_, i) =>
        makeUniqueContribution({
          summary: `Work ${i}`,
          createdAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
          scores: {
            val_bpb: { value: 1.0 - i * 0.1, direction: ScoreDirection.Minimize },
          },
        }),
      );
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.max_rounds_without_improvement?.met).toBe(false);
    });

    test("met when no improvement in last N contributions", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { maxRoundsWithoutImprovement: 3 },
      };
      // Best score (0.5) is the first contribution; last 3 are all worse
      const contribs = [
        makeUniqueContribution({
          summary: "Best",
          createdAt: "2026-01-01T00:00:00Z",
          scores: { val_bpb: { value: 0.5, direction: ScoreDirection.Minimize } },
        }),
        makeUniqueContribution({
          summary: "Worse 1",
          createdAt: "2026-01-01T00:01:00Z",
          scores: { val_bpb: { value: 0.8, direction: ScoreDirection.Minimize } },
        }),
        makeUniqueContribution({
          summary: "Worse 2",
          createdAt: "2026-01-01T00:02:00Z",
          scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
        }),
        makeUniqueContribution({
          summary: "Worse 3",
          createdAt: "2026-01-01T00:03:00Z",
          scores: { val_bpb: { value: 0.85, direction: ScoreDirection.Minimize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.max_rounds_without_improvement?.met).toBe(true);
    });

    test("met when last N tie the best but did not set a new best (tie case)", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { loss: { direction: "minimize" as const } },
        stopConditions: { maxRoundsWithoutImprovement: 2 },
      };
      // scores: [10, 8, 8, 8] — best is 8, set at index 1, last 2 are ties not new bests
      const contribs = [
        makeUniqueContribution({
          summary: "First",
          createdAt: "2026-01-01T00:00:00Z",
          scores: { loss: { value: 10, direction: ScoreDirection.Minimize } },
        }),
        makeUniqueContribution({
          summary: "Best",
          createdAt: "2026-01-01T00:01:00Z",
          scores: { loss: { value: 8, direction: ScoreDirection.Minimize } },
        }),
        makeUniqueContribution({
          summary: "Tie 1",
          createdAt: "2026-01-01T00:02:00Z",
          scores: { loss: { value: 8, direction: ScoreDirection.Minimize } },
        }),
        makeUniqueContribution({
          summary: "Tie 2",
          createdAt: "2026-01-01T00:03:00Z",
          scores: { loss: { value: 8, direction: ScoreDirection.Minimize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      // Best was set at index 1, which is outside the last 2 → met
      expect(result.conditions.max_rounds_without_improvement?.met).toBe(true);
    });

    test("not met when no metrics defined", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { maxRoundsWithoutImprovement: 3 },
      };
      const contribs = Array.from({ length: 5 }, (_, i) =>
        makeUniqueContribution({
          summary: `Work ${i}`,
          createdAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        }),
      );
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.max_rounds_without_improvement?.met).toBe(false);
    });

    test("exploration contributions count as rounds but not improvements", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { maxRoundsWithoutImprovement: 2 },
      };
      const contribs = [
        makeUniqueContribution({
          summary: "Best eval",
          createdAt: "2026-01-01T00:00:00Z",
          mode: ContributionMode.Evaluation,
          scores: { val_bpb: { value: 0.5, direction: ScoreDirection.Minimize } },
        }),
        makeUniqueContribution({
          summary: "Exploration 1",
          createdAt: "2026-01-01T00:01:00Z",
          mode: ContributionMode.Exploration,
        }),
        makeUniqueContribution({
          summary: "Exploration 2",
          createdAt: "2026-01-01T00:02:00Z",
          mode: ContributionMode.Exploration,
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      // Last 2 are exploration, best eval is outside last 2 → met
      expect(result.conditions.max_rounds_without_improvement?.met).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // target_metric
  // -----------------------------------------------------------------------

  describe("target_metric", () => {
    test("met when minimize metric reaches target", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { targetMetric: { metric: "val_bpb", value: 0.85 } },
      };
      const contribs = [
        makeUniqueContribution({
          scores: { val_bpb: { value: 0.8, direction: ScoreDirection.Minimize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.target_metric?.met).toBe(true);
    });

    test("met when maximize metric reaches target", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { throughput: { direction: "maximize" as const } },
        stopConditions: { targetMetric: { metric: "throughput", value: 100 } },
      };
      const contribs = [
        makeUniqueContribution({
          scores: { throughput: { value: 105, direction: ScoreDirection.Maximize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.target_metric?.met).toBe(true);
    });

    test("not met when score has not reached target", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { targetMetric: { metric: "val_bpb", value: 0.85 } },
      };
      const contribs = [
        makeUniqueContribution({
          scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.target_metric?.met).toBe(false);
    });

    test("not met when metric has no scores", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { targetMetric: { metric: "val_bpb", value: 0.85 } },
      };
      const store = new InMemoryContributionStore([makeUniqueContribution()]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.target_metric?.met).toBe(false);
    });

    test("not met when metric is not defined in contract", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { targetMetric: { metric: "nonexistent", value: 1.0 } },
      };
      const store = new InMemoryContributionStore([makeUniqueContribution()]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.target_metric?.met).toBe(false);
    });

    test("met when score exactly equals target (boundary)", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { targetMetric: { metric: "val_bpb", value: 0.85 } },
      };
      const contribs = [
        makeUniqueContribution({
          scores: { val_bpb: { value: 0.85, direction: ScoreDirection.Minimize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.target_metric?.met).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // budget
  // -----------------------------------------------------------------------

  describe("budget", () => {
    test("met when contribution count exceeds limit", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { budget: { maxContributions: 3 } },
      };
      const contribs = Array.from({ length: 5 }, (_, i) =>
        makeUniqueContribution({ summary: `Work ${i}` }),
      );
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.budget?.met).toBe(true);
    });

    test("not met when contribution count is below limit", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { budget: { maxContributions: 10 } },
      };
      const contribs = [makeUniqueContribution()];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.budget?.met).toBe(false);
    });

    test("not met when grove is empty", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { budget: { maxContributions: 10, maxWallClockSeconds: 3600 } },
      };
      const store = new InMemoryContributionStore();
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.budget?.met).toBe(false);
    });

    test("met when contribution count exactly equals limit (boundary)", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { budget: { maxContributions: 3 } },
      };
      const contribs = Array.from({ length: 3 }, (_, i) =>
        makeUniqueContribution({ summary: `Work ${i}` }),
      );
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.budget?.met).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // quorum_review_score
  // -----------------------------------------------------------------------

  describe("quorum_review_score", () => {
    test("met when a contribution has enough reviews above threshold", async () => {
      const target = makeUniqueContribution({ summary: "Work to review" });
      const review1 = makeUniqueContribution({
        kind: ContributionKind.Review,
        summary: "Review 1",
        relations: [
          {
            targetCid: target.cid,
            relationType: RelationType.Reviews,
            metadata: { score: 0.9 },
          },
        ],
      });
      const review2 = makeUniqueContribution({
        kind: ContributionKind.Review,
        summary: "Review 2",
        relations: [
          {
            targetCid: target.cid,
            relationType: RelationType.Reviews,
            metadata: { score: 0.85 },
          },
        ],
      });

      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { quorumReviewScore: { minReviews: 2, minScore: 0.8 } },
      };
      const store = new InMemoryContributionStore([target, review1, review2]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.quorum_review_score?.met).toBe(true);
    });

    test("not met when reviews exist but average below threshold", async () => {
      const target = makeUniqueContribution({ summary: "Work" });
      const review1 = makeUniqueContribution({
        kind: ContributionKind.Review,
        summary: "Low review",
        relations: [
          {
            targetCid: target.cid,
            relationType: RelationType.Reviews,
            metadata: { score: 0.5 },
          },
        ],
      });
      const review2 = makeUniqueContribution({
        kind: ContributionKind.Review,
        summary: "Another low review",
        relations: [
          {
            targetCid: target.cid,
            relationType: RelationType.Reviews,
            metadata: { score: 0.6 },
          },
        ],
      });

      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { quorumReviewScore: { minReviews: 2, minScore: 0.8 } },
      };
      const store = new InMemoryContributionStore([target, review1, review2]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.quorum_review_score?.met).toBe(false);
    });

    test("not met when reviews exist but count below threshold", async () => {
      const target = makeUniqueContribution({ summary: "Work" });
      const review1 = makeUniqueContribution({
        kind: ContributionKind.Review,
        summary: "Good review",
        relations: [
          {
            targetCid: target.cid,
            relationType: RelationType.Reviews,
            metadata: { score: 0.95 },
          },
        ],
      });

      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { quorumReviewScore: { minReviews: 3, minScore: 0.8 } },
      };
      const store = new InMemoryContributionStore([target, review1]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.quorum_review_score?.met).toBe(false);
    });

    test("reviews without scores count toward count but not average", async () => {
      const target = makeUniqueContribution({ summary: "Work" });
      const scoredReview = makeUniqueContribution({
        kind: ContributionKind.Review,
        summary: "Scored review",
        relations: [
          {
            targetCid: target.cid,
            relationType: RelationType.Reviews,
            metadata: { score: 0.9 },
          },
        ],
      });
      const unscoredReview = makeUniqueContribution({
        kind: ContributionKind.Review,
        summary: "Unscored review",
        relations: [
          {
            targetCid: target.cid,
            relationType: RelationType.Reviews,
            metadata: { verdict: "approve" },
          },
        ],
      });

      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        // Need 2 reviews with min score 0.8 — but only 1 has a score
        stopConditions: { quorumReviewScore: { minReviews: 2, minScore: 0.8 } },
      };
      const store = new InMemoryContributionStore([target, scoredReview, unscoredReview]);
      const result = await evaluateStopConditions(contract, store);
      // Only 1 scored review → average is 0.9 from 1 score, meets threshold
      // But wait: the evaluator counts scored reviews only for the average
      // 1 scored review (0.9) — average is 0.9 >= 0.8, and we have 1 scored review
      // The min_reviews check counts reviews with scores only? No — re-read the spec:
      // "Reviews without metadata.score are counted toward min_reviews but do not
      // contribute to the average score calculation"
      // So: 2 reviews total >= 2 min_reviews ✓, average of scored = 0.9 >= 0.8 ✓ → MET
      expect(result.conditions.quorum_review_score?.met).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // deliberation_limit
  // -----------------------------------------------------------------------

  describe("deliberation_limit", () => {
    test("met when thread depth exceeds max_rounds", async () => {
      const root = makeUniqueContribution({ summary: "Root topic" });
      const reply1 = makeUniqueContribution({
        kind: ContributionKind.Discussion,
        summary: "Reply 1",
        relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
      });
      const reply2 = makeUniqueContribution({
        kind: ContributionKind.Discussion,
        summary: "Reply 2",
        relations: [{ targetCid: reply1.cid, relationType: RelationType.RespondsTo }],
      });
      const reply3 = makeUniqueContribution({
        kind: ContributionKind.Discussion,
        summary: "Reply 3",
        relations: [{ targetCid: reply2.cid, relationType: RelationType.RespondsTo }],
      });

      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { deliberationLimit: { maxRounds: 3 } },
      };
      const store = new InMemoryContributionStore([root, reply1, reply2, reply3]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.deliberation_limit?.met).toBe(true);
    });

    test("not met when thread depth is below max_rounds", async () => {
      const root = makeUniqueContribution({ summary: "Root" });
      const reply1 = makeUniqueContribution({
        kind: ContributionKind.Discussion,
        summary: "Reply 1",
        relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
      });

      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { deliberationLimit: { maxRounds: 5 } },
      };
      const store = new InMemoryContributionStore([root, reply1]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.deliberation_limit?.met).toBe(false);
    });

    test("met when message count exceeds max_messages", async () => {
      const root = makeUniqueContribution({ summary: "Root" });
      // Create 5 direct replies (breadth, not depth)
      const replies = Array.from({ length: 5 }, (_, i) =>
        makeUniqueContribution({
          kind: ContributionKind.Discussion,
          summary: `Reply ${i}`,
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        }),
      );

      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { deliberationLimit: { maxMessages: 3 } },
      };
      const store = new InMemoryContributionStore([root, ...replies]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.deliberation_limit?.met).toBe(true);
    });

    test("maxMessages on deep chain is not truncated by maxRounds", async () => {
      // Regression: maxMessages must count the full thread, not just up
      // to maxRounds depth. A 60-message chain with { maxMessages: 55 }
      // must trigger even if maxRounds is unset (default depth was 50).
      const root = makeUniqueContribution({ summary: "Deep root" });
      const allContribs = [root];
      let parentCid = root.cid;
      for (let i = 0; i < 60; i++) {
        const reply = makeUniqueContribution({
          kind: ContributionKind.Discussion,
          summary: `Deep reply ${i}`,
          relations: [{ targetCid: parentCid, relationType: RelationType.RespondsTo }],
        });
        allContribs.push(reply);
        parentCid = reply.cid;
      }

      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { deliberationLimit: { maxMessages: 55 } },
      };
      const store = new InMemoryContributionStore(allContribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.deliberation_limit?.met).toBe(true);
    });

    test("not met when no discussion threads exist", async () => {
      const work = makeUniqueContribution({ summary: "Just work" });
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { deliberationLimit: { maxRounds: 5, maxMessages: 100 } },
      };
      const store = new InMemoryContributionStore([work]);
      const result = await evaluateStopConditions(contract, store);
      expect(result.conditions.deliberation_limit?.met).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple conditions
  // -----------------------------------------------------------------------

  describe("multiple conditions", () => {
    test("stopped=true when any single condition is met", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: {
          targetMetric: { metric: "val_bpb", value: 0.85 },
          budget: { maxContributions: 100 }, // not met
        },
      };
      const contribs = [
        makeUniqueContribution({
          scores: { val_bpb: { value: 0.8, direction: ScoreDirection.Minimize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.stopped).toBe(true);
      expect(result.conditions.target_metric?.met).toBe(true);
      expect(result.conditions.budget?.met).toBe(false);
    });

    test("stopped=false when no conditions are met", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: {
          targetMetric: { metric: "val_bpb", value: 0.5 }, // not met
          budget: { maxContributions: 100 }, // not met
        },
      };
      const contribs = [
        makeUniqueContribution({
          scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
        }),
      ];
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.stopped).toBe(false);
    });

    test("reports which conditions are met", async () => {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "test",
        stopConditions: { budget: { maxContributions: 2 } },
      };
      const contribs = Array.from({ length: 3 }, (_, i) =>
        makeUniqueContribution({ summary: `Work ${i}` }),
      );
      const store = new InMemoryContributionStore(contribs);
      const result = await evaluateStopConditions(contract, store);
      expect(result.stopped).toBe(true);
      expect(result.conditions.budget?.met).toBe(true);
      expect(result.conditions.budget?.reason).toContain("contributions");
    });
  });

  // -----------------------------------------------------------------------
  // Empty grove edge case
  // -----------------------------------------------------------------------

  test("all conditions not met on empty grove", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test",
      metrics: { val_bpb: { direction: "minimize" as const } },
      stopConditions: {
        maxRoundsWithoutImprovement: 5,
        targetMetric: { metric: "val_bpb", value: 0.85 },
        budget: { maxContributions: 100, maxWallClockSeconds: 3600 },
        quorumReviewScore: { minReviews: 2, minScore: 0.8 },
        deliberationLimit: { maxRounds: 5, maxMessages: 100 },
      },
    };
    const store = new InMemoryContributionStore();
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    for (const condition of Object.values(result.conditions)) {
      expect(condition.met).toBe(false);
    }
  });
});
