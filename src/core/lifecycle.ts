/**
 * Contribution lifecycle state derivation and stop condition evaluation.
 *
 * Lifecycle states are derived from the graph structure — they are never
 * stored. Stop conditions are evaluated against the current grove state
 * using the GROVE.md contract and the contribution store.
 *
 * See spec/LIFECYCLE.md for the full specification.
 */

import type { GroveContract, MetricDefinition } from "./contract.js";
import type { Contribution, JsonValue, RelationType } from "./models.js";
import type { ContributionStore } from "./store.js";

// ---------------------------------------------------------------------------
// Lifecycle States
// ---------------------------------------------------------------------------

/** Lifecycle states in descending precedence order. */
export const LifecycleState = {
  Superseded: "superseded",
  Challenged: "challenged",
  Adopted: "adopted",
  Reproduced: "reproduced",
  UnderReview: "under_review",
  Published: "published",
  Draft: "draft",
} as const;
export type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];

/**
 * Derive the lifecycle state for a single contribution.
 *
 * Queries the store for incoming relations and applies precedence rules.
 * For batch operations, prefer `deriveLifecycleStates()` which loads
 * all data in a single pass.
 */
export async function deriveLifecycleState(
  cid: string,
  store: ContributionStore,
): Promise<LifecycleState> {
  // Check for superseding derives_from relations
  const derivesFromIncoming = await store.relatedTo(cid, "derives_from" as RelationType);
  for (const c of derivesFromIncoming) {
    for (const rel of c.relations) {
      if (
        rel.targetCid === cid &&
        rel.relationType === "derives_from" &&
        rel.metadata?.relationship === "supersedes"
      ) {
        return LifecycleState.Superseded;
      }
    }
  }

  // Check for challenged reproductions
  const reproducesIncoming = await store.relatedTo(cid, "reproduces" as RelationType);
  let hasConfirmedReproduction = false;
  for (const c of reproducesIncoming) {
    for (const rel of c.relations) {
      if (rel.targetCid === cid && rel.relationType === "reproduces") {
        if (rel.metadata?.result === "challenged") {
          return LifecycleState.Challenged;
        }
        // confirmed, partial, or absent result = confirmed
        hasConfirmedReproduction = true;
      }
    }
  }

  // Check for adopts relations
  const adoptsIncoming = await store.relatedTo(cid, "adopts" as RelationType);
  if (adoptsIncoming.length > 0) {
    return LifecycleState.Adopted;
  }

  // Check for confirmed reproductions (already computed above)
  if (hasConfirmedReproduction) {
    return LifecycleState.Reproduced;
  }

  // Check for reviews relations
  const reviewsIncoming = await store.relatedTo(cid, "reviews" as RelationType);
  if (reviewsIncoming.length > 0) {
    return LifecycleState.UnderReview;
  }

  return LifecycleState.Published;
}

/**
 * Derive lifecycle states for multiple contributions in a single pass.
 *
 * Loads all contributions once, then computes states in-memory.
 * Much more efficient than calling `deriveLifecycleState()` per CID.
 */
export async function deriveLifecycleStates(
  cids: readonly string[],
  store: ContributionStore,
): Promise<ReadonlyMap<string, LifecycleState>> {
  if (cids.length === 0) return new Map();

  // Load all contributions for relation scanning
  const allContributions = await store.list();
  const cidSet = new Set(cids);

  // Build incoming relation index: target CID → source contributions
  const incomingByType = new Map<string, Map<string, Contribution[]>>();
  for (const cid of cids) {
    incomingByType.set(cid, new Map());
  }

  for (const c of allContributions) {
    for (const rel of c.relations) {
      if (cidSet.has(rel.targetCid)) {
        const byType = incomingByType.get(rel.targetCid);
        if (byType === undefined) continue;
        let sources = byType.get(rel.relationType);
        if (sources === undefined) {
          sources = [];
          byType.set(rel.relationType, sources);
        }
        sources.push(c);
      }
    }
  }

  const result = new Map<string, LifecycleState>();

  for (const cid of cids) {
    const byType = incomingByType.get(cid) ?? new Map();
    result.set(cid, deriveStateFromRelations(cid, byType, allContributions));
  }

  return result;
}

/** Derive lifecycle state from pre-computed incoming relation map. */
function deriveStateFromRelations(
  cid: string,
  byType: Map<string, Contribution[]>,
  _allContributions: readonly Contribution[],
): LifecycleState {
  // Check superseded: derives_from with metadata.relationship === "supersedes"
  const derivesFromSources = byType.get("derives_from") ?? [];
  for (const c of derivesFromSources) {
    for (const rel of c.relations) {
      if (
        rel.targetCid === cid &&
        rel.relationType === "derives_from" &&
        rel.metadata?.relationship === "supersedes"
      ) {
        return LifecycleState.Superseded;
      }
    }
  }

  // Check challenged vs reproduced
  const reproducesSources = byType.get("reproduces") ?? [];
  let hasConfirmedReproduction = false;
  for (const c of reproducesSources) {
    for (const rel of c.relations) {
      if (rel.targetCid === cid && rel.relationType === "reproduces") {
        if (rel.metadata?.result === "challenged") {
          return LifecycleState.Challenged;
        }
        hasConfirmedReproduction = true;
      }
    }
  }

  // Check adopted
  const adoptsSources = byType.get("adopts") ?? [];
  if (adoptsSources.length > 0) {
    return LifecycleState.Adopted;
  }

  // Check reproduced
  if (hasConfirmedReproduction) {
    return LifecycleState.Reproduced;
  }

  // Check under_review
  const reviewsSources = byType.get("reviews") ?? [];
  if (reviewsSources.length > 0) {
    return LifecycleState.UnderReview;
  }

  return LifecycleState.Published;
}

// ---------------------------------------------------------------------------
// Stop Condition Evaluation
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

/**
 * Evaluate all stop conditions defined in a grove contract.
 *
 * Returns a structured result indicating which conditions are met.
 * The grove is considered stopped if ANY condition is met.
 */
export async function evaluateStopConditions(
  contract: GroveContract,
  store: ContributionStore,
): Promise<StopEvaluationResult> {
  const conditions: Record<string, StopConditionResult> = {};
  const stopConditions = contract.stopConditions;

  if (stopConditions === undefined) {
    return { stopped: false, conditions: {}, evaluatedAt: new Date().toISOString() };
  }

  if (stopConditions.maxRoundsWithoutImprovement !== undefined) {
    conditions.max_rounds_without_improvement = await evaluateMaxRoundsWithoutImprovement(
      stopConditions.maxRoundsWithoutImprovement,
      contract.metrics ?? {},
      store,
    );
  }

  if (stopConditions.targetMetric !== undefined) {
    conditions.target_metric = await evaluateTargetMetric(
      stopConditions.targetMetric.metric,
      stopConditions.targetMetric.value,
      contract.metrics ?? {},
      store,
    );
  }

  if (stopConditions.budget !== undefined) {
    conditions.budget = await evaluateBudget(stopConditions.budget, store);
  }

  if (stopConditions.quorumReviewScore !== undefined) {
    conditions.quorum_review_score = await evaluateQuorumReviewScore(
      stopConditions.quorumReviewScore.minReviews,
      stopConditions.quorumReviewScore.minScore,
      store,
    );
  }

  if (stopConditions.deliberationLimit !== undefined) {
    conditions.deliberation_limit = await evaluateDeliberationLimit(
      stopConditions.deliberationLimit,
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

  const allContributions = await store.list();
  const isMinimize = metricDef.direction === "minimize";

  let bestScore: number | undefined;
  for (const c of allContributions) {
    if (c.mode === "exploration") continue;
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
    // Get the earliest contribution's createdAt
    const allContributions = await store.list();
    if (allContributions.length > 0) {
      const sorted = [...allContributions].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      );
      const first = sorted[0];
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

async function evaluateQuorumReviewScore(
  minReviews: number,
  minScore: number,
  store: ContributionStore,
): Promise<StopConditionResult> {
  const allContributions = await store.list();

  // Build map of target CID → { totalReviews, scores[] }
  // Per spec: reviews without metadata.score count toward min_reviews
  // but do not contribute to the average score calculation.
  const reviewsByTarget = new Map<string, { totalReviews: number; scores: number[] }>();

  for (const c of allContributions) {
    for (const rel of c.relations) {
      if (rel.relationType === "reviews") {
        let entry = reviewsByTarget.get(rel.targetCid);
        if (entry === undefined) {
          entry = { totalReviews: 0, scores: [] };
          reviewsByTarget.set(rel.targetCid, entry);
        }
        entry.totalReviews += 1;
        const score = rel.metadata?.score;
        if (typeof score === "number") {
          entry.scores.push(score);
        }
      }
    }
  }

  // Check if any contribution meets the quorum
  for (const [targetCid, entry] of reviewsByTarget) {
    if (entry.totalReviews >= minReviews && entry.scores.length > 0) {
      const avgScore = entry.scores.reduce((sum, s) => sum + s, 0) / entry.scores.length;
      if (avgScore >= minScore) {
        return {
          met: true,
          reason: `Contribution ${targetCid.slice(0, 20)}... has ${entry.totalReviews} reviews with avg score ${avgScore.toFixed(3)} >= ${minScore}`,
          details: {
            target_cid: targetCid,
            review_count: entry.totalReviews,
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
  store: ContributionStore,
): Promise<StopConditionResult> {
  // Find topic roots: CIDs that are responds_to targets but don't
  // themselves have outgoing responds_to relations.
  const roots = await findTopicRoots(store);

  // For each root, use store.thread() to compute depth and message count
  const exceededTopics: DeliberationResult[] = [];

  for (const rootCid of roots) {
    // Traverse the full thread — don't truncate at maxRounds.
    // maxRounds is the stop-condition threshold, not a traversal cap.
    // maxMessages needs an accurate total descendant count, so we must
    // walk the entire tree (capped at a high safety ceiling).
    const nodes = await store.thread(rootCid, { maxDepth: 10_000 });

    if (nodes.length === 0) continue;

    // Max depth = highest depth in thread; message count = nodes minus root
    let maxDepth = 0;
    for (const node of nodes) {
      if (node.depth > maxDepth) maxDepth = node.depth;
    }
    const messageCount = nodes.length - 1; // Exclude root itself

    const maxRoundsExceeded = limit.maxRounds !== undefined && maxDepth >= limit.maxRounds;
    const maxMessagesExceeded =
      limit.maxMessages !== undefined && messageCount >= limit.maxMessages;

    if (maxRoundsExceeded || maxMessagesExceeded) {
      exceededTopics.push({
        topicCid: rootCid,
        depth: maxDepth,
        messageCount,
        maxRoundsExceeded,
        maxMessagesExceeded,
      });
    }
  }

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
 * Find all topic roots in the store.
 *
 * A topic root is a CID that is a responds_to target but does not itself
 * have any outgoing responds_to relation (i.e., it's the start of a thread).
 */
async function findTopicRoots(store: ContributionStore): Promise<readonly string[]> {
  const allContributions = await store.list();

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

  // Roots: targets that are not themselves sources
  const roots: string[] = [];
  const allCids = new Set(allContributions.map((c) => c.cid));
  for (const targetCid of respondsToTargets) {
    if (!respondsToSources.has(targetCid) && allCids.has(targetCid)) {
      roots.push(targetCid);
    }
  }

  return roots;
}
