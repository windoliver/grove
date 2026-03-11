/**
 * Cached frontier calculator.
 *
 * A decorator over FrontierCalculator that caches results with a TTL.
 * Prevents redundant frontier computations when gossip rounds and API
 * requests both need frontier data within a short window.
 */

import { DEFAULT_FRONTIER_CACHE_TTL_MS } from "../core/constants.js";
import type { Frontier, FrontierCalculator, FrontierQuery } from "../core/frontier.js";

/** A cached frontier result with expiry metadata. */
interface CacheEntry {
  readonly result: Frontier;
  readonly fetchedAt: number;
}

/**
 * Wraps a FrontierCalculator with a per-query TTL cache.
 *
 * Cache keys are derived from the serialized query. Entries expire
 * after `ttlMs` milliseconds. The cache can be manually invalidated.
 */
export class CachedFrontierCalculator implements FrontierCalculator {
  private readonly inner: FrontierCalculator;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(
    inner: FrontierCalculator,
    ttlMs: number = DEFAULT_FRONTIER_CACHE_TTL_MS,
    now?: () => number,
  ) {
    this.inner = inner;
    this.ttlMs = ttlMs;
    this.now = now ?? Date.now;
  }

  async compute(query?: FrontierQuery): Promise<Frontier> {
    const key = queryCacheKey(query);
    const currentTime = this.now();
    const cached = this.cache.get(key);

    if (cached && currentTime - cached.fetchedAt < this.ttlMs) {
      return cached.result;
    }

    const result = await this.inner.compute(query);
    this.cache.set(key, { result, fetchedAt: currentTime });
    return result;
  }

  /** Invalidate all cached entries. */
  invalidate(): void {
    this.cache.clear();
  }

  /** Number of cached entries (for testing). */
  get cacheSize(): number {
    return this.cache.size;
  }
}

/** Derive a stable cache key from a FrontierQuery by deep-sorting all object keys. */
function queryCacheKey(query?: FrontierQuery): string {
  if (!query) return "{}";
  return stableStringify(query);
}

/** Recursively serialize a value with sorted object keys for stable cache keys. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}
