/**
 * Enforcement pipeline — decorator that validates agent constraints
 * from GROVE.md contract before delegating to contributeOperation.
 *
 * Checks: allowedKinds, requiredArtifacts, requiredRelations.
 * Returns structured rejection on violation.
 *
 * @see https://github.com/windoliver/grove/issues/136
 */

import type { AgentConstraints } from "./contract.js";
import type { ContributionKind } from "./models.js";
import type { ContributeInput, ContributeResult } from "./operations/contribute.js";
import { contributeOperation } from "./operations/contribute.js";
import type { OperationDeps } from "./operations/deps.js";
import type { OperationResult } from "./operations/result.js";
import { validationErr } from "./operations/result.js";

/** Structured rejection with field-level detail. */
export interface EnforcementRejection {
  readonly rejected: true;
  readonly reason: string;
  readonly field: string;
  readonly hint: string;
}

function reject(reason: string, field: string, hint: string): EnforcementRejection {
  return { rejected: true, reason, field, hint };
}

/**
 * Validate agent constraints from the contract against the contribution input.
 * Returns a rejection if any constraint is violated, or undefined if all pass.
 */
export function checkAgentConstraints(
  input: ContributeInput,
  constraints: AgentConstraints,
): EnforcementRejection | undefined {
  // 1. allowedKinds — is this contribution kind permitted?
  if (constraints.allowedKinds && constraints.allowedKinds.length > 0) {
    if (!constraints.allowedKinds.includes(input.kind)) {
      return reject(
        `Kind '${input.kind}' is not allowed`,
        "kind",
        `Allowed kinds: ${constraints.allowedKinds.join(", ")}`,
      );
    }
  }

  // 2. requiredArtifacts — does this kind require specific artifact names?
  const requiredArts = constraints.requiredArtifacts?.[input.kind as ContributionKind];
  if (requiredArts && requiredArts.length > 0) {
    const provided = input.artifacts ? Object.keys(input.artifacts) : [];
    for (const name of requiredArts) {
      if (!provided.includes(name)) {
        return reject(
          `Missing required artifact '${name}' for kind '${input.kind}'`,
          "artifacts",
          `Required artifacts for ${input.kind}: ${requiredArts.join(", ")}`,
        );
      }
    }
  }

  // 3. requiredRelations — does this kind require specific relation types?
  const requiredRels = constraints.requiredRelations?.[input.kind as ContributionKind];
  if (requiredRels && requiredRels.length > 0) {
    const provided = input.relations?.map((r) => r.relationType) ?? [];
    for (const relType of requiredRels) {
      if (!provided.includes(relType)) {
        return reject(
          `Missing required relation '${relType}' for kind '${input.kind}'`,
          "relations",
          `Required relations for ${input.kind}: ${requiredRels.join(", ")}`,
        );
      }
    }
  }

  return undefined;
}

/**
 * Enforcement pipeline — wraps contributeOperation with contract constraint checks.
 * If no contract or no agentConstraints, passes through directly.
 */
export async function enforcedContribute(
  input: ContributeInput,
  deps: OperationDeps,
): Promise<OperationResult<ContributeResult>> {
  const contract = deps.contract;

  if (contract?.agentConstraints) {
    const rejection = checkAgentConstraints(input, contract.agentConstraints);
    if (rejection) {
      return validationErr(`${rejection.reason}. ${rejection.hint}`);
    }
  }

  return contributeOperation(input, deps);
}
