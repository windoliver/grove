/**
 * Contract policy enforcement pipeline for contributions.
 *
 * Enforces semantic rules defined in the GROVE.md contract that go beyond
 * the rate-limit/artifact enforcement in enforcing-store.ts:
 *
 * 1. Score requirements — reject contributions missing required metrics
 * 2. Gate checks — metric_improves, has_artifact, has_relation, min_score
 * 3. Role-kind constraints — restrict which kinds each role can submit
 * 4. Relation requirements — enforce required relations per kind
 * 5. Artifact requirements — enforce required artifacts per kind
 * 6. Outcome derivation — auto-derive improved/regressed/accepted
 *
 * Design decisions:
 * - Accept-then-flag: contributions are always written to the DAG.
 *   Gate failures are returned as flags, not rejections, unless the
 *   contract is in strict evaluation mode.
 * - The enforcer runs inside the write mutex for validation and derived
 *   outcome work. Hooks, events, and stop-condition evaluation run outside.
 * - No re-entrant evaluation: outcome derivation is linear, never recursive.
 */

import type { Gate, MetricDefinition } from "./contract.js";
import { PolicyViolationError } from "./errors.js";
import type { Contribution } from "./models.js";
import { ContributionMode } from "./models.js";
import type { OutcomeRecord, OutcomeStore } from "./outcome.js";
import { OutcomeStatus } from "./outcome.js";
import type { SessionRuntimeConfig } from "./session-config.js";
import type { ContributionStore } from "./store.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of policy enforcement on a single contribution. */
export interface PolicyEnforcementResult {
  /** Whether the contribution passed all enforcement checks. */
  readonly passed: boolean;
  /** Violations found (empty if passed). */
  readonly violations: readonly PolicyViolation[];
  /** Derived outcome, if any (only for evaluation mode with outcome policy). */
  readonly derivedOutcome?: DerivedOutcome | undefined;
  /** Stop condition result, if evaluated. */
  readonly stopResult?: StopCheckResult | undefined;
}

/** A single policy violation. */
export interface PolicyViolation {
  readonly type:
    | "missing_score"
    | "gate_failed"
    | "role_kind"
    | "missing_relation"
    | "missing_artifact"
    | "missing_context";
  readonly message: string;
  readonly details: Record<string, unknown>;
}

/** Outcome derived from structured data. */
export interface DerivedOutcome {
  readonly status: "accepted" | "rejected";
  readonly reason: string;
  readonly metricName?: string | undefined;
  readonly currentValue?: number | undefined;
  readonly previousBest?: number | undefined;
}

/** Result of stop condition check after a contribution. */
export interface StopCheckResult {
  readonly stopped: boolean;
  readonly reason?: string | undefined;
  /**
   * When `true`, stop evaluation did not complete with confidence — the
   * scanning evaluators (`quorum_review_score`, `deliberation_limit`) could
   * not be run (e.g., sustained store read failures on the post-write
   * recheck path). Callers must NOT treat `stopped=false` as authoritative
   * in this state; they should gate on `degraded === true` and surface
   * alerts or conservative behavior to operators. See Codex review r5.
   */
  readonly degraded?: boolean | undefined;
}

export interface PolicyEnforcerOptions {
  readonly skipGateEnforcement?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// PolicyEnforcer
// ---------------------------------------------------------------------------

/**
 * Enforce contract policies on contributions.
 *
 * This is a stateless utility — all state is read from the stores.
 * Callers are responsible for running this inside a write mutex.
 */
export class PolicyEnforcer {
  private readonly config: SessionRuntimeConfig;
  private readonly contributionStore: ContributionStore;
  private readonly outcomeStore: OutcomeStore | undefined;
  private readonly skipGateEnforcement: boolean;

  /**
   * Lazily-populated cache of best scores per metric.
   * Populated on first findBestScore() call via table scan, then updated
   * incrementally when new contributions with scores are processed.
   * Avoids O(n) scans on every gate/outcome/stop check within a single enforce() call.
   */
  private bestScoreCache:
    | Map<string, { value: number; cid: string; createdAt: string }>
    | undefined;

  constructor(
    config: SessionRuntimeConfig,
    contributionStore: ContributionStore,
    outcomeStore?: OutcomeStore | undefined,
    options?: PolicyEnforcerOptions | undefined,
  ) {
    this.config = config;
    this.contributionStore = contributionStore;
    this.outcomeStore = outcomeStore;
    this.skipGateEnforcement = options?.skipGateEnforcement ?? false;
  }

  /**
   * Enforce all applicable policies for a contribution.
   *
   * In strict mode (evaluation mode with enforcement), violations throw
   * PolicyViolationError. In lenient mode (exploration), violations are
   * returned as flags.
   *
   * Design decisions (Issue 6):
   *
   * - **Accept-then-flag**: Contributions are always written to the DAG.
   *   Gate failures in lenient mode are returned as violation flags in
   *   the result, not rejections. Only strict mode throws. This ensures
   *   the contribution graph is append-only and hook failures are metadata.
   *
   * - **Linear pipeline**: The enforcement sequence is: role-kind check →
   *   score requirements → relation requirements → artifact requirements →
   *   gate checks → outcome derivation. There is no re-entrant evaluation —
   *   outcome derivation runs exactly once per enforce() call, never
   *   recursively.
   *
   * - **Config hot-reload**: Deferred. The config is resolved once at
   *   startup (or session init) and passed to the PolicyEnforcer
   *   constructor. Runtime config reloading is not supported — callers
   *   must construct a new PolicyEnforcer instance with the updated
   *   config.
   *
   * @param contribution - The contribution to enforce (already created but not yet stored).
   * @param strict - If true, violations throw instead of being returned as flags.
   * Stop-condition evaluation is deliberately outside this method. Contribution
   * writes evaluate stops after persistence in `contributeOperation`, and
   * lifecycle/MCP callers use `evaluateStopConditions()` directly.
   */
  async enforce(contribution: Contribution, strict = false): Promise<PolicyEnforcementResult> {
    // Reset best-score cache so each enforce() call gets a fresh view of the store.
    // The cache is repopulated lazily on the first findBestScore() call within
    // this invocation, keeping per-call O(n) scan cost to at most once.
    this.bestScoreCache = undefined;

    const violations: PolicyViolation[] = [];

    // 1. Role-kind constraints
    const roleKindViolation = this.enforceRoleKind(contribution);
    if (roleKindViolation !== undefined) {
      if (strict) {
        throw new PolicyViolationError({
          violationType: "role_kind",
          details: roleKindViolation.details,
          message: roleKindViolation.message,
        });
      }
      violations.push(roleKindViolation);
    }

    // 2. Score requirements (evaluation mode only)
    if (contribution.mode === ContributionMode.Evaluation && !this.skipGateEnforcement) {
      const scoreViolations = this.enforceScoreRequirements(contribution);
      for (const v of scoreViolations) {
        if (strict) {
          throw new PolicyViolationError({
            violationType: "missing_score",
            details: v.details,
            message: v.message,
          });
        }
        violations.push(v);
      }
    }

    // 3. Relation requirements
    const relationViolations = this.enforceRelationRequirements(contribution);
    for (const v of relationViolations) {
      if (strict) {
        throw new PolicyViolationError({
          violationType: "missing_relation",
          details: v.details,
          message: v.message,
        });
      }
      violations.push(v);
    }

    // 4. Artifact requirements
    const artifactViolations = this.enforceArtifactRequirements(contribution);
    for (const v of artifactViolations) {
      if (strict) {
        throw new PolicyViolationError({
          violationType: "missing_artifact",
          details: v.details,
          message: v.message,
        });
      }
      violations.push(v);
    }

    // 5. Structured evaluation enforcement (evaluation mode only)
    if (contribution.mode === ContributionMode.Evaluation && contribution.kind === "work") {
      const evalViolations = this.enforceEvaluation(contribution);
      for (const v of evalViolations) {
        if (strict) {
          throw new PolicyViolationError({
            violationType: v.type as "missing_score" | "missing_context" | "missing_artifact",
            details: v.details,
            message: v.message,
          });
        }
        violations.push(v);
      }
    }

    // 6. Gate checks (evaluation mode only)
    if (
      contribution.mode === ContributionMode.Evaluation &&
      this.config.gates !== undefined &&
      !this.skipGateEnforcement
    ) {
      const gateViolations = await this.enforceGates(contribution);
      for (const v of gateViolations) {
        if (strict) {
          throw new PolicyViolationError({
            violationType: "gate_failed",
            details: v.details,
            message: v.message,
          });
        }
        violations.push(v);
      }
    }

    // 7. Derive outcome (post-write, so this is informational)
    let derivedOutcome: DerivedOutcome | undefined;
    if (
      contribution.mode === ContributionMode.Evaluation &&
      this.config.outcomePolicy !== undefined
    ) {
      derivedOutcome = await this.deriveOutcome(contribution);
    }

    return {
      passed: violations.length === 0,
      violations,
      derivedOutcome,
    };
  }

  /**
   * Persist derived outcome to the outcome store.
   * Called after the contribution is written to the DAG.
   */
  async persistOutcome(cid: string, outcome: DerivedOutcome): Promise<OutcomeRecord | undefined> {
    if (this.outcomeStore === undefined) return undefined;

    return this.outcomeStore.set(cid, {
      status: outcome.status === "accepted" ? OutcomeStatus.Accepted : OutcomeStatus.Rejected,
      reason: outcome.reason,
      evaluatedBy: "system:policy-enforcer",
    });
  }

  // ---------------------------------------------------------------------------
  // Enforcement checks
  // ---------------------------------------------------------------------------

  /** Check role-kind constraints from agentConstraints. */
  private enforceRoleKind(contribution: Contribution): PolicyViolation | undefined {
    const constraints = this.config.agentConstraints;
    if (constraints?.allowedKinds === undefined) return undefined;

    const allowed = constraints.allowedKinds;
    if (!allowed.includes(contribution.kind)) {
      return {
        type: "role_kind",
        message: `Agent role is not allowed to submit kind '${contribution.kind}'. Allowed: ${allowed.join(", ")}`,
        details: {
          kind: contribution.kind,
          allowedKinds: [...allowed],
          agentId: contribution.agent.agentId,
          role: contribution.agent.role,
        },
      };
    }

    return undefined;
  }

  /**
   * Check that required metrics are present in scores.
   *
   * Score requirements are only enforced when the contract's gates include
   * gates that reference specific metrics (e.g., metric_improves, min_score).
   * Simply having metrics defined in the contract does NOT make them required
   * on every contribution — metrics are optional unless gated.
   */
  private enforceScoreRequirements(contribution: Contribution): PolicyViolation[] {
    const gates = this.config.gates;
    if (gates === undefined || gates.length === 0) return [];

    // Only enforce score requirements for work contributions in evaluation mode
    if (contribution.kind !== "work") return [];

    // Collect metrics that are required by gates
    const requiredMetrics = new Set<string>();
    for (const gate of gates) {
      if (gate.metric !== undefined) {
        if (gate.type === "metric_improves" || gate.type === "min_score") {
          requiredMetrics.add(gate.metric);
        }
      }
    }

    if (requiredMetrics.size === 0) return [];

    const violations: PolicyViolation[] = [];
    for (const metricName of requiredMetrics) {
      if (contribution.scores?.[metricName] === undefined) {
        violations.push({
          type: "missing_score",
          message: `Metric '${metricName}' is required by gate but not provided in scores`,
          details: {
            metric: metricName,
            requiredByGate: true,
            providedScores: Object.keys(contribution.scores ?? {}),
          },
        });
      }
    }

    return violations;
  }

  /** Check relation requirements per kind from agentConstraints. */
  private enforceRelationRequirements(contribution: Contribution): PolicyViolation[] {
    const constraints = this.config.agentConstraints;
    if (constraints?.requiredRelations === undefined) return [];

    const requiredForKind = constraints.requiredRelations[contribution.kind];
    if (requiredForKind === undefined) return [];

    const violations: PolicyViolation[] = [];
    const presentTypes = new Set(contribution.relations.map((r) => r.relationType));

    for (const requiredType of requiredForKind) {
      if (!presentTypes.has(requiredType)) {
        violations.push({
          type: "missing_relation",
          message: `Kind '${contribution.kind}' requires a '${requiredType}' relation`,
          details: {
            kind: contribution.kind,
            requiredRelationType: requiredType,
            presentRelationTypes: [...presentTypes],
          },
        });
      }
    }

    return violations;
  }

  /** Check artifact requirements per kind from agentConstraints. */
  private enforceArtifactRequirements(contribution: Contribution): PolicyViolation[] {
    const constraints = this.config.agentConstraints;
    if (constraints?.requiredArtifacts === undefined) return [];

    const requiredForKind = constraints.requiredArtifacts[contribution.kind];
    if (requiredForKind === undefined) return [];

    const violations: PolicyViolation[] = [];
    const presentNames = new Set(Object.keys(contribution.artifacts));

    for (const requiredName of requiredForKind) {
      if (!presentNames.has(requiredName)) {
        violations.push({
          type: "missing_artifact",
          message: `Kind '${contribution.kind}' requires artifact '${requiredName}'`,
          details: {
            kind: contribution.kind,
            requiredArtifact: requiredName,
            presentArtifacts: [...presentNames],
          },
        });
      }
    }

    return violations;
  }

  /** Enforce structured evaluation requirements from contract.evaluation. */
  private enforceEvaluation(contribution: Contribution): PolicyViolation[] {
    const evalConfig = this.config.evaluation;
    if (evalConfig === undefined) return [];

    const violations: PolicyViolation[] = [];

    // Required scores
    if (evalConfig.requiredScores !== undefined) {
      for (const scoreName of evalConfig.requiredScores) {
        if (contribution.scores?.[scoreName] === undefined) {
          violations.push({
            type: "missing_score",
            message: `Evaluation requires score '${scoreName}' but not provided`,
            details: { score: scoreName, providedScores: Object.keys(contribution.scores ?? {}) },
          });
        }
      }
    }

    // Required context fields
    if (evalConfig.requiredContext !== undefined) {
      for (const contextKey of evalConfig.requiredContext) {
        if (contribution.context?.[contextKey] === undefined) {
          violations.push({
            type: "missing_context",
            message: `Evaluation requires context field '${contextKey}' but not provided`,
            details: { contextKey, providedContext: Object.keys(contribution.context ?? {}) },
          });
        }
      }
    }

    // Reproducibility: required artifacts
    if (evalConfig.reproducibility?.requireArtifacts !== undefined) {
      for (const artifactName of evalConfig.reproducibility.requireArtifacts) {
        if (contribution.artifacts[artifactName] === undefined) {
          violations.push({
            type: "missing_artifact",
            message: `Reproducibility requires artifact '${artifactName}' but not provided`,
            details: {
              artifact: artifactName,
              providedArtifacts: Object.keys(contribution.artifacts),
            },
          });
        }
      }
    }

    // Reproducibility: require command in context
    if (evalConfig.reproducibility?.requireCommand === true) {
      if (contribution.context?.command === undefined) {
        violations.push({
          type: "missing_context",
          message: "Reproducibility requires context.command but not provided",
          details: { contextKey: "command" },
        });
      }
    }

    return violations;
  }

  /** Evaluate gate checks against the current store state. */
  private async enforceGates(contribution: Contribution): Promise<PolicyViolation[]> {
    const gates = this.config.gates;
    if (gates === undefined) return [];

    const violations: PolicyViolation[] = [];

    for (const gate of gates) {
      const violation = await this.evaluateGate(gate, contribution);
      if (violation !== undefined) {
        violations.push(violation);
      }
    }

    return violations;
  }

  /** Evaluate a single gate against a contribution. */
  private async evaluateGate(
    gate: Gate,
    contribution: Contribution,
  ): Promise<PolicyViolation | undefined> {
    switch (gate.type) {
      case "metric_improves":
        return this.evaluateMetricImprovesGate(gate, contribution);
      case "has_artifact":
        return this.evaluateHasArtifactGate(gate, contribution);
      case "has_relation":
        return this.evaluateHasRelationGate(gate, contribution);
      case "min_score":
        return this.evaluateMinScoreGate(gate, contribution);
      case "min_reviews":
        // min_reviews is a stop condition, not a per-contribution gate
        return undefined;
      default:
        return undefined;
    }
  }

  /** Check if a contribution's metric improves over the current best. */
  private async evaluateMetricImprovesGate(
    gate: Gate,
    contribution: Contribution,
  ): Promise<PolicyViolation | undefined> {
    const metricName = gate.metric;
    if (metricName === undefined) return undefined;

    const score = contribution.scores?.[metricName];
    if (score === undefined) {
      // No score for this metric — gate doesn't apply
      return undefined;
    }

    const metricDef = this.config.metrics?.[metricName];
    if (metricDef === undefined) return undefined;

    const currentBest = await this.findBestScore(metricName, metricDef);
    if (currentBest === undefined) {
      // No existing scores — first contribution always passes
      return undefined;
    }

    const isMinimize = metricDef.direction === "minimize";
    const improves = isMinimize ? score.value < currentBest.value : score.value > currentBest.value;

    if (!improves) {
      return {
        type: "gate_failed",
        message: `Gate 'metric_improves' failed: ${metricName} = ${score.value} does not improve over best ${currentBest.value} (${metricDef.direction})`,
        details: {
          gate: "metric_improves",
          metric: metricName,
          currentValue: score.value,
          bestValue: currentBest.value,
          direction: metricDef.direction,
        },
      };
    }

    return undefined;
  }

  /** Check if a contribution has a required artifact. */
  private evaluateHasArtifactGate(
    gate: Gate,
    contribution: Contribution,
  ): PolicyViolation | undefined {
    const artifactName = gate.name;
    if (artifactName === undefined) return undefined;

    if (contribution.artifacts[artifactName] === undefined) {
      return {
        type: "gate_failed",
        message: `Gate 'has_artifact' failed: artifact '${artifactName}' not present`,
        details: {
          gate: "has_artifact",
          requiredArtifact: artifactName,
          presentArtifacts: Object.keys(contribution.artifacts),
        },
      };
    }

    return undefined;
  }

  /** Check if a contribution has a required relation type. */
  private evaluateHasRelationGate(
    gate: Gate,
    contribution: Contribution,
  ): PolicyViolation | undefined {
    const relationType = gate.relationType;
    if (relationType === undefined) return undefined;

    const hasRelation = contribution.relations.some((r) => r.relationType === relationType);
    if (!hasRelation) {
      return {
        type: "gate_failed",
        message: `Gate 'has_relation' failed: no '${relationType}' relation present`,
        details: {
          gate: "has_relation",
          requiredRelationType: relationType,
          presentRelationTypes: contribution.relations.map((r) => r.relationType),
        },
      };
    }

    return undefined;
  }

  /** Check if a contribution's score meets a minimum threshold. */
  private evaluateMinScoreGate(
    gate: Gate,
    contribution: Contribution,
  ): PolicyViolation | undefined {
    const metricName = gate.metric;
    const threshold = gate.threshold;
    if (metricName === undefined || threshold === undefined) return undefined;

    const score = contribution.scores?.[metricName];
    if (score === undefined) {
      // No score — gate doesn't apply for this contribution
      return undefined;
    }

    if (score.value < threshold) {
      return {
        type: "gate_failed",
        message: `Gate 'min_score' failed: ${metricName} = ${score.value} < threshold ${threshold}`,
        details: {
          gate: "min_score",
          metric: metricName,
          currentValue: score.value,
          threshold,
        },
      };
    }

    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Outcome derivation
  // ---------------------------------------------------------------------------

  /** Derive an outcome from the contribution's scores and the contract's outcome policy. */
  private async deriveOutcome(contribution: Contribution): Promise<DerivedOutcome | undefined> {
    const policy = this.config.outcomePolicy;
    if (policy === undefined) return undefined;

    // Only derive outcomes for work contributions
    if (contribution.kind !== "work") return undefined;

    // Check auto-accept: metric_improves
    if (policy.autoAccept?.metricImproves !== undefined) {
      const metricName = policy.autoAccept.metricImproves;
      const score = contribution.scores?.[metricName];
      if (score !== undefined) {
        const metricDef = this.config.metrics?.[metricName];
        if (metricDef !== undefined) {
          const currentBest = await this.findBestScore(metricName, metricDef);
          if (currentBest === undefined) {
            // First score — auto-accept
            return {
              status: "accepted",
              reason: `First score for '${metricName}': ${score.value}`,
              metricName,
              currentValue: score.value,
            };
          }

          const isMinimize = metricDef.direction === "minimize";
          const improves = isMinimize
            ? score.value < currentBest.value
            : score.value > currentBest.value;

          if (improves) {
            return {
              status: "accepted",
              reason: `Metric '${metricName}' improved: ${score.value} ${isMinimize ? "<" : ">"} ${currentBest.value}`,
              metricName,
              currentValue: score.value,
              previousBest: currentBest.value,
            };
          }
        }
      }
    }

    // Check auto-accept: all_gates_pass
    if (policy.autoAccept?.allGatesPass === true && this.config.gates !== undefined) {
      const gateViolations = await this.enforceGates(contribution);
      if (gateViolations.length === 0) {
        return {
          status: "accepted",
          reason: "All gates passed",
        };
      }
    }

    // Check auto-reject: metric_regresses
    if (policy.autoReject?.metricRegresses !== undefined) {
      const metricName = policy.autoReject.metricRegresses;
      const score = contribution.scores?.[metricName];
      if (score !== undefined) {
        const metricDef = this.config.metrics?.[metricName];
        if (metricDef !== undefined) {
          const currentBest = await this.findBestScore(metricName, metricDef);
          if (currentBest !== undefined) {
            const isMinimize = metricDef.direction === "minimize";
            const regresses = isMinimize
              ? score.value > currentBest.value
              : score.value < currentBest.value;

            if (regresses) {
              return {
                status: "rejected",
                reason: `Metric '${metricName}' regressed: ${score.value} ${isMinimize ? ">" : "<"} ${currentBest.value}`,
                metricName,
                currentValue: score.value,
                previousBest: currentBest.value,
              };
            }
          }
        }
      }
    }

    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the best score for a metric across all evaluation-mode contributions.
   *
   * Uses a lazily-populated in-memory cache: first call performs an O(n) table
   * scan and populates the cache for ALL metrics; subsequent calls are O(1).
   */
  private async findBestScore(
    metricName: string,
    _metricDef: MetricDefinition,
  ): Promise<{ value: number; cid: string; createdAt: string } | undefined> {
    // Populate cache on first access (cold start)
    if (this.bestScoreCache === undefined) {
      this.bestScoreCache = new Map();
      const contributions = await this.contributionStore.list({
        mode: ContributionMode.Evaluation,
      });
      for (const c of contributions) {
        this.updateCacheFromContribution(c);
      }
    }

    // If the caller-specified direction doesn't match what was cached,
    // the cache is still correct — it was populated using contract metric definitions.
    // But fall back for metrics not in the contract.
    const cached = this.bestScoreCache.get(metricName);
    if (cached !== undefined) return cached;

    // Metric not found in cache — no evaluation-mode contributions have this score
    return undefined;
  }

  /**
   * Update the best-score cache with scores from a single contribution.
   * Called during cache warm-up and when processing new contributions.
   */
  private updateCacheFromContribution(c: Contribution): void {
    if (!c.scores) return;
    for (const [name, score] of Object.entries(c.scores)) {
      const metricDef = this.config.metrics?.[name];
      if (!metricDef) continue;
      const existing = this.bestScoreCache?.get(name);
      const isMinimize = metricDef.direction === "minimize";
      if (
        existing === undefined ||
        (isMinimize ? score.value < existing.value : score.value > existing.value)
      ) {
        this.bestScoreCache?.set(name, { value: score.value, cid: c.cid, createdAt: c.createdAt });
      }
    }
  }
}
