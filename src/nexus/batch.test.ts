import { describe, expect, test } from "bun:test";

import { batchParallel } from "./batch.js";

/** Helper that creates a promise which resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("batchParallel", () => {
  test("returns an empty array for empty input", async () => {
    const result = await batchParallel([], async () => 42);
    expect(result).toEqual([]);
  });

  test("maps items and preserves order", async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await batchParallel(items, async (n) => n * 10);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  test("limits concurrency to the specified value", async () => {
    let running = 0;
    let maxRunning = 0;

    const items = Array.from({ length: 20 }, (_, i) => i);
    await batchParallel(
      items,
      async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await delay(20);
        running--;
      },
      3,
    );

    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(maxRunning).toBeGreaterThan(1); // verify actual parallelism
  });

  test("defaults to concurrency of 10", async () => {
    let running = 0;
    let maxRunning = 0;

    const items = Array.from({ length: 30 }, (_, i) => i);
    await batchParallel(items, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(20);
      running--;
    });

    expect(maxRunning).toBeLessThanOrEqual(10);
    expect(maxRunning).toBeGreaterThan(1);
  });

  test("preserves order even when tasks complete out of order", async () => {
    // Items with decreasing delay so later items finish before earlier ones
    const items = [1, 2, 3, 4, 5];
    const result = await batchParallel(
      items,
      async (n) => {
        await delay((6 - n) * 10); // item 1 takes longest, item 5 shortest
        return n * 100;
      },
      5,
    );

    expect(result).toEqual([100, 200, 300, 400, 500]);
  });

  test("rejects if any fn call rejects", async () => {
    const items = [1, 2, 3];
    await expect(
      batchParallel(items, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  test("works with concurrency of 1 (sequential)", async () => {
    const order: number[] = [];
    const items = [1, 2, 3];
    const result = await batchParallel(
      items,
      async (n) => {
        order.push(n);
        await delay(5);
        return n * 2;
      },
      1,
    );

    expect(result).toEqual([2, 4, 6]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("handles readonly arrays", async () => {
    const items: readonly string[] = ["a", "b", "c"];
    const result = await batchParallel(items, async (s) => s.toUpperCase());
    expect(result).toEqual(["A", "B", "C"]);
  });
});
