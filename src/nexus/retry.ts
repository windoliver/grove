/**
 * Shared retry and concurrency utilities for Nexus adapters.
 *
 * Extracts the common `withRetry` (exponential backoff) and
 * `withSemaphore` (concurrency-limiting) helpers that were duplicated
 * across all five Nexus store adapters.
 */

import { isRetryable, mapNexusError } from "./errors.js";
import type { Semaphore } from "./semaphore.js";

/** Retry configuration subset required by {@link withRetry}. */
export interface RetryConfig {
  readonly retryMaxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
}

/**
 * Execute `fn` with exponential-backoff retry for transient errors.
 *
 * Non-retryable errors and the final attempt always throw immediately
 * via {@link mapNexusError}.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  config: RetryConfig,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < config.retryMaxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === config.retryMaxAttempts - 1) {
        throw mapNexusError(error, context);
      }
      const delay = Math.min(config.retryBaseDelayMs * 2 ** attempt, config.retryMaxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw mapNexusError(lastError, context);
}

/**
 * Execute `fn` within the given {@link Semaphore} to limit concurrency.
 */
export async function withSemaphore<T>(semaphore: Semaphore, fn: () => Promise<T>): Promise<T> {
  return semaphore.run(fn);
}
