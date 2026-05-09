/**
 * Bounded parallel execution utility.
 *
 * Runs an async function over an array of items with limited concurrency,
 * preserving result ordering.
 */

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

  const results = new Array<R>(items.length);
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  let nextIndex = 0;
  let rejection: unknown;

  const worker = async (): Promise<void> => {
    while (rejection === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      const item = items[index];
      if (item === undefined) return;

      try {
        results[index] = await fn(item);
      } catch (err) {
        rejection = err;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (rejection !== undefined) throw rejection;
  return results;
}
