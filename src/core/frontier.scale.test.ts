/**
 * Frontier calculator scale and regression tests.
 *
 * Uses a query-counting proxy to verify that frontier computation
 * makes a bounded number of store calls, preventing regression to
 * O(N) or O(N^2) query patterns.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../local/sqlite-store.js";
import { DefaultFrontierCalculator } from "./frontier.js";
import { ContributionKind, RelationType, ScoreDirection } from "./models.js";
import type { ContributionStore } from "./store.js";
import { makeContribution, makeRelation, makeScore } from "./test-helpers.js";

/** Wraps a ContributionStore and counts calls to each method. */
function createCountingProxy(store: ContributionStore): {
  proxy: ContributionStore;
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};

  const handler: ProxyHandler<ContributionStore> = {
    get(target, prop: string) {
      const value = target[prop as keyof ContributionStore];
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          counts[prop] = (counts[prop] ?? 0) + 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  };

  return {
    proxy: new Proxy(store, handler),
    counts,
  };
}

describe("frontier scale tests", () => {
  let store: SqliteStore;
  let dir: string;

  async function setup(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "frontier-scale-"));
    const dbPath = join(dir, "test.db");
    store = new SqliteStore(dbPath);
  }

  async function teardown(): Promise<void> {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }

  test("compute() calls list() a bounded number of times", async () => {
    await setup();
    try {
      // Create 50 contributions with scores
      const contributions = Array.from({ length: 50 }, (_, i) =>
        makeContribution({
          summary: `contribution-${i}`,
          scores: { acc: makeScore({ value: i * 0.01, direction: ScoreDirection.Maximize }) },
          createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      );
      await store.putMany(contributions);

      const { proxy, counts } = createCountingProxy(store);
      const calculator = new DefaultFrontierCalculator(proxy);
      await calculator.compute();

      // list() should be called at most a small constant number of times,
      // NOT once per contribution. Currently expected: 1 call.
      expect(counts.list ?? 0).toBeLessThanOrEqual(3);
    } finally {
      await teardown();
    }
  });

  test("compute() with reviews does not make N queries per contribution", async () => {
    await setup();
    try {
      // Create 20 targets
      const targets = Array.from({ length: 20 }, (_, i) =>
        makeContribution({
          summary: `target-${i}`,
          createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      );
      await store.putMany(targets);

      // Create reviews pointing to each target
      const reviews = targets.map((target, i) =>
        makeContribution({
          summary: `review-of-${i}`,
          kind: ContributionKind.Review,
          scores: { quality: makeScore({ value: 5 + i, direction: ScoreDirection.Maximize }) },
          relations: [makeRelation({ targetCid: target.cid, relationType: RelationType.Reviews })],
          createdAt: `2026-02-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      );
      await store.putMany(reviews);

      const { proxy, counts } = createCountingProxy(store);
      const calculator = new DefaultFrontierCalculator(proxy);
      await calculator.compute();

      // relatedTo calls should be bounded. Currently the code calls relatedTo()
      // once per contribution for review scores, which is O(N). This test
      // documents the current behavior and will catch regressions above O(N).
      const relatedToCalls = counts.relatedTo ?? 0;
      // Must not exceed total contributions (targets + reviews = 40)
      expect(relatedToCalls).toBeLessThanOrEqual(40);

      // list() should still be bounded
      expect(counts.list ?? 0).toBeLessThanOrEqual(3);
    } finally {
      await teardown();
    }
  });

  test("frontier produces correct results at scale", async () => {
    await setup();
    try {
      // Create contributions with varying scores
      const contributions = Array.from({ length: 30 }, (_, i) =>
        makeContribution({
          summary: `scaled-${i}`,
          scores: { accuracy: makeScore({ value: i, direction: ScoreDirection.Maximize }) },
          createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`,
        }),
      );
      await store.putMany(contributions);

      const calculator = new DefaultFrontierCalculator(store);
      const frontier = await calculator.compute({ limit: 5 });

      // Top 5 by accuracy should be the highest-scored
      expect(frontier.byMetric.accuracy).toHaveLength(5);
      expect(frontier.byMetric.accuracy?.[0]?.value).toBe(29);
      expect(frontier.byMetric.accuracy?.[1]?.value).toBe(28);

      // Top 5 by recency should be the most recent
      expect(frontier.byRecency).toHaveLength(5);
    } finally {
      await teardown();
    }
  });
});
