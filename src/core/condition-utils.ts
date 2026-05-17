/**
 * Shared utilities for managing Kubernetes-style condition arrays.
 *
 * Extracted from task-controller.ts and claim-controller.ts so that
 * server-side route handlers (e.g. POST /api/agent-tasks/:id/done) can
 * perform condition upserts without pulling in controller-specific deps.
 */

import type { Condition } from "./entity.js";

/**
 * Upsert a condition into an immutable conditions array.
 *
 * - If no condition of the same type exists, appends the desired condition.
 * - If a matching condition exists and its status/reason/message are
 *   unchanged, preserves the original `lastTransitionTime`.
 * - Returns the original array reference when nothing changed (cheap equality
 *   check via `conditionEqual`).
 */
export function upsertCondition(
  conditions: readonly Condition[],
  desired: Condition,
): readonly Condition[] {
  const index = conditions.findIndex((condition) => condition.type === desired.type);
  if (index === -1) {
    return [...conditions, desired];
  }

  const existing = conditions[index];
  if (existing === undefined) return conditions;
  const next: Condition =
    existing.status === desired.status &&
    existing.reason === desired.reason &&
    existing.message === desired.message
      ? {
          ...desired,
          lastTransitionTime: existing.lastTransitionTime,
        }
      : desired;

  if (conditionEqual(existing, next)) return conditions;

  return conditions.map((condition, conditionIndex) =>
    conditionIndex === index ? next : condition,
  );
}

export function conditionEqual(left: Condition, right: Condition): boolean {
  return (
    left.type === right.type &&
    left.status === right.status &&
    left.observedGeneration === right.observedGeneration &&
    left.lastTransitionTime === right.lastTransitionTime &&
    left.reason === right.reason &&
    left.message === right.message
  );
}
