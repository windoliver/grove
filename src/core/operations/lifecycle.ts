/**
 * Lifecycle operations.
 *
 * checkStopOperation — Evaluate stop conditions from GROVE.md contract
 */

import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { fromGroveError, ok } from "./result.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Individual stop condition result. */
export interface StopConditionStatus {
  readonly met: boolean;
  readonly reason: string;
  readonly details?: Record<string, unknown> | undefined;
}

/** Result of a check stop operation. */
export interface CheckStopResult {
  readonly stopped: boolean;
  readonly reason: string;
  readonly conditions: Readonly<Record<string, StopConditionStatus>>;
  readonly evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Evaluate stop conditions from GROVE.md contract. */
export async function checkStopOperation(
  deps: OperationDeps,
): Promise<OperationResult<CheckStopResult>> {
  try {
    if (deps.contract === undefined) {
      return ok({
        stopped: false,
        reason: "No GROVE.md contract defined — stop conditions not configured",
        conditions: {},
        evaluatedAt: new Date().toISOString(),
      });
    }

    // Lazy import to avoid circular dependency at module load time.
    const { evaluateStopConditions } = await import("../lifecycle.js");
    const result = await evaluateStopConditions(deps.contract, deps.contributionStore);

    return ok({
      stopped: result.stopped,
      reason: result.stopped
        ? Object.entries(result.conditions)
            .filter(([, c]) => c.met)
            .map(([name, c]) => `${name}: ${c.reason}`)
            .join("; ")
        : "No stop conditions met",
      conditions: result.conditions as unknown as Record<string, StopConditionStatus>,
      evaluatedAt: result.evaluatedAt,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}
