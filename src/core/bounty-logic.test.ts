/**
 * Unit tests for bounty validation and state transition logic.
 */

import { describe, expect, test } from "bun:test";

import { BountyStatus, RewardType } from "./bounty.js";
import {
  computeRewardId,
  evaluateBountyCriteria,
  isBountyExpired,
  isBountyTerminal,
  validateBountyInput,
  validateBountyTransition,
} from "./bounty-logic.js";
import { BountyStateError } from "./bounty-errors.js";
import { makeBounty, makeContribution, makeScore } from "./test-helpers.js";
import { ScoreDirection } from "./models.js";

// ---------------------------------------------------------------------------
// validateBountyTransition
// ---------------------------------------------------------------------------

describe("validateBountyTransition", () => {
  test("allows draft → open", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Draft, BountyStatus.Open, "fund"),
    ).not.toThrow();
  });

  test("allows open → claimed", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Open, BountyStatus.Claimed, "claim"),
    ).not.toThrow();
  });

  test("allows claimed → completed", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Claimed, BountyStatus.Completed, "complete"),
    ).not.toThrow();
  });

  test("allows completed → settled", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Completed, BountyStatus.Settled, "settle"),
    ).not.toThrow();
  });

  test("allows open → expired", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Open, BountyStatus.Expired, "expire"),
    ).not.toThrow();
  });

  test("allows open → cancelled", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Open, BountyStatus.Cancelled, "cancel"),
    ).not.toThrow();
  });

  test("allows claimed → open (unclaim / release)", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Claimed, BountyStatus.Open, "release"),
    ).not.toThrow();
  });

  test("rejects settled → open", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Settled, BountyStatus.Open, "reopen"),
    ).toThrow(BountyStateError);
  });

  test("rejects expired → open", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Expired, BountyStatus.Open, "reopen"),
    ).toThrow(BountyStateError);
  });

  test("rejects cancelled → open", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Cancelled, BountyStatus.Open, "reopen"),
    ).toThrow(BountyStateError);
  });

  test("rejects draft → settled (skipping steps)", () => {
    expect(() =>
      validateBountyTransition("b-1", BountyStatus.Draft, BountyStatus.Settled, "settle"),
    ).toThrow(BountyStateError);
  });
});

// ---------------------------------------------------------------------------
// isBountyTerminal
// ---------------------------------------------------------------------------

describe("isBountyTerminal", () => {
  test("settled is terminal", () => {
    expect(isBountyTerminal(BountyStatus.Settled)).toBe(true);
  });

  test("expired is terminal", () => {
    expect(isBountyTerminal(BountyStatus.Expired)).toBe(true);
  });

  test("cancelled is terminal", () => {
    expect(isBountyTerminal(BountyStatus.Cancelled)).toBe(true);
  });

  test("open is not terminal", () => {
    expect(isBountyTerminal(BountyStatus.Open)).toBe(false);
  });

  test("claimed is not terminal", () => {
    expect(isBountyTerminal(BountyStatus.Claimed)).toBe(false);
  });

  test("draft is not terminal", () => {
    expect(isBountyTerminal(BountyStatus.Draft)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateBountyInput
// ---------------------------------------------------------------------------

describe("validateBountyInput", () => {
  test("accepts valid bounty", () => {
    expect(() => validateBountyInput(makeBounty())).not.toThrow();
  });

  test("rejects empty bountyId", () => {
    expect(() => validateBountyInput(makeBounty({ bountyId: "" }))).toThrow(/ID/);
  });

  test("rejects empty title", () => {
    expect(() => validateBountyInput(makeBounty({ title: "" }))).toThrow(/title/);
  });

  test("rejects zero amount", () => {
    expect(() => validateBountyInput(makeBounty({ amount: 0 }))).toThrow(/positive/);
  });

  test("rejects negative amount", () => {
    expect(() => validateBountyInput(makeBounty({ amount: -10 }))).toThrow(/positive/);
  });

  test("rejects fractional amount", () => {
    expect(() => validateBountyInput(makeBounty({ amount: 10.5 }))).toThrow(/integer/);
  });

  test("rejects missing deadline", () => {
    expect(() => validateBountyInput(makeBounty({ deadline: "" }))).toThrow(/deadline/);
  });

  test("rejects invalid deadline format", () => {
    expect(() => validateBountyInput(makeBounty({ deadline: "not-a-date" }))).toThrow(/deadline/i);
  });

  test("rejects missing creator agentId", () => {
    expect(() =>
      validateBountyInput(makeBounty({ creator: { agentId: "" } })),
    ).toThrow(/agent/i);
  });
});

// ---------------------------------------------------------------------------
// evaluateBountyCriteria
// ---------------------------------------------------------------------------

describe("evaluateBountyCriteria", () => {
  test("empty criteria matches any contribution", () => {
    const result = evaluateBountyCriteria(
      { description: "Any work" },
      makeContribution(),
    );
    expect(result).toBe(true);
  });

  test("required tags: matches when all present", () => {
    const result = evaluateBountyCriteria(
      { description: "Tagged work", requiredTags: ["ml", "nlp"] },
      makeContribution({ tags: ["ml", "nlp", "extra"] }),
    );
    expect(result).toBe(true);
  });

  test("required tags: fails when tag missing", () => {
    const result = evaluateBountyCriteria(
      { description: "Tagged work", requiredTags: ["ml", "nlp"] },
      makeContribution({ tags: ["ml"] }),
    );
    expect(result).toBe(false);
  });

  test("metric threshold (minimize): passes when below", () => {
    const result = evaluateBountyCriteria(
      {
        description: "Improve metric",
        metricName: "val_bpb",
        metricThreshold: 0.96,
        metricDirection: "minimize",
      },
      makeContribution({
        scores: { val_bpb: makeScore({ value: 0.94, direction: ScoreDirection.Minimize }) },
      }),
    );
    expect(result).toBe(true);
  });

  test("metric threshold (minimize): fails when above", () => {
    const result = evaluateBountyCriteria(
      {
        description: "Improve metric",
        metricName: "val_bpb",
        metricThreshold: 0.96,
        metricDirection: "minimize",
      },
      makeContribution({
        scores: { val_bpb: makeScore({ value: 0.98, direction: ScoreDirection.Minimize }) },
      }),
    );
    expect(result).toBe(false);
  });

  test("metric threshold (maximize): passes when above", () => {
    const result = evaluateBountyCriteria(
      {
        description: "Improve accuracy",
        metricName: "accuracy",
        metricThreshold: 0.95,
        metricDirection: "maximize",
      },
      makeContribution({
        scores: { accuracy: makeScore({ value: 0.97, direction: ScoreDirection.Maximize }) },
      }),
    );
    expect(result).toBe(true);
  });

  test("metric threshold: fails when score missing", () => {
    const result = evaluateBountyCriteria(
      {
        description: "Needs score",
        metricName: "val_bpb",
        metricThreshold: 0.96,
      },
      makeContribution({ scores: undefined }),
    );
    expect(result).toBe(false);
  });

  test("metric threshold: fails when named metric missing", () => {
    const result = evaluateBountyCriteria(
      {
        description: "Needs score",
        metricName: "val_bpb",
        metricThreshold: 0.96,
      },
      makeContribution({
        scores: { other_metric: makeScore({ value: 0.5 }) },
      }),
    );
    expect(result).toBe(false);
  });

  test("defaults to minimize when metricDirection not specified", () => {
    const result = evaluateBountyCriteria(
      {
        description: "Lower is better",
        metricName: "loss",
        metricThreshold: 0.5,
      },
      makeContribution({
        scores: { loss: makeScore({ value: 0.4, direction: ScoreDirection.Minimize }) },
      }),
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeRewardId
// ---------------------------------------------------------------------------

describe("computeRewardId", () => {
  test("generates deterministic ID", () => {
    const id1 = computeRewardId(RewardType.FrontierAdvance, "bounty-1", "cid-abc");
    const id2 = computeRewardId(RewardType.FrontierAdvance, "bounty-1", "cid-abc");
    expect(id1).toBe(id2);
  });

  test("different inputs produce different IDs", () => {
    const id1 = computeRewardId(RewardType.FrontierAdvance, "bounty-1", "cid-abc");
    const id2 = computeRewardId(RewardType.AdoptionBonus, "bounty-1", "cid-abc");
    expect(id1).not.toBe(id2);
  });

  test("format includes all components", () => {
    const id = computeRewardId(RewardType.ReviewReward, "src-1", "cid-xyz");
    expect(id).toBe("reward:review_reward:src-1:cid-xyz");
  });
});

// ---------------------------------------------------------------------------
// isBountyExpired
// ---------------------------------------------------------------------------

describe("isBountyExpired", () => {
  test("returns true when past deadline", () => {
    const bounty = makeBounty({
      deadline: new Date(Date.now() - 10_000).toISOString(),
    });
    expect(isBountyExpired(bounty)).toBe(true);
  });

  test("returns false when before deadline", () => {
    const bounty = makeBounty({
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(isBountyExpired(bounty)).toBe(false);
  });

  test("accepts injectable clock", () => {
    const bounty = makeBounty({
      deadline: "2026-06-01T00:00:00Z",
    });
    const beforeDeadline = new Date("2026-05-31T00:00:00Z");
    expect(isBountyExpired(bounty, beforeDeadline)).toBe(false);

    const afterDeadline = new Date("2026-06-02T00:00:00Z");
    expect(isBountyExpired(bounty, afterDeadline)).toBe(true);
  });
});
