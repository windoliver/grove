import { AdmissionRejectError } from "./admission/errors.js";
import { GroveError } from "./errors.js";

export interface BackoffStrategy {
  readonly baseMs?: number;
  /**
   * Exponential growth factor applied to the delay after each requeue attempt.
   * `1` is permitted and yields a constant (flat) retry interval.
   */
  readonly multiplier?: number;
  readonly maxMs?: number;
}

export interface BatchStrategy {
  readonly initialBatchSize?: number;
  /**
   * Geometric growth factor applied to the batch size after each clean batch.
   * `1` is permitted and yields fixed-size batches (a constant concurrency cap).
   */
  readonly multiplier?: number;
  readonly maxBatchSize?: number;
  readonly backoff?: BackoffStrategy;
}

export interface NormalizedBatchStrategy {
  readonly initialBatchSize: number;
  readonly multiplier: number;
  readonly maxBatchSize: number; // Number.POSITIVE_INFINITY when unbounded
  readonly backoff: Required<BackoffStrategy>;
}

const DEFAULT_INITIAL_BATCH_SIZE = 1;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_MAX_BATCH_SIZE = Number.POSITIVE_INFINITY;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

export function normalizeBatchStrategy(input?: BatchStrategy): NormalizedBatchStrategy {
  const initialBatchSize = input?.initialBatchSize ?? DEFAULT_INITIAL_BATCH_SIZE;
  const multiplier = input?.multiplier ?? DEFAULT_MULTIPLIER;
  const maxBatchSize = input?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const baseMs = input?.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMultiplier = input?.backoff?.multiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const maxMs = input?.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;

  requirePositiveInt(initialBatchSize, "initialBatchSize");
  requireFiniteMin(multiplier, 1, "multiplier");
  if (maxBatchSize !== DEFAULT_MAX_BATCH_SIZE) {
    requirePositiveInt(maxBatchSize, "maxBatchSize");
    if (maxBatchSize < initialBatchSize) {
      throw new RangeError(
        `maxBatchSize (${maxBatchSize}) must be >= initialBatchSize (${initialBatchSize})`,
      );
    }
  }
  requirePositiveInt(baseMs, "backoff.baseMs");
  requireFiniteMin(backoffMultiplier, 1, "backoff.multiplier");
  requirePositiveInt(maxMs, "backoff.maxMs");
  if (maxMs < baseMs) {
    throw new RangeError(`backoff.maxMs (${maxMs}) must be >= backoff.baseMs (${baseMs})`);
  }

  return {
    initialBatchSize,
    multiplier,
    maxBatchSize,
    backoff: { baseMs, multiplier: backoffMultiplier, maxMs },
  };
}

export function computeBackoffMs(attempt: number, backoff: Required<BackoffStrategy>): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const raw = backoff.baseMs * backoff.multiplier ** n;
  return Math.min(raw, backoff.maxMs);
}

function requirePositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer >= 1 (got ${value})`);
  }
}

function requireFiniteMin(value: number, min: number, name: string): void {
  if (!Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number >= ${min} (got ${value})`);
  }
}

export type FailureClass = "task" | "backpressure" | "admission";

export class RuntimeUnavailableError extends GroveError {
  readonly reason: string;

  constructor(message: string, options?: { reason?: string }) {
    super(message);
    this.name = "RuntimeUnavailableError";
    this.reason = options?.reason ?? message;
  }
}

export interface ClassifiedFailure {
  readonly index: number; // index into the input items array
  readonly batchIndex: number; // 0-based batch the item was in
  readonly class: FailureClass;
  readonly reason: string;
  readonly error: unknown;
}

export type FailureClassifier = (error: unknown) => FailureClass;

export const defaultFailureClassifier: FailureClassifier = (error) => {
  if (error instanceof AdmissionRejectError) return "admission";
  if (error instanceof RuntimeUnavailableError) return "backpressure";
  return "task";
};
