import { describe, expect, test } from "bun:test";
import { getScore } from "./frontier.js";
import type { Contribution } from "./models.js";
import { ContributionKind, ContributionMode, ScoreDirection } from "./models.js";

describe("getScore", () => {
  const contribution: Contribution = {
    cid: "blake3:test",
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "test",
    artifacts: {},
    relations: [],
    scores: {
      val_bpb: { value: 0.97, direction: ScoreDirection.Minimize },
      throughput: { value: 14800, direction: ScoreDirection.Maximize, unit: "ops/sec" },
    },
    tags: [],
    agent: { agentId: "test" },
    createdAt: "2026-01-01T00:00:00Z",
  };

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
    const noScores: Contribution = {
      ...contribution,
      scores: undefined,
    };
    const score = getScore(noScores, "val_bpb");
    expect(score).toBeUndefined();
  });
});
