import { describe, expect, test } from "bun:test";
import { AdmissionRejectError } from "./admission/errors.js";
import {
  computeBackoffMs,
  defaultFailureClassifier,
  normalizeBatchStrategy,
  RuntimeUnavailableError,
} from "./slow-start-batch.js";

describe("normalizeBatchStrategy", () => {
  test("applies defaults for empty input", () => {
    const s = normalizeBatchStrategy();
    expect(s.initialBatchSize).toBe(1);
    expect(s.multiplier).toBe(2);
    expect(s.maxBatchSize).toBe(Number.POSITIVE_INFINITY);
    expect(s.backoff).toEqual({ baseMs: 1000, multiplier: 2, maxMs: 30_000 });
  });

  test("passes through provided values", () => {
    const s = normalizeBatchStrategy({
      initialBatchSize: 2,
      multiplier: 3,
      maxBatchSize: 16,
      backoff: { baseMs: 500, multiplier: 4, maxMs: 5000 },
    });
    expect(s.initialBatchSize).toBe(2);
    expect(s.multiplier).toBe(3);
    expect(s.maxBatchSize).toBe(16);
    expect(s.backoff).toEqual({ baseMs: 500, multiplier: 4, maxMs: 5000 });
  });

  test("rejects invalid input with RangeError", () => {
    expect(() => normalizeBatchStrategy({ initialBatchSize: 0 })).toThrow(RangeError);
    expect(() => normalizeBatchStrategy({ initialBatchSize: 1.5 })).toThrow(RangeError);
    expect(() => normalizeBatchStrategy({ multiplier: 0.5 })).toThrow(RangeError);
    expect(() => normalizeBatchStrategy({ maxBatchSize: 4, initialBatchSize: 8 })).toThrow(
      RangeError,
    );
    expect(() => normalizeBatchStrategy({ backoff: { baseMs: 0 } })).toThrow(RangeError);
    expect(() => normalizeBatchStrategy({ backoff: { maxMs: 0 } })).toThrow(RangeError);
    expect(() => normalizeBatchStrategy({ backoff: { maxMs: 100, baseMs: 1000 } })).toThrow(
      RangeError,
    );
  });

  test("accepts multiplier=1 (fixed-size batches / constant backoff are valid configs)", () => {
    const s = normalizeBatchStrategy({ multiplier: 1, backoff: { multiplier: 1 } });
    expect(s.multiplier).toBe(1);
    expect(s.backoff.multiplier).toBe(1);
  });
});

describe("computeBackoffMs", () => {
  const backoff = { baseMs: 1000, multiplier: 2, maxMs: 30_000 } as const;

  test("attempt 0 returns baseMs", () => {
    expect(computeBackoffMs(0, backoff)).toBe(1000);
  });

  test("grows geometrically", () => {
    expect(computeBackoffMs(1, backoff)).toBe(2000);
    expect(computeBackoffMs(2, backoff)).toBe(4000);
    expect(computeBackoffMs(3, backoff)).toBe(8000);
  });

  test("clamps to maxMs", () => {
    expect(computeBackoffMs(10, backoff)).toBe(30_000);
  });

  test("guards non-positive / non-finite attempts to baseMs", () => {
    expect(computeBackoffMs(-5, backoff)).toBe(1000);
    expect(computeBackoffMs(Number.NaN, backoff)).toBe(1000);
  });
});

describe("defaultFailureClassifier", () => {
  test("classifies AdmissionRejectError as admission", () => {
    const err = new AdmissionRejectError({
      ruleName: "max-fanout",
      ruleType: "shell",
      reason: "capacity exhausted",
    });
    expect(defaultFailureClassifier(err)).toBe("admission");
  });

  test("classifies RuntimeUnavailableError as backpressure", () => {
    expect(defaultFailureClassifier(new RuntimeUnavailableError("runtime down"))).toBe(
      "backpressure",
    );
  });

  test("classifies anything else as task", () => {
    expect(defaultFailureClassifier(new Error("bad prompt"))).toBe("task");
    expect(defaultFailureClassifier("oops")).toBe("task");
  });

  test("RuntimeUnavailableError carries a reason", () => {
    const err = new RuntimeUnavailableError("runtime down", { reason: "provider-pressure" });
    expect(err.reason).toBe("provider-pressure");
    expect(err).toBeInstanceOf(Error);
  });
});
