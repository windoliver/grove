import { describe, expect, test } from "bun:test";
import { KeyedWorkQueue, QueueClosedError, type WorkQueueOptions } from "./workqueue.js";

interface FakeTimerHandle {
  readonly id: number;
}

class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { readonly at: number; readonly fn: () => void }>();

  readonly now = (): number => this.nowMs;

  readonly setTimer = (fn: () => void, delayMs: number): FakeTimerHandle => {
    const handle = { id: this.nextId };
    this.nextId += 1;
    this.timers.set(handle.id, { at: this.nowMs + delayMs, fn });
    return handle;
  };

  readonly clearTimer = (handle: FakeTimerHandle): void => {
    this.timers.delete(handle.id);
  };

  advance(ms: number): void {
    this.nowMs += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.nowMs)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.fn();
    }
  }

  get timerCount(): number {
    return this.timers.size;
  }
}

function makeQueue(
  clock: FakeClock,
  options: Partial<WorkQueueOptions<FakeTimerHandle>> = {},
): KeyedWorkQueue<FakeTimerHandle> {
  return new KeyedWorkQueue<FakeTimerHandle>({
    baseDelayMs: 5,
    maxDelayMs: 40,
    globalRatePerSec: 1,
    globalBurst: 2,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
}

describe("KeyedWorkQueue", () => {
  test("rejects invalid numeric options", () => {
    const invalidOptions: ReadonlyArray<Partial<WorkQueueOptions<FakeTimerHandle>>> = [
      { globalRatePerSec: 0 },
      { globalRatePerSec: -1 },
      { globalRatePerSec: Number.MIN_VALUE },
      { globalRatePerSec: Number.POSITIVE_INFINITY },
      { globalRatePerSec: Number.NaN },
      { globalBurst: 0 },
      { globalBurst: 0.5 },
      { globalBurst: -1 },
      { globalBurst: Number.POSITIVE_INFINITY },
      { globalBurst: Number.NaN },
      { baseDelayMs: 0 },
      { baseDelayMs: -1 },
      { baseDelayMs: 2_147_483_648 },
      { baseDelayMs: Number.POSITIVE_INFINITY },
      { baseDelayMs: Number.NaN },
      { maxDelayMs: -1 },
      { maxDelayMs: 2_147_483_648 },
      { maxDelayMs: Number.POSITIVE_INFINITY },
      { maxDelayMs: Number.NaN },
      { baseDelayMs: 10, maxDelayMs: 5 },
    ];

    const clock = new FakeClock();
    for (const options of invalidOptions) {
      expect(() => makeQueue(clock, options)).toThrow(RangeError);
    }
  });

  test("dedupes duplicate pending keys", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    queue.enqueue("claim-1");
    queue.enqueue("claim-1");

    expect(queue.size()).toBe(1);
    expect(queue.pendingKeys()).toEqual(["claim-1"]);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
    expect(queue.size()).toBe(0);
  });

  test("re-enqueues once when a key becomes dirty while in flight", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    const first = await queue.take();
    expect(first).toEqual({ key: "claim-1", attempt: 0 });

    queue.enqueue("claim-1");
    queue.enqueue("claim-1");
    expect(queue.size()).toBe(0);

    queue.acknowledge("claim-1");
    expect(queue.pendingKeys()).toEqual(["claim-1"]);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
  });

  test("retries with capped exponential per-key backoff", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock, { globalRatePerSec: 1_000, globalBurst: 10 });

    queue.enqueue("claim-1");
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
    queue.retry("claim-1");

    expect(queue.size()).toBe(0);
    expect(clock.timerCount).toBe(1);
    clock.advance(4);
    expect(queue.size()).toBe(0);
    clock.advance(1);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 1 });

    queue.retry("claim-1");
    clock.advance(10);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 2 });

    queue.retry("claim-1");
    clock.advance(20);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 3 });

    queue.retry("claim-1");
    clock.advance(40);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 4 });

    queue.retry("claim-1");
    clock.advance(39);
    expect(queue.size()).toBe(0);
    clock.advance(1);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 5 });
  });

  test("acknowledge clears retry state after success", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock, { globalRatePerSec: 1_000, globalBurst: 10 });

    queue.enqueue("claim-1");
    await queue.take();
    queue.retry("claim-1");
    clock.advance(5);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 1 });

    queue.acknowledge("claim-1");
    queue.enqueue("claim-1");
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
  });

  test("limits dispatch through the global token bucket", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    queue.enqueue("claim-2");
    queue.enqueue("claim-3");

    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
    await expect(queue.take()).resolves.toEqual({ key: "claim-2", attempt: 0 });

    let resolved = false;
    const pending = queue.take().then((item) => {
      resolved = true;
      return item;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(999);
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(1);
    await expect(pending).resolves.toEqual({ key: "claim-3", attempt: 0 });
  });

  test("applies the global token bucket to retried work", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    queue.enqueue("claim-2");

    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
    await expect(queue.take()).resolves.toEqual({ key: "claim-2", attempt: 0 });

    queue.retry("claim-1");
    clock.advance(5);

    let resolved = false;
    const pending = queue.take().then((item) => {
      resolved = true;
      return item;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(994);
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(1);
    await expect(pending).resolves.toEqual({ key: "claim-1", attempt: 1 });
  });

  test("close clears retry timers and rejects pending waiters", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    await queue.take();
    queue.retry("claim-1");
    expect(clock.timerCount).toBe(1);

    const pending = queue.take();
    queue.close();

    expect(clock.timerCount).toBe(0);
    await expect(pending).rejects.toBeInstanceOf(QueueClosedError);
    expect(() => queue.enqueue("claim-2")).toThrow(QueueClosedError);
    expect(() => queue.take()).toThrow(QueueClosedError);
    expect(() => queue.retry("claim-2")).toThrow(QueueClosedError);
  });

  test("close clears retained queue state", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock, { globalBurst: 10 });

    queue.enqueue("ready-1");
    queue.enqueue("ready-2");
    queue.enqueue("in-flight");
    queue.enqueue("retrying");

    await expect(queue.take()).resolves.toEqual({ key: "ready-1", attempt: 0 });
    await expect(queue.take()).resolves.toEqual({ key: "ready-2", attempt: 0 });
    await expect(queue.take()).resolves.toEqual({ key: "in-flight", attempt: 0 });
    await expect(queue.take()).resolves.toEqual({ key: "retrying", attempt: 0 });

    queue.enqueue("in-flight");
    queue.retry("retrying");
    queue.enqueue("ready-3");

    expect(queue.size()).toBe(1);
    expect(queue.pendingKeys()).toEqual(["ready-3"]);

    queue.close();

    expect(queue.size()).toBe(0);
    expect(queue.pendingKeys()).toEqual([]);
  });

  test("uses default timer types without generic parameters", () => {
    const queue = new KeyedWorkQueue();
    queue.close();
    expect(queue.size()).toBe(0);
  });
});
