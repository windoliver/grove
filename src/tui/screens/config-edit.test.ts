import { describe, expect, test } from "bun:test";
import type { GroveContract } from "../../core/contract.js";
import { getEditableFields, setNumericField, toggleMode } from "./config-edit.js";

const FULL: GroveContract = {
  contractVersion: 2,
  name: "test",
  mode: "evaluation",
  metrics: { latency: { direction: "minimize", gate: 100 } },
  gates: [{ type: "min_score", metric: "latency", threshold: 0.8 }],
  stopConditions: {
    maxRoundsWithoutImprovement: 5,
    targetMetric: { metric: "latency", value: 50 },
    budget: { maxContributions: 200, maxWallClockSeconds: 3600 },
  },
  concurrency: { maxActiveClaims: 4, maxClaimsPerAgent: 2 },
};

describe("getEditableFields", () => {
  test("lists mode + stop + concurrency fields with targetMetric when present", () => {
    const ids = getEditableFields(FULL).map((f) => f.id);
    expect(ids).toEqual([
      "mode",
      "stop.maxRoundsWithoutImprovement",
      "stop.targetMetric.value",
      "stop.budget.maxContributions",
      "stop.budget.maxWallClockSeconds",
      "concurrency.maxActiveClaims",
      "concurrency.maxClaimsPerAgent",
    ]);
  });

  test("omits targetMetric.value when no target metric is defined", () => {
    const noTarget: GroveContract = { ...FULL, stopConditions: { maxRoundsWithoutImprovement: 5 } };
    const ids = getEditableFields(noTarget).map((f) => f.id);
    expect(ids).not.toContain("stop.targetMetric.value");
  });

  test("shows (unset) for absent optional numerics", () => {
    const bare: GroveContract = { contractVersion: 2, name: "bare" };
    const fields = getEditableFields(bare);
    const rounds = fields.find((f) => f.id === "stop.maxRoundsWithoutImprovement");
    expect(rounds?.display).toBe("(unset)");
  });
});

describe("toggleMode", () => {
  test("evaluation -> exploration", () => {
    expect(toggleMode(FULL).mode).toBe("exploration");
  });
  test("exploration -> evaluation", () => {
    expect(toggleMode({ ...FULL, mode: "exploration" }).mode).toBe("evaluation");
  });
  test("undefined -> evaluation", () => {
    expect(toggleMode({ contractVersion: 2, name: "x" }).mode).toBe("evaluation");
  });
});

describe("setNumericField", () => {
  test("sets a valid concurrency value", () => {
    const { config, error } = setNumericField(FULL, "concurrency.maxActiveClaims", "7");
    expect(error).toBeUndefined();
    expect(config.concurrency?.maxActiveClaims).toBe(7);
  });

  test("rejects out-of-range maxClaimsPerAgent", () => {
    const { config, error } = setNumericField(FULL, "concurrency.maxClaimsPerAgent", "200");
    expect(error).toContain("≤ 100");
    expect(config).toBe(FULL); // unchanged reference on error
  });

  test("rejects non-integer for an integer field", () => {
    const { error } = setNumericField(FULL, "stop.maxRoundsWithoutImprovement", "1.5");
    expect(error).toContain("whole number");
  });

  test("empty unsets an optional field and prunes its empty parent", () => {
    const { config } = setNumericField(
      { contractVersion: 2, name: "x", concurrency: { maxActiveClaims: 4 } },
      "concurrency.maxActiveClaims",
      "",
    );
    expect(config.concurrency).toBeUndefined();
  });

  test("clearing one budget field keeps the other", () => {
    const { config } = setNumericField(FULL, "stop.budget.maxContributions", "");
    expect(config.stopConditions?.budget).toEqual({ maxWallClockSeconds: 3600 });
  });

  test("clearing the last budget field drops the budget object", () => {
    const oneBudget: GroveContract = {
      ...FULL,
      stopConditions: { budget: { maxContributions: 200 } },
    };
    const { config } = setNumericField(oneBudget, "stop.budget.maxContributions", "");
    expect(config.stopConditions?.budget).toBeUndefined();
  });

  test("targetMetric.value is required — empty is an error", () => {
    const { error } = setNumericField(FULL, "stop.targetMetric.value", "");
    expect(error).toContain("required");
  });

  test("targetMetric.value accepts a float and preserves the metric name", () => {
    const { config } = setNumericField(FULL, "stop.targetMetric.value", "12.5");
    expect(config.stopConditions?.targetMetric).toEqual({ metric: "latency", value: 12.5 });
  });

  test("rejects a non-finite targetMetric.value", () => {
    const { config, error } = setNumericField(FULL, "stop.targetMetric.value", "Infinity");
    expect(error).toBeDefined();
    expect(config).toBe(FULL);
  });

  test("does not mutate the input contract", () => {
    const snapshot = JSON.parse(JSON.stringify(FULL));
    setNumericField(FULL, "concurrency.maxActiveClaims", "9");
    expect(FULL).toEqual(snapshot);
  });
});
