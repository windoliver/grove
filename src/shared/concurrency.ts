/**
 * Run async work over a collection with bounded concurrency while preserving
 * result order.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  }
  if (items.length === 0) return [];

  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  let rejection: unknown;

  const worker = async (): Promise<void> => {
    while (rejection === undefined) {
      const index = nextIndex;
      nextIndex++;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = await fn(item, index);
      } catch (err) {
        rejection = err;
        return;
      }
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (rejection !== undefined) throw rejection;
  return results;
}
