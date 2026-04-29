import { describe, expect, test } from "bun:test";
import {
  DefaultFrontierCalculator,
  getScore,
  SessionAggregatingFrontierCalculator,
} from "./frontier.js";
import type { Contribution } from "./models.js";
import { ScoreDirection } from "./models.js";
import { makeContribution } from "./test-helpers.js";
import { InMemoryContributionStore } from "./testing.js";

describe("getScore", () => {
  const contribution = makeContribution({
    scores: {
      val_bpb: { value: 0.97, direction: ScoreDirection.Minimize },
      throughput: { value: 14800, direction: ScoreDirection.Maximize, unit: "ops/sec" },
    },
  });

  test("returns score for existing metric", () => {
    const score = getScore(contribution, "val_bpb");
    expect(score?.value).toBe(0.97);
    expect(score?.direction).toBe("minimize");
  });

  test("returns undefined for missing metric", () => {
    const score = getScore(contribution, "nonexistent");
    expect(score).toBeUndefined();
  });

  test("returns undefined when contribution has no scores", () => {
    const noScores = makeContribution();
    const score = getScore(noScores, "val_bpb");
    expect(score).toBeUndefined();
  });
});

describe("DefaultFrontierCalculator", () => {
  test("uses incomingSources when context-only filters reduce candidate set", async () => {
    const target = makeContribution({
      summary: "target",
      context: { hardware: "H100" },
    });
    const other = makeContribution({
      summary: "other",
      context: { hardware: "A100" },
    });
    const reviewer = makeContribution({
      kind: "review",
      summary: "reviewer",
      relations: [{ relationType: "reviews", targetCid: target.cid }],
      scores: {
        quality: { value: 0.9, direction: ScoreDirection.Maximize },
      },
    });
    const store = new InMemoryContributionStore([target, other, reviewer]);
    const originalIncoming = store.incomingSources;
    let incomingCalls = 0;
    let lastTargets: readonly string[] = [];
    store.incomingSources = async (
      targetCids: readonly string[],
    ): Promise<readonly Contribution[]> => {
      incomingCalls += 1;
      lastTargets = [...targetCids];
      return originalIncoming(targetCids);
    };

    const calculator = new DefaultFrontierCalculator(store);
    const frontier = await calculator.compute({ context: { hardware: "H100" } });

    expect(incomingCalls).toBe(1);
    expect(lastTargets).toEqual([target.cid]);
    expect(frontier.byReviewScore[0]?.cid).toBe(target.cid);
  });

  test("skips incomingSources when no filters are applied", async () => {
    const base = makeContribution({ summary: "base" });
    const store = new InMemoryContributionStore([base]);
    const originalIncoming = store.incomingSources;
    let incomingCalls = 0;
    store.incomingSources = async (
      targetCids: readonly string[],
    ): Promise<readonly Contribution[]> => {
      incomingCalls += 1;
      return originalIncoming(targetCids);
    };

    const calculator = new DefaultFrontierCalculator(store);
    await calculator.compute();

    expect(incomingCalls).toBe(0);
  });
});

describe("SessionAggregatingFrontierCalculator", () => {
  test("includes session-scoped stores in unscoped frontier results", async () => {
    const sessionOne = makeContribution({
      summary: "session one",
      scores: { quality: { value: 0.7, direction: ScoreDirection.Maximize } },
    });
    const sessionTwo = makeContribution({
      summary: "session two",
      scores: { quality: { value: 0.9, direction: ScoreDirection.Maximize } },
    });
    const stores = new Map([
      ["s1", new InMemoryContributionStore([sessionOne])],
      ["s2", new InMemoryContributionStore([sessionTwo])],
    ]);

    const calculator = new SessionAggregatingFrontierCalculator({
      rootStore: new InMemoryContributionStore(),
      listSessionIds: async () => ["s1", "s2"],
      storeForSession: (sessionId) => stores.get(sessionId) ?? new InMemoryContributionStore(),
    });

    const frontier = await calculator.compute();

    expect(frontier.byMetric.quality?.map((entry) => entry.cid)).toEqual([
      sessionTwo.cid,
      sessionOne.cid,
    ]);
  });
});
