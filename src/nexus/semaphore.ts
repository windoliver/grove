/**
 * Simple counting semaphore for concurrency limiting.
 *
 * Limits the number of concurrent async operations to prevent
 * overwhelming the Nexus backend.
 */
export class Semaphore {
  private readonly maxConcurrency: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Execute a function with concurrency limiting.
   * If the semaphore is full, the call waits until a slot is available.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next !== undefined) {
      // Don't decrement — the slot transfers to the next waiter
      next();
    } else {
      this.running--;
    }
  }
}
