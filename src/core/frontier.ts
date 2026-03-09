/**
 * Multi-signal frontier calculator.
 *
 * Computes frontiers along multiple dimensions:
 * - By metric (when scores exist)
 * - By adoption count (most children in DAG)
 * - By recency (most recent contributions)
 * - By review score (highest average review scores)
 */

import type { Contribution, Score } from "./models.js";
import { ContributionMode, RelationType } from "./models.js";
import type { ContributionStore } from "./store.js";

/** A single entry in a frontier ranking. */
export interface FrontierEntry {
  readonly cid: string;
  readonly summary: string;
  readonly value: number;
  readonly contribution: Contribution;
}

/** Multi-signal frontier result. */
export interface Frontier {
  readonly byMetric: Readonly<Record<string, readonly FrontierEntry[]>>;
  readonly byAdoption: readonly FrontierEntry[];
  readonly byRecency: readonly FrontierEntry[];
  readonly byReviewScore: readonly FrontierEntry[];
}

/** Filters for frontier computation. */
export interface FrontierQuery {
  readonly metric?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly platform?: string | undefined;
  readonly limit?: number | undefined;
}

/** Computes multi-signal frontiers from a contribution store. */
export interface FrontierCalculator {
  compute(query?: FrontierQuery): Promise<Frontier>;
}

/** Extract the best score for a named metric from a contribution. */
export function getScore(contribution: Contribution, metricName: string): Score | undefined {
  return contribution.scores?.[metricName];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10;

/** Create a FrontierEntry from a contribution and a value. */
function toEntry(contribution: Contribution, value: number): FrontierEntry {
  return { cid: contribution.cid, summary: contribution.summary, value, contribution };
}

/** Deterministic tie-breaker: sort by CID lexicographically when values are equal. */
function compareEntries(a: FrontierEntry, b: FrontierEntry, descending: boolean): number {
  const diff = descending ? b.value - a.value : a.value - b.value;
  if (diff !== 0) return diff;
  return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
}

/** Filter contributions by query tags and platform. */
function matchesFilters(c: Contribution, query?: FrontierQuery): boolean {
  if (query?.tags && query.tags.length > 0) {
    for (const tag of query.tags) {
      if (!c.tags.includes(tag)) return false;
    }
  }
  if (query?.platform !== undefined) {
    if (c.agent.platform !== query.platform) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// DefaultFrontierCalculator
// ---------------------------------------------------------------------------

/** Concrete implementation of FrontierCalculator backed by a ContributionStore. */
export class DefaultFrontierCalculator implements FrontierCalculator {
  private readonly store: ContributionStore;

  constructor(store: ContributionStore) {
    this.store = store;
  }

  async compute(query?: FrontierQuery): Promise<Frontier> {
    const limit = query?.limit ?? DEFAULT_LIMIT;
    const allContributions = await this.store.list();
    const filtered = allContributions.filter((c) => matchesFilters(c, query));

    const [byMetric, byAdoption, byRecency, byReviewScore] = await Promise.all([
      this.computeByMetric(filtered, limit, query?.metric),
      this.computeByAdoption(filtered, limit),
      this.computeByRecency(filtered, limit),
      this.computeByReviewScore(filtered, limit),
    ]);

    return { byMetric, byAdoption, byRecency, byReviewScore };
  }

  private computeByMetric(
    contributions: readonly Contribution[],
    limit: number,
    metricFilter?: string,
  ): Record<string, readonly FrontierEntry[]> {
    // Exclude exploration mode contributions from metric ranking
    const evalContributions = contributions.filter((c) => c.mode !== ContributionMode.Exploration);

    // Collect all unique metric names
    const metricNames = new Set<string>();
    for (const c of evalContributions) {
      if (c.scores) {
        for (const name of Object.keys(c.scores)) {
          metricNames.add(name);
        }
      }
    }

    // If a specific metric is requested, only compute that one
    const targetMetrics =
      metricFilter !== undefined
        ? metricNames.has(metricFilter)
          ? [metricFilter]
          : []
        : [...metricNames];

    const result: Record<string, readonly FrontierEntry[]> = {};

    for (const metric of targetMetrics) {
      const entries: FrontierEntry[] = [];
      for (const c of evalContributions) {
        const score = c.scores?.[metric];
        if (score !== undefined) {
          entries.push(toEntry(c, score.value));
        }
      }

      // Determine direction from the first score found for this metric
      const firstScore = evalContributions
        .map((c) => c.scores?.[metric])
        .find((s) => s !== undefined);
      const descending = firstScore?.direction === "maximize";

      entries.sort((a, b) => compareEntries(a, b, descending));
      result[metric] = entries.slice(0, limit);
    }

    return result;
  }

  private async computeByAdoption(
    contributions: readonly Contribution[],
    limit: number,
  ): Promise<readonly FrontierEntry[]> {
    // For each contribution, count how many other contributions adopt it
    const adoptionCounts = new Map<string, number>();

    for (const c of contributions) {
      adoptionCounts.set(c.cid, 0);
    }

    // Look through all contributions for "adopts" relations targeting our set
    const allContributions = await this.store.list();
    for (const c of allContributions) {
      for (const rel of c.relations) {
        if (rel.relationType === RelationType.Adopts && adoptionCounts.has(rel.targetCid)) {
          adoptionCounts.set(rel.targetCid, (adoptionCounts.get(rel.targetCid) ?? 0) + 1);
        }
      }
    }

    const entries: FrontierEntry[] = [];
    for (const c of contributions) {
      const count = adoptionCounts.get(c.cid) ?? 0;
      if (count > 0) {
        entries.push(toEntry(c, count));
      }
    }

    entries.sort((a, b) => compareEntries(a, b, true));
    return entries.slice(0, limit);
  }

  private computeByRecency(
    contributions: readonly Contribution[],
    limit: number,
  ): readonly FrontierEntry[] {
    const entries = contributions.map((c) => toEntry(c, Date.parse(c.createdAt)));
    entries.sort((a, b) => compareEntries(a, b, true));
    return entries.slice(0, limit);
  }

  private async computeByReviewScore(
    contributions: readonly Contribution[],
    limit: number,
  ): Promise<readonly FrontierEntry[]> {
    const entries: FrontierEntry[] = [];
    let minimizeCount = 0;
    let maximizeCount = 0;

    for (const c of contributions) {
      // Find all contributions that review this one
      const reviewers = await this.store.relatedTo(c.cid, RelationType.Reviews);
      if (reviewers.length === 0) continue;

      // Average all score values from review contributions
      let totalScore = 0;
      let scoreCount = 0;
      for (const reviewer of reviewers) {
        if (reviewer.scores) {
          for (const score of Object.values(reviewer.scores)) {
            totalScore += score.value;
            scoreCount += 1;
            if (score.direction === "minimize") minimizeCount++;
            else maximizeCount++;
          }
        }
      }

      if (scoreCount > 0) {
        entries.push(toEntry(c, totalScore / scoreCount));
      }
    }

    // Respect score direction: if most review scores minimize, lower is better
    const descending = maximizeCount >= minimizeCount;
    entries.sort((a, b) => compareEntries(a, b, descending));
    return entries.slice(0, limit);
  }
}
