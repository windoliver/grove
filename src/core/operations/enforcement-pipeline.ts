/**
 * Contract enforcement pipeline for contributions.
 *
 * Decorator wrapping contributeOperation with pre-contribute validation
 * (agent constraints, gates) and post-contribute stop condition evaluation.
 */

import type { AgentConstraints, Gate } from "../contract.js";
import { evaluateStopConditions } from "../lifecycle.js";
import type { ContributeInput, ContributeResult } from "./contribute.js";
import { contributeOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { err, OperationErrorCode } from "./result.js";

/** Structured rejection with field + hint for agent feedback. */
export interface EnforcementRejection {
  readonly reason: string;
  readonly field?: string;
  readonly hint?: string;
}

/** Contribute result enriched with stop-condition status. */
export interface EnforcedContributeResult extends ContributeResult {
  readonly stopped?: boolean;
}

// ---------------------------------------------------------------------------
// Agent constraint checks
// ---------------------------------------------------------------------------

function enforceConstraints(
  input: ContributeInput,
  ac: AgentConstraints,
): EnforcementRejection | undefined {
  // 1. allowedKinds
  if (ac.allowedKinds && !ac.allowedKinds.includes(input.kind)) {
    return {
      reason: `Kind '${input.kind}' not allowed`,
      field: "kind",
      hint: `Allowed: ${ac.allowedKinds.join(", ")}`,
    };
  }
  // 2. requiredArtifacts
  const reqArt = ac.requiredArtifacts?.[input.kind];
  if (reqArt) {
    const arts = input.artifacts ?? {};
    const missing = reqArt.filter((n) => !(n in arts));
    if (missing.length > 0) {
      return { reason: `Missing required artifacts: ${missing.join(", ")}`, field: "artifacts" };
    }
  }
  // 3. requiredRelations
  const reqRel = ac.requiredRelations?.[input.kind];
  if (reqRel) {
    const present = new Set((input.relations ?? []).map((r) => r.relationType));
    const missing = reqRel.filter((rt) => !present.has(rt));
    if (missing.length > 0) {
      return { reason: `Missing required relations: ${missing.join(", ")}`, field: "relations" };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pre-contribute gate checks
// ---------------------------------------------------------------------------

function enforceGates(
  input: ContributeInput,
  gates: readonly Gate[],
  isFirstContribution: boolean,
): EnforcementRejection | undefined {
  for (const gate of gates) {
    switch (gate.type) {
      case "has_artifact":
        if (gate.name && !(gate.name in (input.artifacts ?? {}))) {
          return { reason: `Gate failed: missing artifact '${gate.name}'`, field: "artifacts" };
        }
        break;
      case "has_relation":
        if (gate.relationType) {
          const has = (input.relations ?? []).some((r) => r.relationType === gate.relationType);
          if (!has) {
            return {
              reason: `Gate failed: missing '${gate.relationType}' relation`,
              field: "relations",
            };
          }
        }
        break;
      case "min_score":
        if (gate.metric && gate.threshold !== undefined) {
          const val = input.scores?.[gate.metric]?.value;
          if (val === undefined || val < gate.threshold) {
            return {
              reason: `Gate failed: ${gate.metric} score ${val ?? "missing"} < ${gate.threshold}`,
              field: "scores",
            };
          }
        }
        break;
      case "metric_improves":
        if (isFirstContribution) break; // auto-pass: establishes baseline
        // TODO: compare against frontier best — requires FrontierCalculator
        break;
      case "min_reviews":
        break; // post-contribute check — not enforced at submission time
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

function reject(r: EnforcementRejection): OperationResult<EnforcedContributeResult> {
  return err({
    code: OperationErrorCode.ValidationError,
    message: r.reason,
    details: { rejected: true, field: r.field, hint: r.hint },
  });
}

/**
 * Enforced contribute: validates contract constraints and gates before
 * delegating to contributeOperation, then evaluates stop conditions.
 */
export async function enforcedContributeOperation(
  input: ContributeInput,
  deps: OperationDeps,
): Promise<OperationResult<EnforcedContributeResult>> {
  const contract = deps.contract;

  // Pre-contribute: agent constraints
  if (contract?.agentConstraints) {
    const violation = enforceConstraints(input, contract.agentConstraints);
    if (violation) return reject(violation);
  }

  // Pre-contribute: gates
  if (contract?.gates?.length) {
    const store = deps.contributionStore;
    const isFirst = store ? (await store.list({ limit: 1 })).length === 0 : true;
    const violation = enforceGates(input, contract.gates, isFirst);
    if (violation) return reject(violation);
  }

  // Delegate to core contribute operation
  const result = await contributeOperation(input, deps);
  if (!result.ok) return result;

  // Post-contribute: evaluate stop conditions
  let stopped = false;
  if (contract?.stopConditions && deps.contributionStore) {
    const eval_ = await evaluateStopConditions(contract, deps.contributionStore);
    stopped = eval_.stopped;
  }

  return { ok: true, value: { ...result.value, stopped } };
}
