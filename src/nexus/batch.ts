/**
 * Bounded parallel execution utility built on top of the Semaphore.
 *
 * Runs an async function over an array of items with limited concurrency,
 * preserving result ordering.
 */

import { Semaphore } from "./semaphore.js";

/**
 * Map over `items` calling `fn` for each, with at most `concurrency`
 * invocations in flight at once. Results are returned in the same order
 * as the input items.
 *
 * If any call rejects, the returned promise rejects with that error
 * (matching the behaviour of the sequential `for … await` loops this
 * replaces).
 */
export async function batchParallel<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = 10,
): Promise<R[]> {
  if (items.length === 0) return [];

  const semaphore = new Semaphore(concurrency);
  const promises: Array<Promise<R>> = items.map((item) => semaphore.run(() => fn(item)));
  return Promise.all(promises);
}
