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
