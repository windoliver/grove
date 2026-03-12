/**
 * Adapter utilities for bridging CLI commands to the shared operations layer.
 *
 * toOperationDeps — Convert CliDeps to OperationDeps
 */

import type { OperationDeps } from "../core/operations/deps.js";
import type { CliDeps } from "./context.js";

/**
 * Convert CliDeps to OperationDeps.
 *
 * CliDeps uses `store` for contributionStore; this adapter maps the field
 * names and passes through optional stores when present.
 */
export function toOperationDeps(deps: CliDeps): OperationDeps {
  return {
    contributionStore: deps.store,
    claimStore: deps.claimStore,
    cas: deps.cas,
    frontier: deps.frontier,
    ...(deps.workspace !== undefined ? { workspace: deps.workspace } : {}),
    ...(deps.outcomeStore !== undefined ? { outcomeStore: deps.outcomeStore } : {}),
  };
}
