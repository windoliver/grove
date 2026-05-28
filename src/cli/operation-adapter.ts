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
    ...(deps.timelineStore !== undefined ? { timelineStore: deps.timelineStore } : {}),
    cas: deps.cas,
    frontier: deps.frontier,
    ...(deps.workspace !== undefined ? { workspace: deps.workspace } : {}),
    ...(deps.outcomeStore !== undefined ? { outcomeStore: deps.outcomeStore } : {}),
    ...(deps.hookRunner !== undefined ? { hookRunner: deps.hookRunner } : {}),
    ...(deps.hookCwd !== undefined ? { hookCwd: deps.hookCwd } : {}),
    ...(deps.admissionPermissionResolver !== undefined
      ? { admissionPermissionResolver: deps.admissionPermissionResolver }
      : {}),
    ...(deps.admissionGovernanceEvaluator !== undefined
      ? { admissionGovernanceEvaluator: deps.admissionGovernanceEvaluator }
      : {}),
    ...(deps.blueprintHashSource !== undefined
      ? { blueprintHashSource: deps.blueprintHashSource }
      : {}),
    ...(deps.artifactSignatureVerifier !== undefined
      ? { artifactSignatureVerifier: deps.artifactSignatureVerifier }
      : {}),
    ...(deps.zoneId !== undefined ? { zoneId: deps.zoneId } : {}),
  };
}
