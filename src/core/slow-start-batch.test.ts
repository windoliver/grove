import { describe, expect, test } from "bun:test";
import { AdmissionRejectError } from "./admission/errors.js";
import {
  computeBackoffMs,
  defaultFailureClassifier,
  normalizeBatchStrategy,
  RuntimeUnavailableError,
  type SpawnBatchMetric,
  slowStartBatch,
} from "./slow-start-batch.js";

const norm = normalizeBatchStrategy;

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

describe("slowStartBatch — success", () => {
  test("doubling sequence 1,2,4,8 over 15 items", async () => {
    const batches: number[][] = [];
    let current: number[] = [];
    const calls: number[] = [];
    const items = Array.from({ length: 15 }, (_, i) => i);
    const sizes: number[] = [];
    const result = await slowStartBatch(
      items,
      async (item) => {
        calls.push(item);
        current.push(item);
      },
      norm(),
      {
        onSpawnBatch: (m: SpawnBatchMetric) => {
          sizes.push(m.batchSize);
          batches.push(current);
          current = [];
        },
      },
    );
    expect(sizes).toEqual([1, 2, 4, 8]);
    expect(result.outcome).toBe("completed");
    expect(result.succeeded).toBe(15);
    expect(result.attempted).toBe(15);
    expect(result.failures).toEqual([]);
    expect(calls.sort((a, b) => a - b)).toEqual(items);
  });

  test("empty input completes with no spawn/metric calls", async () => {
    let spawned = 0;
    let metrics = 0;
    const result = await slowStartBatch(
      [],
      async () => {
        spawned += 1;
      },
      norm(),
      {
        onSpawnBatch: () => {
          metrics += 1;
        },
      },
    );
    expect(result.outcome).toBe("completed");
    expect(result.attempted).toBe(0);
    expect(spawned).toBe(0);
    expect(metrics).toBe(0);
  });

  test("maxBatchSize caps growth: cap 3 over 15 items", async () => {
    const sizes: number[] = [];
    await slowStartBatch(
      Array.from({ length: 15 }, (_, i) => i),
      async () => {
        /* no-op spawn */
      },
      norm({ maxBatchSize: 3 }),
      { onSpawnBatch: (m) => sizes.push(m.batchSize) },
    );
    expect(sizes).toEqual([1, 2, 3, 3, 3, 3]);
  });

  test("multiplier=1 yields fixed-size batches and still covers all items", async () => {
    const sizes: number[] = [];
    const calls: number[] = [];
    const items = Array.from({ length: 7 }, (_, i) => i);
    const result = await slowStartBatch(
      items,
      async (item) => {
        calls.push(item);
      },
      norm({ initialBatchSize: 1, multiplier: 1 }),
      { onSpawnBatch: (m) => sizes.push(m.batchSize) },
    );
    expect(sizes).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(result.outcome).toBe("completed");
    expect(calls.sort((a, b) => a - b)).toEqual(items);
  });

  test("non-power-of-two growth clamps the final partial batch", async () => {
    const sizes: number[] = [];
    await slowStartBatch(
      Array.from({ length: 15 }, (_, i) => i),
      async () => {
        /* no-op spawn */
      },
      norm({ initialBatchSize: 2, multiplier: 3 }),
      { onSpawnBatch: (m) => sizes.push(m.batchSize) },
    );
    expect(sizes).toEqual([2, 6, 7]);
  });

  test("metric reports succeeded/failed and forwards taskGroupId", async () => {
    const seen: SpawnBatchMetric[] = [];
    await slowStartBatch(
      [1, 2],
      async () => {
        /* no-op spawn */
      },
      norm({ initialBatchSize: 2 }),
      {
        taskGroupId: "tg-1",
        onSpawnBatch: (m) => seen.push(m),
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      taskGroupId: "tg-1",
      batchIndex: 0,
      batchSize: 2,
      attempted: 2,
      succeeded: 2,
      failed: 0,
    });
  });
});

describe("slowStartBatch — failure handling", () => {
  test("task failure in batch 1 halts; later batches never fire", async () => {
    const spawned: number[] = [];
    const result = await slowStartBatch(
      Array.from({ length: 15 }, (_, i) => i),
      async (item) => {
        spawned.push(item);
        if (item === 0) throw new Error("bad prompt");
      },
      norm(),
    );
    expect(result.outcome).toBe("halted");
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(spawned).toEqual([0]); // only batch 1 (size 1) ran
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ index: 0, batchIndex: 0, class: "task" });
  });

  test("RuntimeUnavailable in batch 1 throttles with backoff; no batch 2", async () => {
    const spawned: number[] = [];
    const result = await slowStartBatch(
      Array.from({ length: 15 }, (_, i) => i),
      async (item) => {
        spawned.push(item);
        if (item === 0) throw new RuntimeUnavailableError("runtime down");
      },
      norm(),
    );
    expect(result.outcome).toBe("throttled");
    expect(result.retryAfterMs).toBe(1000); // computeBackoffMs(0) === baseMs
    expect(spawned).toEqual([0]);
    expect(result.failures[0]).toMatchObject({ class: "backpressure" });
  });

  test("AdmissionReject halts and surfaces the actionable reason", async () => {
    const result = await slowStartBatch(
      [0],
      async () => {
        throw new AdmissionRejectError({
          ruleName: "max-fanout",
          ruleType: "shell",
          reason: "capacity exhausted",
        });
      },
      norm(),
    );
    expect(result.outcome).toBe("halted");
    expect(result.failures[0]).toMatchObject({ class: "admission", reason: "capacity exhausted" });
  });

  test("terminal wins on a mixed batch (backpressure + task)", async () => {
    const result = await slowStartBatch(
      [0, 1],
      async (item) => {
        if (item === 0) throw new RuntimeUnavailableError("runtime down");
        if (item === 1) throw new Error("bad prompt");
      },
      norm({ initialBatchSize: 2 }),
    );
    expect(result.outcome).toBe("halted"); // not throttled
    expect(result.failures).toHaveLength(2);
  });

  test("custom classifier overrides the default", async () => {
    const result = await slowStartBatch(
      [0],
      async () => {
        throw new Error("treat-me-as-backpressure");
      },
      norm(),
      { classify: () => "backpressure" },
    );
    expect(result.outcome).toBe("throttled");
  });
});
