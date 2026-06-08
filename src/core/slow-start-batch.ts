export interface BackoffStrategy {
  readonly baseMs?: number;
  readonly multiplier?: number;
  readonly maxMs?: number;
}

export interface BatchStrategy {
  readonly initialBatchSize?: number;
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
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

export function normalizeBatchStrategy(input?: BatchStrategy): NormalizedBatchStrategy {
  const initialBatchSize = input?.initialBatchSize ?? DEFAULT_INITIAL_BATCH_SIZE;
  const multiplier = input?.multiplier ?? DEFAULT_MULTIPLIER;
  const maxBatchSize = input?.maxBatchSize ?? Number.POSITIVE_INFINITY;
  const baseMs = input?.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMultiplier = input?.backoff?.multiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const maxMs = input?.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;

  requirePositiveInt(initialBatchSize, "initialBatchSize");
  requireFiniteMin(multiplier, 1, "multiplier");
  if (maxBatchSize !== Number.POSITIVE_INFINITY) {
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
