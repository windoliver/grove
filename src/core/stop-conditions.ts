/**
 * Canonical stop condition evaluation for groves.
 *
 * This is the single source of truth for all five stop condition evaluators.
 * Both the lifecycle check path (grove_check_stop / MCP / CLI) and the
 * policy enforcement path (contributeOperation) must import from here so
 * they always agree on results for identical grove states.
 *
 * See spec/LIFECYCLE.md for the full specification.
 */

import type { MetricDefinition } from "./contract.js";
import type { Contribution, ContributionMode, JsonValue } from "./models.js";
import type { SessionRuntimeConfig } from "./session-config.js";
import type { ContributionStore } from "./store.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of evaluating a single stop condition. */
export interface StopConditionResult {
  readonly met: boolean;
  readonly reason: string;
  readonly details: Readonly<Record<string, JsonValue>>;
}

/** Result of evaluating all stop conditions for a grove. */
export interface StopEvaluationResult {
  readonly stopped: boolean;
  readonly conditions: Readonly<Record<string, StopConditionResult>>;
  readonly evaluatedAt: string;
}

/** Result of evaluating deliberation limits — per-topic. */
export interface DeliberationResult {
  readonly topicCid: string;
  readonly depth: number;
  readonly messageCount: number;
  readonly maxRoundsExceeded: boolean;
  readonly maxMessagesExceeded: boolean;
}

// ---------------------------------------------------------------------------
// Canonical evaluator
// ---------------------------------------------------------------------------

/** Options for {@link evaluateStopConditions}. */
export interface EvaluateStopConditionsOptions {
  /**
   * Skip the "expensive" evaluators — `quorumReviewScore` and
   * `deliberationLimit` — which require a full `store.list()` scan and
   * per-root `store.thread()` traversals. Callers on the pre-write hot
   * path (PolicyEnforcer.enforce inside the write mutex) pass this to
   * avoid blocking concurrent writers on large groves (#232). The
   * post-write recheck in contributeOperation runs with this option
   * disabled so threshold-crossing stops are still detected outside the
   * mutex.
   */
  readonly skipExpensive?: boolean;
}

/**
 * Evaluate all stop conditions defined in a grove contract.
 *
 * Returns a structured result indicating which conditions are met.
 * The grove is considered stopped if ANY condition is met.
 *
 * Each evaluator loads only the data it needs via targeted queries
 * (filtered list, count, or thread traversal) instead of loading all
 * contributions into memory up front. The full contribution list is
 * loaded at most once — shared between quorumReviewScore and
 * deliberationLimit if both are configured.
 *
 * When `options.skipExpensive` is true, the quorumReviewScore and
 * deliberationLimit evaluators are omitted entirely and the full
 * contribution list is not loaded.
 */
export async function evaluateStopConditions(
  config: SessionRuntimeConfig,
  store: ContributionStore,
  options?: EvaluateStopConditionsOptions,
): Promise<StopEvaluationResult> {
  const conditions: Record<string, StopConditionResult> = {};
  const stopConditions = config.stopConditions;

  if (stopConditions === undefined) {
    return { stopped: false, conditions: {}, evaluatedAt: new Date().toISOString() };
  }

  const evaluateQuorum =
    stopConditions.quorumReviewScore !== undefined && options?.skipExpensive !== true;
  const evaluateDeliberation =
    stopConditions.deliberationLimit !== undefined && options?.skipExpensive !== true;

  // Load the full contribution list at most once, shared by evaluators that need it.
  // The targeted evaluators (maxRoundsWithoutImprovement, targetMetric, budget) do
  // their own focused queries and do not use this list. When skipExpensive=true
  // the list is never loaded since neither expensive evaluator will run.
  const needsFullList = evaluateQuorum || evaluateDeliberation;
  const allContributions: readonly Contribution[] = needsFullList ? await store.list() : [];

  if (stopConditions.maxRoundsWithoutImprovement !== undefined) {
    conditions.max_rounds_without_improvement = await evaluateMaxRoundsWithoutImprovement(
      stopConditions.maxRoundsWithoutImprovement,
      config.metrics ?? {},
      store,
    );
  }

  if (stopConditions.targetMetric !== undefined) {
    conditions.target_metric = await evaluateTargetMetric(
      stopConditions.targetMetric.metric,
      stopConditions.targetMetric.value,
      config.metrics ?? {},
      store,
    );
  }

  if (stopConditions.budget !== undefined) {
    conditions.budget = await evaluateBudget(stopConditions.budget, store);
  }

  if (evaluateQuorum && stopConditions.quorumReviewScore !== undefined) {
    conditions.quorum_review_score = evaluateQuorumReviewScore(
      stopConditions.quorumReviewScore.minReviews,
      stopConditions.quorumReviewScore.minScore,
      allContributions,
    );
  }

  if (evaluateDeliberation && stopConditions.deliberationLimit !== undefined) {
    conditions.deliberation_limit = await evaluateDeliberationLimit(
      stopConditions.deliberationLimit,
      allContributions,
      store,
    );
  }

  const stopped = Object.values(conditions).some((c) => c.met);
  return { stopped, conditions, evaluatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Individual stop condition evaluators
// ---------------------------------------------------------------------------

async function evaluateMaxRoundsWithoutImprovement(
  maxRounds: number,
  metrics: Readonly<Record<string, MetricDefinition>>,
  store: ContributionStore,
): Promise<StopConditionResult> {
  const metricNames = Object.keys(metrics);
  if (metricNames.length === 0) {
    return {
      met: false,
      reason: "No metrics defined — cannot evaluate improvement",
      details: { max_rounds: maxRounds },
    };
  }

  // Load all contributions — we need the full count for the "last N" window,
  // and exploration contributions count as rounds even though they don't set scores.
  const allContributions = await store.list();

  if (allContributions.length < maxRounds) {
    return {
      met: false,
      reason: `Only ${allContributions.length} contributions, need at least ${maxRounds}`,
      details: { total_contributions: allContributions.length, max_rounds: maxRounds },
    };
  }

  // Sort by createdAt ascending (store.list() returns in this order)
  const sorted = [...allContributions].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );

  // For each metric, find the best score across ALL contributions,
  // then check if any of the last N contributions achieved it.
  for (const metricName of metricNames) {
    const metricDef = metrics[metricName];
    if (metricDef === undefined) continue;
    const direction = metricDef.direction;
    const isMinimize = direction === "minimize";

    // Find best score across all evaluation-mode contributions,
    // tracking the index of the contribution that *first* set the best.
    let bestScore: number | undefined;
    let bestIndex = -1;
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      if (c === undefined || c.mode === "exploration") continue;
      const score = c.scores?.[metricName];
      if (score === undefined) continue;
      if (bestScore === undefined) {
        bestScore = score.value;
        bestIndex = i;
      } else if (isMinimize ? score.value < bestScore : score.value > bestScore) {
        bestScore = score.value;
        bestIndex = i;
      }
    }

    if (bestScore === undefined) continue;

    // Check if the best was set within the last N contributions
    const cutoff = sorted.length - maxRounds;
    if (bestIndex >= cutoff) {
      // The best score was set in the last N rounds — still improving
      return {
        met: false,
        reason: `Metric '${metricName}' improved within the last ${maxRounds} contributions`,
        details: {
          metric: metricName,
          best_score: bestScore,
          max_rounds: maxRounds,
        },
      };
    }
  }

  return {
    met: true,
    reason: `No metric improved in the last ${maxRounds} contributions`,
    details: { max_rounds: maxRounds, metrics_checked: metricNames },
  };
}

async function evaluateTargetMetric(
  metricName: string,
  targetValue: number,
  metrics: Readonly<Record<string, MetricDefinition>>,
  store: ContributionStore,
): Promise<StopConditionResult> {
  const metricDef = metrics[metricName];
  if (metricDef === undefined) {
    return {
      met: false,
      reason: `Metric '${metricName}' is not defined in the contract`,
      details: { metric: metricName, target: targetValue },
    };
  }

  const isMinimize = metricDef.direction === "minimize";

  // Load only evaluation-mode contributions — exploration contributions
  // never contribute scores toward target metrics.
  const evalContributions = await store.list({ mode: "evaluation" as ContributionMode });

  let bestScore: number | undefined;
  for (const c of evalContributions) {
    const score = c.scores?.[metricName];
    if (score === undefined) continue;
    if (bestScore === undefined) {
      bestScore = score.value;
    } else if (isMinimize ? score.value < bestScore : score.value > bestScore) {
      bestScore = score.value;
    }
  }

  if (bestScore === undefined) {
    return {
      met: false,
      reason: `No scores found for metric '${metricName}'`,
      details: { metric: metricName, target: targetValue },
    };
  }

  const met = isMinimize ? bestScore <= targetValue : bestScore >= targetValue;
  return {
    met,
    reason: met
      ? `Metric '${metricName}' reached target: ${bestScore} ${isMinimize ? "≤" : "≥"} ${targetValue}`
      : `Metric '${metricName}' has not reached target: ${bestScore} ${isMinimize ? ">" : "<"} ${targetValue}`,
    details: {
      metric: metricName,
      best_score: bestScore,
      target: targetValue,
      direction: metricDef.direction,
    },
  };
}

async function evaluateBudget(
  budget: {
    readonly maxContributions?: number | undefined;
    readonly maxWallClockSeconds?: number | undefined;
  },
  store: ContributionStore,
): Promise<StopConditionResult> {
  // Use count() for contribution count — avoids materializing all objects.
  const totalContributions = await store.count();

  if (totalContributions === 0) {
    return {
      met: false,
      reason: "Grove is empty — no budget consumed",
      details: {
        ...(budget.maxContributions !== undefined && {
          contributions_used: 0,
          contributions_limit: budget.maxContributions,
        }),
        ...(budget.maxWallClockSeconds !== undefined && {
          seconds_elapsed: 0,
          seconds_limit: budget.maxWallClockSeconds,
        }),
      },
    };
  }

  // Check contribution count budget
  let contributionsBudgetMet = false;
  if (budget.maxContributions !== undefined && totalContributions >= budget.maxContributions) {
    contributionsBudgetMet = true;
  }

  // Check wall-clock budget
  let wallClockBudgetMet = false;
  let secondsElapsed = 0;
  if (budget.maxWallClockSeconds !== undefined) {
    // Fetch only the first (oldest) contribution for its timestamp.
    const oldest = await store.list({ limit: 1 });
    if (oldest.length > 0) {
      const first = oldest[0];
      const startTime = first !== undefined ? Date.parse(first.createdAt) : Date.now();
      secondsElapsed = Math.floor((Date.now() - startTime) / 1000);
      if (secondsElapsed >= budget.maxWallClockSeconds) {
        wallClockBudgetMet = true;
      }
    }
  }

  const met = contributionsBudgetMet || wallClockBudgetMet;
  const reasons: string[] = [];
  if (contributionsBudgetMet) {
    reasons.push(`contributions: ${totalContributions} >= ${budget.maxContributions}`);
  }
  if (wallClockBudgetMet) {
    reasons.push(`wall-clock: ${secondsElapsed}s >= ${budget.maxWallClockSeconds}s`);
  }

  return {
    met,
    reason: met ? `Budget exceeded: ${reasons.join(", ")}` : "Budget not yet exhausted",
    details: {
      ...(budget.maxContributions !== undefined && {
        contributions_used: totalContributions,
        contributions_limit: budget.maxContributions,
      }),
      ...(budget.maxWallClockSeconds !== undefined && {
        seconds_elapsed: secondsElapsed,
        seconds_limit: budget.maxWallClockSeconds,
      }),
    },
  };
}

function evaluateQuorumReviewScore(
  minReviews: number,
  minScore: number,
  allContributions: readonly Contribution[],
): StopConditionResult {
  // Pre-filter to contributions that have at least one "reviews" relation.
  // In typical groves, reviews are a small fraction of total contributions.
  const reviewingContributions = allContributions.filter((c) =>
    c.relations.some((r) => r.relationType === "reviews"),
  );

  // Build map of target CID → { sourceCids (distinct reviewers), scores[] }
  // Per spec: reviews without metadata.score count toward min_reviews
  // but do not contribute to the average score calculation.
  // Deduplicate: each review contribution counts at most once per target,
  // even if it carries duplicate reviews relations to the same target.
  const reviewsByTarget = new Map<
    string,
    { sourceCids: Set<string>; scoredSourceCids: Set<string>; scores: number[] }
  >();

  for (const c of reviewingContributions) {
    for (const rel of c.relations) {
      if (rel.relationType === "reviews") {
        let entry = reviewsByTarget.get(rel.targetCid);
        if (entry === undefined) {
          entry = { sourceCids: new Set(), scoredSourceCids: new Set(), scores: [] };
          reviewsByTarget.set(rel.targetCid, entry);
        }
        // Count distinct reviewer contributions (Set.add is idempotent).
        entry.sourceCids.add(c.cid);
        // Record the first score from each reviewer, regardless of relation
        // order. A reviewer with [unscored, scored] duplicate relations still
        // contributes a score.
        const score = rel.metadata?.score;
        if (typeof score === "number" && !entry.scoredSourceCids.has(c.cid)) {
          entry.scoredSourceCids.add(c.cid);
          entry.scores.push(score);
        }
      }
    }
  }

  // Check if any contribution meets the quorum
  for (const [targetCid, entry] of reviewsByTarget) {
    const totalReviews = entry.sourceCids.size;
    if (totalReviews >= minReviews && entry.scores.length > 0) {
      const avgScore = entry.scores.reduce((sum, s) => sum + s, 0) / entry.scores.length;
      if (avgScore >= minScore) {
        return {
          met: true,
          reason: `Contribution ${targetCid.slice(0, 20)}... has ${totalReviews} reviews with avg score ${avgScore.toFixed(3)} >= ${minScore}`,
          details: {
            target_cid: targetCid,
            review_count: totalReviews,
            scored_review_count: entry.scores.length,
            average_score: avgScore,
            min_reviews: minReviews,
            min_score: minScore,
          },
        };
      }
    }
  }

  return {
    met: false,
    reason: `No contribution has ${minReviews}+ reviews with average score >= ${minScore}`,
    details: { min_reviews: minReviews, min_score: minScore },
  };
}

async function evaluateDeliberationLimit(
  limit: { readonly maxRounds?: number | undefined; readonly maxMessages?: number | undefined },
  allContributions: readonly Contribution[],
  store: ContributionStore,
): Promise<StopConditionResult> {
  const roots = findTopicRoots(allContributions);

  // Cap traversal depth when only maxRounds is configured: we only need to detect
  // whether any node reaches that depth, so traversing deeper wastes I/O.
  // When maxMessages is configured, accurate node counts require full traversal.
  const traversalDepth = limit.maxMessages !== undefined ? 10_000 : (limit.maxRounds ?? 10_000);

  // Parallelize traversals across topic roots — store reads are safe to run
  // concurrently and are typically I/O-bound.
  const perRootResults = await Promise.all(
    roots.map(async (rootCid): Promise<DeliberationResult | null> => {
      const nodes = await store.thread(rootCid, { maxDepth: traversalDepth });
      if (nodes.length === 0) return null;

      let maxDepth = 0;
      for (const node of nodes) {
        if (node.depth > maxDepth) maxDepth = node.depth;
      }
      const messageCount = nodes.length - 1; // Exclude root itself

      const maxRoundsExceeded = limit.maxRounds !== undefined && maxDepth >= limit.maxRounds;
      const maxMessagesExceeded =
        limit.maxMessages !== undefined && messageCount >= limit.maxMessages;

      if (maxRoundsExceeded || maxMessagesExceeded) {
        return {
          topicCid: rootCid,
          depth: maxDepth,
          messageCount,
          maxRoundsExceeded,
          maxMessagesExceeded,
        };
      }
      return null;
    }),
  );

  const exceededTopics = perRootResults.filter((r): r is DeliberationResult => r !== null);

  if (exceededTopics.length > 0) {
    const firstExceeded = exceededTopics[0];
    if (firstExceeded === undefined) {
      return { met: false, reason: "no exceeded topics", details: {} };
    }
    const reasons: string[] = [];
    if (firstExceeded.maxRoundsExceeded) {
      reasons.push(`depth ${firstExceeded.depth} >= ${limit.maxRounds}`);
    }
    if (firstExceeded.maxMessagesExceeded) {
      reasons.push(`messages ${firstExceeded.messageCount} >= ${limit.maxMessages}`);
    }

    return {
      met: true,
      reason: `Deliberation limit exceeded on topic ${firstExceeded.topicCid.slice(0, 20)}...: ${reasons.join(", ")}`,
      details: {
        exceeded_topics: exceededTopics.length,
        first_topic: firstExceeded.topicCid,
        depth: firstExceeded.depth,
        message_count: firstExceeded.messageCount,
        ...(limit.maxRounds !== undefined && { max_rounds: limit.maxRounds }),
        ...(limit.maxMessages !== undefined && { max_messages: limit.maxMessages }),
      },
    };
  }

  return {
    met: false,
    reason: "No topics exceed deliberation limits",
    details: {
      topics_checked: roots.length,
      ...(limit.maxRounds !== undefined && { max_rounds: limit.maxRounds }),
      ...(limit.maxMessages !== undefined && { max_messages: limit.maxMessages }),
    },
  };
}

/**
 * Find all topic roots from a pre-loaded list of contributions.
 *
 * A topic root is a CID that is a responds_to target but does not itself
 * have any outgoing responds_to relation (i.e., it's the start of a thread).
 * CIDs not present in allContributions are excluded — this guards against
 * dangling responds_to references pointing at contributions not in the store.
 */
function findTopicRoots(allContributions: readonly Contribution[]): readonly string[] {
  // Build responds_to adjacency: child CID → parent CID
  const respondsToSources = new Set<string>();
  const respondsToTargets = new Set<string>();

  for (const c of allContributions) {
    for (const rel of c.relations) {
      if (rel.relationType === "responds_to") {
        respondsToSources.add(c.cid);
        respondsToTargets.add(rel.targetCid);
      }
    }
  }

  // Roots: targets that are not themselves sources.
  // Only include CIDs that exist in the current grove (guards dangling references).
  const roots: string[] = [];
  const allCids = new Set(allContributions.map((c) => c.cid));
  for (const targetCid of respondsToTargets) {
    if (!respondsToSources.has(targetCid) && allCids.has(targetCid)) {
      roots.push(targetCid);
    }
  }

  return roots;
}
