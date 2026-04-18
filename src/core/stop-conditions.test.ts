import { describe, expect, test } from "bun:test";
import type { GroveContract } from "./contract.js";
import type { Contribution } from "./models.js";
import {
  type ContributionInput,
  ContributionKind,
  ContributionMode,
  RelationType,
  ScoreDirection,
} from "./models.js";
import { PolicyEnforcer } from "./policy-enforcer.js";
import { evaluateStopConditions } from "./stop-conditions.js";
import { makeContribution } from "./test-helpers.js";
import { InMemoryContributionStore } from "./testing.js";

// ---------------------------------------------------------------------------
// Helpers
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
// Section 1: max_rounds_without_improvement
// ---------------------------------------------------------------------------

describe("max_rounds_without_improvement", () => {
  test("returns not stopped when no stop conditions defined", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
    };
    const store = new InMemoryContributionStore([makeUniqueContribution()]);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(Object.keys(result.conditions)).toHaveLength(0);
  });

  test("not met when fewer contributions than threshold", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 5,
      },
    };
    const contributions = Array.from({ length: 3 }, () =>
      makeUniqueContribution({
        scores: { val_bpb: { value: 1.0, direction: ScoreDirection.Minimize } },
      }),
    );
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(false);
  });

  test("not met when improvement exists in last N", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 3,
      },
    };
    // 5 contributions; the best (lowest) score is at position 3 (within last 3)
    const contributions = [
      makeUniqueContribution({
        scores: { val_bpb: { value: 1.0, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.98, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.99, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.95, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.97, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(false);
  });

  test("met when no improvement in last N contributions", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 3,
      },
    };
    // Best score at position 0 (outside the last 3 window)
    const contributions = [
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.95, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.96, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.97, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.98, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(true);
  });

  test("met when last N tie the best but did not set a new best (tie case)", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 2,
      },
    };
    // Best score 0.90 at position 0; positions 2 and 3 tie at 0.90 but the
    // algorithm tracks the *first* occurrence of the best — index 0 is outside
    // the last 2, so it's met.
    const contributions = [
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.95, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(true);
  });

  test("not met when no metrics defined", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        maxRoundsWithoutImprovement: 3,
      },
    };
    const contributions = Array.from({ length: 5 }, () => makeUniqueContribution());
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(false);
  });

  test("exploration contributions count as rounds but not improvements", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 3,
      },
    };
    // Best eval at position 0, then 3 exploration contributions (no scores)
    const contributions = [
      makeUniqueContribution({
        mode: ContributionMode.Evaluation,
        scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({ mode: ContributionMode.Exploration }),
      makeUniqueContribution({ mode: ContributionMode.Exploration }),
      makeUniqueContribution({ mode: ContributionMode.Exploration }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    // 4 contributions >= maxRounds=3, best at index 0, cutoff = 4-3 = 1, 0 < 1 → met
    expect(result.stopped).toBe(true);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(true);
  });

  // -- Issue 11B: exploration mode mixed tests --

  test("exploration contributions interspersed do not reset improvement window", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 2,
      },
    };
    // Best eval at position 0 (score 0.90), then 2 exploration, then 1 eval with worse score.
    // 4 contributions total, maxRounds=2, cutoff = 4-2 = 2, best at index 0, 0 >= 2 is false → met
    const contributions = [
      makeUniqueContribution({
        mode: ContributionMode.Evaluation,
        scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({ mode: ContributionMode.Exploration }),
      makeUniqueContribution({ mode: ContributionMode.Exploration }),
      makeUniqueContribution({
        mode: ContributionMode.Evaluation,
        scores: { val_bpb: { value: 0.95, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(true);
  });

  test("recent eval improvement still detected despite exploration padding", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 3,
      },
    };
    // 3 eval contributions with steadily improving scores, then 2 exploration.
    // Total: 5 contributions. Best eval at index 2 (score 0.85), cutoff = 5-3 = 2, 2 >= 2 → not met
    const contributions = [
      makeUniqueContribution({
        mode: ContributionMode.Evaluation,
        scores: { val_bpb: { value: 0.95, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        mode: ContributionMode.Evaluation,
        scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        mode: ContributionMode.Evaluation,
        scores: { val_bpb: { value: 0.85, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({ mode: ContributionMode.Exploration }),
      makeUniqueContribution({ mode: ContributionMode.Exploration }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 2: target_metric
// ---------------------------------------------------------------------------

describe("target_metric", () => {
  test("met when minimize metric reaches target", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.95 },
      },
    };
    const contributions = [
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.94, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.target_metric?.met).toBe(true);
  });

  test("met when maximize metric reaches target", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        accuracy: { direction: ScoreDirection.Maximize },
      },
      stopConditions: {
        targetMetric: { metric: "accuracy", value: 0.9 },
      },
    };
    const contributions = [
      makeUniqueContribution({
        scores: { accuracy: { value: 0.92, direction: ScoreDirection.Maximize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.target_metric?.met).toBe(true);
  });

  test("not met when score has not reached target", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.9 },
      },
    };
    const contributions = [
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.95, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.target_metric?.met).toBe(false);
  });

  test("not met when metric has no scores", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.95 },
      },
    };
    // Contribution without scores for the target metric
    const contributions = [makeUniqueContribution()];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.target_metric?.met).toBe(false);
  });

  test("not met when metric is not defined in contract", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        accuracy: { direction: ScoreDirection.Maximize },
      },
      stopConditions: {
        targetMetric: { metric: "nonexistent_metric", value: 0.95 },
      },
    };
    const contributions = [
      makeUniqueContribution({
        scores: { accuracy: { value: 0.99, direction: ScoreDirection.Maximize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.target_metric?.met).toBe(false);
  });

  test("met when score exactly equals target (boundary)", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.95 },
      },
    };
    const contributions = [
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.95, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.target_metric?.met).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 3: budget
// ---------------------------------------------------------------------------

describe("budget", () => {
  test("met when contribution count exceeds limit", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        budget: { maxContributions: 5 },
      },
    };
    const contributions = Array.from({ length: 7 }, () => makeUniqueContribution());
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.budget?.met).toBe(true);
  });

  test("not met when contribution count is below limit", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        budget: { maxContributions: 10 },
      },
    };
    const contributions = Array.from({ length: 5 }, () => makeUniqueContribution());
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.budget?.met).toBe(false);
  });

  test("not met when grove is empty", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        budget: { maxContributions: 10 },
      },
    };
    const store = new InMemoryContributionStore();
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.budget?.met).toBe(false);
  });

  test("met when contribution count exactly equals limit (boundary)", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        budget: { maxContributions: 5 },
      },
    };
    const contributions = Array.from({ length: 5 }, () => makeUniqueContribution());
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.budget?.met).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 4: quorum_review_score
// ---------------------------------------------------------------------------

describe("quorum_review_score", () => {
  test("met when a contribution has enough reviews above threshold", async () => {
    const target = makeUniqueContribution({ summary: "Target work" });
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
      name: "test-grove",
      stopConditions: {
        quorumReviewScore: { minReviews: 2, minScore: 0.8 },
      },
    };
    const store = new InMemoryContributionStore([target, review1, review2]);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.quorum_review_score?.met).toBe(true);
  });

  test("not met when reviews exist but average below threshold", async () => {
    const target = makeUniqueContribution({ summary: "Target work" });
    const review1 = makeUniqueContribution({
      kind: ContributionKind.Review,
      summary: "Review 1",
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
      summary: "Review 2",
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
      name: "test-grove",
      stopConditions: {
        quorumReviewScore: { minReviews: 2, minScore: 0.8 },
      },
    };
    const store = new InMemoryContributionStore([target, review1, review2]);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.quorum_review_score?.met).toBe(false);
  });

  test("not met when reviews exist but count below threshold", async () => {
    const target = makeUniqueContribution({ summary: "Target work" });
    const review1 = makeUniqueContribution({
      kind: ContributionKind.Review,
      summary: "Review 1",
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
      name: "test-grove",
      stopConditions: {
        quorumReviewScore: { minReviews: 3, minScore: 0.8 },
      },
    };
    const store = new InMemoryContributionStore([target, review1]);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.quorum_review_score?.met).toBe(false);
  });

  test("reviews without scores count toward count but not average", async () => {
    const target = makeUniqueContribution({ summary: "Target work" });
    // Review 1 has a score
    const review1 = makeUniqueContribution({
      kind: ContributionKind.Review,
      summary: "Review 1 - scored",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reviews,
          metadata: { score: 0.9 },
        },
      ],
    });
    // Review 2 has no score metadata
    const review2 = makeUniqueContribution({
      kind: ContributionKind.Review,
      summary: "Review 2 - unscored",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reviews,
        },
      ],
    });

    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        quorumReviewScore: { minReviews: 2, minScore: 0.8 },
      },
    };
    const store = new InMemoryContributionStore([target, review1, review2]);
    const result = await evaluateStopConditions(contract, store);
    // 2 total reviews >= minReviews=2, average of scored reviews = 0.9 >= 0.8 → met
    expect(result.stopped).toBe(true);
    expect(result.conditions.quorum_review_score?.met).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 5: deliberation_limit
// ---------------------------------------------------------------------------

describe("deliberation_limit", () => {
  test("met when thread depth exceeds max_rounds", async () => {
    // root → reply1 → reply2 → reply3 (depth=3)
    const root = makeUniqueContribution({ summary: "Root discussion" });
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
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxRounds: 3 },
      },
    };
    const store = new InMemoryContributionStore([root, reply1, reply2, reply3]);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.deliberation_limit?.met).toBe(true);
  });

  test("not met when thread depth is below max_rounds", async () => {
    const root = makeUniqueContribution({ summary: "Root discussion" });
    const reply1 = makeUniqueContribution({
      kind: ContributionKind.Discussion,
      summary: "Reply 1",
      relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
    });

    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxRounds: 5 },
      },
    };
    const store = new InMemoryContributionStore([root, reply1]);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.deliberation_limit?.met).toBe(false);
  });

  test("met when message count exceeds max_messages", async () => {
    // root + 5 direct replies → messageCount = 5
    const root = makeUniqueContribution({ summary: "Root discussion" });
    const replies = Array.from({ length: 5 }, (_, i) =>
      makeUniqueContribution({
        kind: ContributionKind.Discussion,
        summary: `Reply ${i + 1}`,
        relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
      }),
    );

    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxMessages: 3 },
      },
    };
    const store = new InMemoryContributionStore([root, ...replies]);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.deliberation_limit?.met).toBe(true);
  });

  test("maxMessages on deep chain is not truncated by maxRounds", async () => {
    // 60-deep chain, maxMessages=55. Even without maxRounds constraint,
    // we should detect the message count.
    const chain: Contribution[] = [];
    const root = makeUniqueContribution({ summary: "Deep root" });
    chain.push(root);
    let prevCid = root.cid;
    for (let i = 0; i < 59; i++) {
      const reply = makeUniqueContribution({
        kind: ContributionKind.Discussion,
        summary: `Deep reply ${i + 1}`,
        relations: [{ targetCid: prevCid, relationType: RelationType.RespondsTo }],
      });
      chain.push(reply);
      prevCid = reply.cid;
    }

    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxMessages: 55 },
      },
    };
    const store = new InMemoryContributionStore(chain);
    const result = await evaluateStopConditions(contract, store);
    // messageCount = 59 (excluding root) >= 55 → met
    expect(result.stopped).toBe(true);
    expect(result.conditions.deliberation_limit?.met).toBe(true);
  });

  test("not met when no discussion threads exist", async () => {
    // Contributions with no responds_to relations → no topic roots
    const contributions = Array.from({ length: 3 }, () => makeUniqueContribution());

    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxRounds: 3 },
      },
    };
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.deliberation_limit?.met).toBe(false);
  });

  // -- Issue 12A: deliberation edge cases --

  test("dangling responds_to reference is excluded from roots", async () => {
    // Contribution A has responds_to pointing at CID "nonexistent" (not in store).
    // findTopicRoots should exclude "nonexistent" from roots because it's not in allCids.
    const contribA = makeUniqueContribution({
      kind: ContributionKind.Discussion,
      summary: "Dangling reference",
      relations: [
        {
          targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
          relationType: RelationType.RespondsTo,
        },
      ],
    });

    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxRounds: 1 },
      },
    };
    const store = new InMemoryContributionStore([contribA]);
    const result = await evaluateStopConditions(contract, store);
    // No valid roots found → not met
    expect(result.stopped).toBe(false);
    expect(result.conditions.deliberation_limit?.met).toBe(false);
  });

  test("empty grove with deliberation limit → not met", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxRounds: 3, maxMessages: 10 },
      },
    };
    const store = new InMemoryContributionStore();
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.deliberation_limit?.met).toBe(false);
  });

  test("thread depth exactly at maxRounds-1 is not met", async () => {
    // Root + 2 replies (depth=2), maxRounds=3 → depth 2 < 3 → not met
    const root = makeUniqueContribution({ summary: "Root" });
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

    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxRounds: 3 },
      },
    };
    const store = new InMemoryContributionStore([root, reply1, reply2]);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
    expect(result.conditions.deliberation_limit?.met).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 6: multiple conditions
// ---------------------------------------------------------------------------

describe("multiple conditions", () => {
  test("stopped=true when any single condition is met", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 100,
        budget: { maxContributions: 3 },
      },
    };
    // Budget condition is met (4 >= 3) but maxRoundsWithoutImprovement is not (4 < 100)
    const contributions = Array.from({ length: 4 }, () =>
      makeUniqueContribution({
        scores: { val_bpb: { value: 1.0, direction: ScoreDirection.Minimize } },
      }),
    );
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.budget?.met).toBe(true);
    expect(result.conditions.max_rounds_without_improvement?.met).toBe(false);
  });

  test("stopped=false when no conditions are met", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 100,
        budget: { maxContributions: 100 },
        targetMetric: { metric: "val_bpb", value: 0.5 },
      },
    };
    const contributions = Array.from({ length: 3 }, (_, i) =>
      makeUniqueContribution({
        scores: { val_bpb: { value: 1.0 - i * 0.01, direction: ScoreDirection.Minimize } },
      }),
    );
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(false);
  });

  test("reports which conditions are met", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        budget: { maxContributions: 3 },
        targetMetric: { metric: "val_bpb", value: 0.95 },
      },
    };
    // Both budget (3 >= 3) and target_metric (0.94 <= 0.95) are met
    const contributions = [
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.94, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.96, direction: ScoreDirection.Minimize } },
      }),
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.97, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);
    const result = await evaluateStopConditions(contract, store);
    expect(result.stopped).toBe(true);
    expect(result.conditions.budget?.met).toBe(true);
    expect(result.conditions.target_metric?.met).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 7: all conditions not met on empty grove
// ---------------------------------------------------------------------------

describe("all conditions not met on empty grove", () => {
  test("all five conditions configured on empty store", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        maxRoundsWithoutImprovement: 5,
        targetMetric: { metric: "val_bpb", value: 0.95 },
        budget: { maxContributions: 10 },
        quorumReviewScore: { minReviews: 2, minScore: 0.8 },
        deliberationLimit: { maxRounds: 3 },
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

// ---------------------------------------------------------------------------
// Section 8 & 9: Issue 11B and 12A tests are above in their respective sections
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Section 10: Issue 9A — cross-path agreement tests
// ---------------------------------------------------------------------------

describe("cross-path agreement: evaluateStopConditions vs PolicyEnforcer.enforce()", () => {
  function makeEnforceContribution(): Contribution {
    return {
      cid: `blake3:${"f".repeat(64)}`,
      manifestVersion: 1,
      kind: "work",
      mode: "evaluation",
      summary: "Test",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "test-agent" },
      createdAt: new Date().toISOString(),
    };
  }

  test("budget agreement: both paths agree when budget is exceeded", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        budget: { maxContributions: 10 },
      },
    };
    const contributions = Array.from({ length: 10 }, () => makeUniqueContribution());
    const store = new InMemoryContributionStore(contributions);

    // Canonical path
    const canonical = await evaluateStopConditions(contract, store);
    expect(canonical.stopped).toBe(true);

    // PolicyEnforcer path
    const enforcer = new PolicyEnforcer(contract, store);
    const enforceResult = await enforcer.enforce(makeEnforceContribution());
    expect(enforceResult.stopResult?.stopped).toBe(true);
  });

  test("budget agreement: both paths agree when budget is not exceeded", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        budget: { maxContributions: 100 },
      },
    };
    const contributions = Array.from({ length: 5 }, () => makeUniqueContribution());
    const store = new InMemoryContributionStore(contributions);

    // Canonical path
    const canonical = await evaluateStopConditions(contract, store);
    expect(canonical.stopped).toBe(false);

    // PolicyEnforcer path
    const enforcer = new PolicyEnforcer(contract, store);
    const enforceResult = await enforcer.enforce(makeEnforceContribution());
    expect(enforceResult.stopResult?.stopped).toBe(false);
  });

  test("target metric agreement: both paths agree when target is reached", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      metrics: {
        val_bpb: { direction: ScoreDirection.Minimize },
      },
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.95 },
      },
    };
    const contributions = [
      makeUniqueContribution({
        scores: { val_bpb: { value: 0.94, direction: ScoreDirection.Minimize } },
      }),
    ];
    const store = new InMemoryContributionStore(contributions);

    // Canonical path
    const canonical = await evaluateStopConditions(contract, store);
    expect(canonical.stopped).toBe(true);

    // PolicyEnforcer path
    const enforcer = new PolicyEnforcer(contract, store);
    const enforceResult = await enforcer.enforce(makeEnforceContribution());
    expect(enforceResult.stopResult?.stopped).toBe(true);
  });

  test("quorum divergence: enforcer skips quorum on pre-write path (#232)", async () => {
    const target = makeUniqueContribution({ summary: "Quorum target" });
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
      name: "test-grove",
      stopConditions: {
        quorumReviewScore: { minReviews: 2, minScore: 0.8 },
      },
    };
    const store = new InMemoryContributionStore([target, review1, review2]);

    // Canonical path (full) still detects quorum
    const canonical = await evaluateStopConditions(contract, store);
    expect(canonical.stopped).toBe(true);

    // PolicyEnforcer path — pre-write skips scanning evaluators (quorum/
    // deliberation) for mutex-cost reasons (#232). Post-write recheck in
    // contributeOperation catches these; enforcer alone reports not stopped.
    const enforcer = new PolicyEnforcer(contract, store);
    const enforceResult = await enforcer.enforce(makeEnforceContribution());
    expect(enforceResult.stopResult?.stopped).toBe(false);
  });

  test("deliberation divergence: enforcer skips deliberation on pre-write path (#232)", async () => {
    // root → reply1 → reply2 → reply3 (depth=3), maxRounds=3
    const root = makeUniqueContribution({ summary: "Deliberation root" });
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
      name: "test-grove",
      stopConditions: {
        deliberationLimit: { maxRounds: 3 },
      },
    };
    const store = new InMemoryContributionStore([root, reply1, reply2, reply3]);

    // Canonical path
    const canonical = await evaluateStopConditions(contract, store);
    expect(canonical.stopped).toBe(true);

    // PolicyEnforcer path — pre-write skips scanning evaluators (quorum/
    // deliberation) for mutex-cost reasons (#232). Post-write recheck in
    // contributeOperation catches these; enforcer alone reports not stopped.
    const enforcer = new PolicyEnforcer(contract, store);
    const enforceResult = await enforcer.enforce(makeEnforceContribution());
    expect(enforceResult.stopResult?.stopped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 11: Issue #232 — skipExpensive option for pre-write pipeline
// ---------------------------------------------------------------------------

describe("skipExpensive option", () => {
  test("omits quorum_review_score when skipExpensive=true", async () => {
    const target = makeUniqueContribution({ summary: "target" });
    const review1 = makeUniqueContribution({
      kind: ContributionKind.Review,
      relations: [
        { targetCid: target.cid, relationType: RelationType.Reviews, metadata: { score: 0.9 } },
      ],
    });
    const review2 = makeUniqueContribution({
      kind: ContributionKind.Review,
      relations: [
        { targetCid: target.cid, relationType: RelationType.Reviews, metadata: { score: 0.95 } },
      ],
    });
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: { quorumReviewScore: { minReviews: 2, minScore: 0.8 } },
    };
    const store = new InMemoryContributionStore([target, review1, review2]);

    const full = await evaluateStopConditions(contract, store);
    expect(full.stopped).toBe(true);
    expect(full.conditions.quorum_review_score).toBeDefined();

    const cheap = await evaluateStopConditions(contract, store, { skipExpensive: true });
    expect(cheap.stopped).toBe(false);
    expect(cheap.conditions.quorum_review_score).toBeUndefined();
  });

  test("omits deliberation_limit when skipExpensive=true", async () => {
    const root = makeUniqueContribution({ summary: "root" });
    const r1 = makeUniqueContribution({
      kind: ContributionKind.Discussion,
      relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
    });
    const r2 = makeUniqueContribution({
      kind: ContributionKind.Discussion,
      relations: [{ targetCid: r1.cid, relationType: RelationType.RespondsTo }],
    });
    const r3 = makeUniqueContribution({
      kind: ContributionKind.Discussion,
      relations: [{ targetCid: r2.cid, relationType: RelationType.RespondsTo }],
    });
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: { deliberationLimit: { maxRounds: 3 } },
    };
    const store = new InMemoryContributionStore([root, r1, r2, r3]);

    const full = await evaluateStopConditions(contract, store);
    expect(full.stopped).toBe(true);
    expect(full.conditions.deliberation_limit).toBeDefined();

    const cheap = await evaluateStopConditions(contract, store, { skipExpensive: true });
    expect(cheap.stopped).toBe(false);
    expect(cheap.conditions.deliberation_limit).toBeUndefined();
  });

  test("skipExpensive still evaluates cheap conditions", async () => {
    const contributions = Array.from({ length: 10 }, () => makeUniqueContribution());
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: {
        budget: { maxContributions: 10 },
        quorumReviewScore: { minReviews: 2, minScore: 0.8 },
      },
    };
    const store = new InMemoryContributionStore(contributions);

    const cheap = await evaluateStopConditions(contract, store, { skipExpensive: true });
    expect(cheap.stopped).toBe(true);
    expect(cheap.conditions.budget?.met).toBe(true);
    expect(cheap.conditions.quorum_review_score).toBeUndefined();
  });

  test("skipExpensive avoids store.list() when only expensive conditions configured", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "test-grove",
      stopConditions: { quorumReviewScore: { minReviews: 2, minScore: 0.8 } },
    };
    let listCalls = 0;
    const base = new InMemoryContributionStore([]);
    const tracking: typeof base = {
      ...base,
      list: async (...args: Parameters<typeof base.list>) => {
        listCalls += 1;
        return base.list(...args);
      },
      thread: base.thread.bind(base),
      count: base.count.bind(base),
    } as unknown as typeof base;

    const result = await evaluateStopConditions(contract, tracking, { skipExpensive: true });
    expect(result.stopped).toBe(false);
    expect(listCalls).toBe(0);
  });
});
