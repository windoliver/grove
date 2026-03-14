import { describe, expect, test } from "bun:test";

import { Semaphore } from "./semaphore.js";

/** Helper that creates a promise which resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Semaphore", () => {
  test("allows a single task to run immediately with concurrency 1", async () => {
    const sem = new Semaphore(1);
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
  });

  test("returns the resolved value from the wrapped function", async () => {
    const sem = new Semaphore(3);
    const result = await sem.run(async () => "hello");
    expect(result).toBe("hello");
  });

  test("limits concurrency to maxConcurrency", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;

    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(50);
      running--;
    };

    await Promise.all([sem.run(task), sem.run(task), sem.run(task), sem.run(task), sem.run(task)]);

    expect(maxRunning).toBe(2);
  });

  test("queues tasks beyond the concurrency limit", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const makeTask = (id: number, delayMs: number) => async () => {
      order.push(id);
      await delay(delayMs);
      return id;
    };

    const results = await Promise.all([
      sem.run(makeTask(1, 30)),
      sem.run(makeTask(2, 10)),
      sem.run(makeTask(3, 10)),
    ]);

    // Tasks should start in FIFO order
    expect(order).toEqual([1, 2, 3]);
    // All results should be returned correctly
    expect(results).toEqual([1, 2, 3]);
  });

  test("releases slot when task throws an error", async () => {
    const sem = new Semaphore(1);

    // First task throws
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Slot should be free; second task should run fine
    const result = await sem.run(async () => "recovered");
    expect(result).toBe("recovered");
  });

  test("propagates rejection from the wrapped function", async () => {
    const sem = new Semaphore(3);
    const err = new Error("task failed");

    await expect(
      sem.run(async () => {
        throw err;
      }),
    ).rejects.toThrow("task failed");
  });

  test("handles concurrency of 1 as a mutex", async () => {
    const sem = new Semaphore(1);
    const events: string[] = [];

    const taskA = sem.run(async () => {
      events.push("A-start");
      await delay(30);
      events.push("A-end");
    });

    const taskB = sem.run(async () => {
      events.push("B-start");
      await delay(10);
      events.push("B-end");
    });

    await Promise.all([taskA, taskB]);

    // B must not start until A finishes
    expect(events).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  test("allows maxConcurrency tasks to run simultaneously", async () => {
    const sem = new Semaphore(5);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, () =>
      sem.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await delay(30);
        running--;
      }),
    );

    await Promise.all(tasks);
    expect(maxRunning).toBe(5);
  });

  test("processes all queued tasks to completion", async () => {
    const sem = new Semaphore(2);
    const completed: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, i) =>
      sem.run(async () => {
        await delay(10);
        completed.push(i);
        return i;
      }),
    );

    const results = await Promise.all(tasks);

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(completed).toHaveLength(10);
  });

  test("slot transfers correctly when multiple tasks are queued", async () => {
    const sem = new Semaphore(1);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 4 }, () =>
      sem.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        // Yield to allow any broken concurrency to show up
        await delay(5);
        running--;
      }),
    );

    await Promise.all(tasks);
    // Should never exceed 1 concurrent
    expect(maxRunning).toBe(1);
  });

  test("handles interleaved successes and failures", async () => {
    const sem = new Semaphore(2);
    const results: Array<string> = [];

    const tasks = [
      sem
        .run(async () => {
          await delay(10);
          return "ok-1";
        })
        .then((v) => results.push(v)),
      sem
        .run(async () => {
          throw new Error("fail-2");
        })
        .catch((e: Error) => results.push(e.message)),
      sem
        .run(async () => {
          return "ok-3";
        })
        .then((v) => results.push(v)),
      sem
        .run(async () => {
          throw new Error("fail-4");
        })
        .catch((e: Error) => results.push(e.message)),
    ];

    await Promise.all(tasks);

    expect(results).toContain("ok-1");
    expect(results).toContain("fail-2");
    expect(results).toContain("ok-3");
    expect(results).toContain("fail-4");
    expect(results).toHaveLength(4);
  });

  test("handles large concurrency values", async () => {
    const sem = new Semaphore(100);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 50 }, () =>
      sem.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await delay(5);
        running--;
      }),
    );

    await Promise.all(tasks);

    // All 50 should run concurrently since limit is 100
    expect(maxRunning).toBe(50);
  });

  test("synchronous return values are properly wrapped as promises", async () => {
    const sem = new Semaphore(2);
    // The function returns a resolved promise with an object
    const result = await sem.run(async () => ({ key: "value" }));
    expect(result).toEqual({ key: "value" });
  });

  test("tasks resume in FIFO order when slots free up", async () => {
    const sem = new Semaphore(1);
    const startOrder: number[] = [];

    // Launch several tasks; with concurrency 1 they must queue
    const p1 = sem.run(async () => {
      startOrder.push(1);
      await delay(20);
    });
    const p2 = sem.run(async () => {
      startOrder.push(2);
      await delay(10);
    });
    const p3 = sem.run(async () => {
      startOrder.push(3);
      await delay(10);
    });

    await Promise.all([p1, p2, p3]);

    expect(startOrder).toEqual([1, 2, 3]);
  });
});
