/**
 * Multi-signal frontier calculator.
 *
 * Computes frontiers along multiple dimensions:
 * - By metric (when scores exist, evaluation mode only)
 * - By adoption count (derives_from + adopts relations)
 * - By recency (most recent contributions)
 * - By review score (highest average review scores)
 * - By reproduction (most-reproduced contributions)
 */

import type { Contribution, ContributionKind, JsonValue, Score } from "./models.js";
import { ContributionMode, RelationType } from "./models.js";
import type { ContributionQuery, ContributionStore } from "./store.js";

/**
 * A single entry in a frontier ranking.
 *
 * `contribution` is always present when computed locally by
 * DefaultFrontierCalculator, but absent in HTTP API responses
 * (the server returns FrontierEntrySummary without full objects).
 */
export interface FrontierEntry {
  readonly cid: string;
  readonly summary: string;
  readonly value: number;
  readonly contribution?: Contribution | undefined;
}

/** Multi-signal frontier result. */
export interface Frontier {
  readonly byMetric: Readonly<Record<string, readonly FrontierEntry[]>>;
  readonly byAdoption: readonly FrontierEntry[];
  readonly byRecency: readonly FrontierEntry[];
  readonly byReviewScore: readonly FrontierEntry[];
  readonly byReproduction: readonly FrontierEntry[];
}

/** Filters for frontier computation. */
export interface FrontierQuery {
  readonly metric?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly platform?: string | undefined;
  readonly kind?: ContributionKind | undefined;
  readonly mode?: ContributionMode | undefined;
  readonly agentId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
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

/** Key-order-independent deep equality for JSON values. */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => k in bObj && jsonDeepEqual(aObj[k], bObj[k]));
  }
  return false;
}

/** Check if a contribution is ephemeral (messages, transient data). */
function isEphemeral(c: Contribution): boolean {
  return c.context?.ephemeral === true;
}

/** Filter contributions by query tags, platform, kind, mode, and agent. */
function matchesFilters(c: Contribution, query?: FrontierQuery): boolean {
  if (query?.tags && query.tags.length > 0) {
    for (const tag of query.tags) {
      if (!c.tags.includes(tag)) return false;
    }
  }
  if (query?.platform !== undefined) {
    if (c.agent.platform !== query.platform) return false;
  }
  if (query?.kind !== undefined) {
    if (c.kind !== query.kind) return false;
  }
  if (query?.mode !== undefined) {
    if (c.mode !== query.mode) return false;
  }
  if (query?.agentId !== undefined) {
    if (c.agent.agentId !== query.agentId) return false;
  }
  if (query?.agentName !== undefined) {
    if (c.agent.agentName !== query.agentName) return false;
  }
  if (query?.context !== undefined) {
    if (c.context === undefined) return false;
    for (const [key, expected] of Object.entries(query.context)) {
      if (!(key in c.context)) return false;
      if (!jsonDeepEqual(c.context[key], expected)) return false;
    }
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

    // Push supported filters to the store for indexed queries.
    // (Partially addresses the TODO(perf) — platform and context filters
    // are not supported by ContributionQuery so they remain in-memory.)
    const storeQuery: ContributionQuery = {
      ...(query?.kind !== undefined ? { kind: query.kind } : {}),
      ...(query?.mode !== undefined ? { mode: query.mode } : {}),
      ...(query?.agentId !== undefined ? { agentId: query.agentId } : {}),
      ...(query?.agentName !== undefined ? { agentName: query.agentName } : {}),
      ...(query?.tags !== undefined && query.tags.length > 0 ? { tags: [...query.tags] } : {}),
    };

    // Fetch store-filtered contributions. Platform and context filters
    // are not supported by ContributionQuery so they remain in-memory.
    // Ephemeral contributions (messages, transient data) are excluded
    // from frontier ranking by default to prevent inbox flooding.
    const storeContributions = await this.store.list(storeQuery);
    const filtered = storeContributions.filter((c) => !isEphemeral(c) && matchesFilters(c, query));

    // Relation counting still needs all contributions for incoming-edge scans.
    const allContributions =
      Object.keys(storeQuery).length > 0 ? await this.store.list() : storeContributions;

    // All dimension computations are synchronous in-memory operations.
    // The only async step is the store.list() call above.
    const byMetric = this.computeByMetric(filtered, limit, query?.metric);
    const byAdoption = this.computeByRelationCount(filtered, allContributions, limit, [
      RelationType.Adopts,
      RelationType.DerivesFrom,
    ]);
    const byRecency = this.computeByRecency(filtered, limit);
    const byReviewScore = this.computeByReviewScore(filtered, allContributions, limit);
    const byReproduction = this.computeByReproduction(filtered, allContributions, limit);

    return { byMetric, byAdoption, byRecency, byReviewScore, byReproduction };
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

  /** Count incoming relations of specified types for each filtered contribution. */
  private computeByRelationCount(
    contributions: readonly Contribution[],
    allContributions: readonly Contribution[],
    limit: number,
    relationTypes: readonly RelationType[],
  ): readonly FrontierEntry[] {
    const counts = new Map<string, number>();
    for (const c of contributions) {
      counts.set(c.cid, 0);
    }

    for (const c of allContributions) {
      for (const rel of c.relations) {
        if (relationTypes.includes(rel.relationType) && counts.has(rel.targetCid)) {
          counts.set(rel.targetCid, (counts.get(rel.targetCid) ?? 0) + 1);
        }
      }
    }

    const entries: FrontierEntry[] = [];
    for (const c of contributions) {
      const count = counts.get(c.cid) ?? 0;
      if (count > 0) {
        entries.push(toEntry(c, count));
      }
    }

    entries.sort((a, b) => compareEntries(a, b, true));
    return entries.slice(0, limit);
  }

  /**
   * Count confirmed reproductions for each filtered contribution.
   *
   * Per RELATIONS.md, reproduces metadata may include a `result` field
   * with values "confirmed", "challenged", or "partial". Only "confirmed"
   * and "partial" count toward the reproduction frontier. Reproductions
   * without metadata are treated as confirmed (the default assumption).
   * "challenged" reproductions are excluded — a repeatedly-challenged
   * contribution should not rank alongside a repeatedly-confirmed one.
   */
  private computeByReproduction(
    contributions: readonly Contribution[],
    allContributions: readonly Contribution[],
    limit: number,
  ): readonly FrontierEntry[] {
    const counts = new Map<string, number>();
    for (const c of contributions) {
      counts.set(c.cid, 0);
    }

    for (const c of allContributions) {
      for (const rel of c.relations) {
        if (rel.relationType === RelationType.Reproduces && counts.has(rel.targetCid)) {
          // Exclude "challenged" reproductions from the count.
          // Missing metadata or missing result field defaults to confirmed.
          const result = rel.metadata?.result;
          if (result === "challenged") continue;
          counts.set(rel.targetCid, (counts.get(rel.targetCid) ?? 0) + 1);
        }
      }
    }

    const entries: FrontierEntry[] = [];
    for (const c of contributions) {
      const count = counts.get(c.cid) ?? 0;
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

  private computeByReviewScore(
    contributions: readonly Contribution[],
    allContributions: readonly Contribution[],
    limit: number,
  ): readonly FrontierEntry[] {
    // Build a map of target CID → review contributions (in-memory scan).
    // This avoids O(N) store.relatedTo() calls.
    const filteredCids = new Set(contributions.map((c) => c.cid));
    const reviewsByTarget = new Map<string, Contribution[]>();

    for (const c of allContributions) {
      for (const rel of c.relations) {
        if (rel.relationType === RelationType.Reviews && filteredCids.has(rel.targetCid)) {
          let reviews = reviewsByTarget.get(rel.targetCid);
          if (reviews === undefined) {
            reviews = [];
            reviewsByTarget.set(rel.targetCid, reviews);
          }
          reviews.push(c);
        }
      }
    }

    const entries: FrontierEntry[] = [];
    let minimizeCount = 0;
    let maximizeCount = 0;

    for (const c of contributions) {
      const reviewers = reviewsByTarget.get(c.cid);
      if (reviewers === undefined || reviewers.length === 0) continue;

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

    // Respect score direction: if most review scores minimize, lower is better.
    // NOTE: mixed directions across reviewers (some minimize, some maximize)
    // produce majority-vote ordering. This is a data quality issue, not a
    // frontier bug — reviewers should use consistent metric semantics.
    const descending = maximizeCount >= minimizeCount;
    entries.sort((a, b) => compareEntries(a, b, descending));
    return entries.slice(0, limit);
  }
}
