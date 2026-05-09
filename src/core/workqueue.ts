export type DefaultTimerHandle = ReturnType<typeof setTimeout>;

export interface WorkQueueOptions<TTimer = DefaultTimerHandle> {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly globalRatePerSec?: number;
  readonly globalBurst?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, delayMs: number) => TTimer;
  readonly clearTimer?: (handle: TTimer) => void;
}

export interface WorkItemResult {
  readonly key: string;
  readonly attempt: number;
}

interface Waiter {
  readonly resolve: (item: WorkItemResult) => void;
  readonly reject: (error: QueueClosedError) => void;
}

interface RetryTimer<TTimer> {
  readonly handle: TTimer;
}

const DEFAULT_BASE_DELAY_MS = 5;
const DEFAULT_MAX_DELAY_MS = 1_000_000;
const DEFAULT_GLOBAL_RATE_PER_SEC = 50;
const DEFAULT_GLOBAL_BURST = 300;

export class QueueClosedError extends Error {
  constructor() {
    super("Work queue is closed");
    this.name = "QueueClosedError";
  }
}

export class KeyedWorkQueue<TTimer = DefaultTimerHandle> {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly globalRatePerSec: number;
  private readonly globalBurst: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, delayMs: number) => TTimer;
  private readonly clearTimer: (handle: TTimer) => void;

  private readonly readyKeys: string[] = [];
  private readonly readySet = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, RetryTimer<TTimer>>();
  private readonly waiters: Waiter[] = [];

  private tokens: number;
  private lastRefillMs: number;
  private paceTimer: TTimer | undefined;
  private closed = false;

  constructor(options: WorkQueueOptions<TTimer> = {}) {
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.globalRatePerSec = options.globalRatePerSec ?? DEFAULT_GLOBAL_RATE_PER_SEC;
    this.globalBurst = options.globalBurst ?? DEFAULT_GLOBAL_BURST;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((fn: () => void, delayMs: number): TTimer => setTimeout(fn, delayMs) as TTimer);
    this.clearTimer =
      options.clearTimer ??
      ((handle: TTimer): void => {
        clearTimeout(handle as DefaultTimerHandle);
      });
    this.tokens = this.globalBurst;
    this.lastRefillMs = this.now();
  }

  enqueue(key: string): void {
    this.assertOpen();
    if (this.readySet.has(key)) return;
    if (this.inFlight.has(key) || this.retryTimers.has(key)) {
      this.dirty.add(key);
      return;
    }
    this.enqueueReady(key);
  }

  take(): Promise<WorkItemResult> {
    this.assertOpen();
    return new Promise<WorkItemResult>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.drain();
    });
  }

  acknowledge(key: string): void {
    this.inFlight.delete(key);
    this.clearRetry(key);
    this.attempts.delete(key);
    if (this.dirty.delete(key)) {
      this.enqueueReady(key);
    }
  }

  retry(key: string): void {
    this.assertOpen();
    this.inFlight.delete(key);
    this.readySet.delete(key);
    this.dirty.delete(key);
    this.readyKeys.splice(
      0,
      this.readyKeys.length,
      ...this.readyKeys.filter((readyKey) => readyKey !== key),
    );
    this.clearRetry(key);

    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const handle = this.setTimer(() => {
      this.retryTimers.delete(key);
      this.enqueueReady(key);
    }, delayMs);
    this.retryTimers.set(key, { handle });
  }

  size(): number {
    return this.readyKeys.length;
  }

  pendingKeys(): string[] {
    return [...this.readyKeys];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.retryTimers.values()) {
      this.clearTimer(timer.handle);
    }
    this.retryTimers.clear();
    if (this.paceTimer !== undefined) {
      this.clearTimer(this.paceTimer);
      this.paceTimer = undefined;
    }
    const error = new QueueClosedError();
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private enqueueReady(key: string): void {
    if (this.closed || this.readySet.has(key) || this.inFlight.has(key)) return;
    this.dirty.delete(key);
    this.readySet.add(key);
    this.readyKeys.push(key);
    this.drain();
  }

  private drain(): void {
    if (this.closed) return;
    this.refillTokens();
    while (this.waiters.length > 0 && this.readyKeys.length > 0) {
      const key = this.readyKeys.shift();
      if (key === undefined) break;
      const attempt = this.attempts.get(key) ?? 0;
      if (this.tokens < 1) {
        this.readyKeys.unshift(key);
        break;
      }
      this.readySet.delete(key);
      this.tokens -= 1;
      this.inFlight.add(key);
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.inFlight.delete(key);
        this.readyKeys.unshift(key);
        this.readySet.add(key);
        this.tokens += 1;
        break;
      }
      waiter.resolve({ key, attempt });
    }
    this.schedulePaceTimer();
  }

  private refillTokens(): void {
    const nowMs = this.now();
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    if (elapsedMs === 0) return;
    this.tokens = Math.min(
      this.globalBurst,
      this.tokens + (elapsedMs * this.globalRatePerSec) / 1000,
    );
    this.lastRefillMs = nowMs;
  }

  private schedulePaceTimer(): void {
    if (
      this.closed ||
      this.paceTimer !== undefined ||
      this.waiters.length === 0 ||
      this.readyKeys.length === 0 ||
      this.tokens >= 1
    ) {
      return;
    }
    const delayMs = Math.max(1, Math.ceil(((1 - this.tokens) * 1000) / this.globalRatePerSec));
    this.paceTimer = this.setTimer(() => {
      this.paceTimer = undefined;
      this.drain();
    }, delayMs);
  }

  private clearRetry(key: string): void {
    const retryTimer = this.retryTimers.get(key);
    if (retryTimer === undefined) return;
    this.clearTimer(retryTimer.handle);
    this.retryTimers.delete(key);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new QueueClosedError();
    }
  }
}
