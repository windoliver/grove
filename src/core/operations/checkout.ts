/**
 * Checkout operation.
 *
 * checkoutOperation — Materialize a contribution's artifacts to a workspace
 */

import type { JsonValue } from "../models.js";
import type { AgentOverrides } from "./agent.js";
import { resolveAgent } from "./agent.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { fromGroveError, notFound, ok, validationErr } from "./result.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of a checkout operation. */
export interface CheckoutResult {
  readonly cid: string;
  readonly workspacePath: string;
  readonly status: string;
  readonly agentId: string;
  readonly artifactCount: number;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Input for the checkout operation. */
export interface CheckoutInput {
  readonly cid: string;
  readonly agent?: AgentOverrides | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Materialize a contribution's artifacts to an isolated workspace. */
export async function checkoutOperation(
  input: CheckoutInput,
  deps: OperationDeps,
): Promise<OperationResult<CheckoutResult>> {
  try {
    if (deps.workspace === undefined) {
      return validationErr("Workspace manager not configured");
    }

    if (deps.contributionStore === undefined) {
      return validationErr("Checkout not available (missing contributionStore)");
    }

    // Verify contribution exists
    const contribution = await deps.contributionStore.get(input.cid);
    if (contribution === undefined) {
      return notFound("Contribution", input.cid);
    }

    const agent = resolveAgent(input.agent);

    const wsInfo = await deps.workspace.checkout(input.cid, {
      agent,
      ...(input.context !== undefined ? { context: input.context } : {}),
    });

    return ok({
      cid: wsInfo.cid,
      workspacePath: wsInfo.workspacePath,
      status: wsInfo.status,
      agentId: wsInfo.agent.agentId,
      artifactCount: Object.keys(contribution.artifacts).length,
      createdAt: wsInfo.createdAt,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}
