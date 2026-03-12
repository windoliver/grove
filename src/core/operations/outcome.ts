/**
 * Outcome operations.
 *
 * setOutcomeOperation   — Set outcome for a contribution
 * getOutcomeOperation   — Get outcome by CID
 * listOutcomesOperation — List outcomes with filters
 * outcomeStatsOperation — Get aggregated outcome statistics
 */

import type { OutcomeRecord, OutcomeStats, OutcomeStatus } from "../outcome.js";
import type { AgentOverrides } from "./agent.js";
import { resolveAgent } from "./agent.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { fromGroveError, notFound, ok, validationErr } from "./result.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Input for set outcome. */
export interface SetOutcomeInput {
  readonly cid: string;
  readonly status: OutcomeStatus;
  readonly reason?: string | undefined;
  readonly baselineCid?: string | undefined;
  readonly agent?: AgentOverrides | undefined;
}

/** Input for get outcome. */
export interface GetOutcomeInput {
  readonly cid: string;
}

/** Input for list outcomes. */
export interface ListOutcomesInput {
  readonly status?: OutcomeStatus | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Set the outcome for a contribution CID. */
export async function setOutcomeOperation(
  input: SetOutcomeInput,
  deps: OperationDeps,
): Promise<OperationResult<OutcomeRecord>> {
  try {
    if (deps.outcomeStore === undefined) {
      return validationErr("Outcome store not configured");
    }

    const agent = resolveAgent(input.agent);

    const record = await deps.outcomeStore.set(input.cid, {
      status: input.status,
      evaluatedBy: agent.agentId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.baselineCid !== undefined ? { baselineCid: input.baselineCid } : {}),
    });

    return ok(record);
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Get the outcome for a CID. */
export async function getOutcomeOperation(
  input: GetOutcomeInput,
  deps: OperationDeps,
): Promise<OperationResult<OutcomeRecord>> {
  try {
    if (deps.outcomeStore === undefined) {
      return validationErr("Outcome store not configured");
    }

    const record = await deps.outcomeStore.get(input.cid);
    if (!record) {
      return notFound("Outcome", input.cid);
    }

    return ok(record);
  } catch (error) {
    return fromGroveError(error);
  }
}

/** List outcomes with optional filters. */
export async function listOutcomesOperation(
  input: ListOutcomesInput,
  deps: OperationDeps,
): Promise<OperationResult<readonly OutcomeRecord[]>> {
  try {
    if (deps.outcomeStore === undefined) {
      return validationErr("Outcome store not configured");
    }

    const records = await deps.outcomeStore.list({
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    });

    return ok(records);
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Get aggregated outcome statistics. */
export async function outcomeStatsOperation(
  deps: OperationDeps,
): Promise<OperationResult<OutcomeStats>> {
  try {
    if (deps.outcomeStore === undefined) {
      return validationErr("Outcome store not configured");
    }

    const stats = await deps.outcomeStore.getStats();
    return ok(stats);
  } catch (error) {
    return fromGroveError(error);
  }
}
