/**
 * GROVE.md contract types, Zod schemas, and parser.
 *
 * Supports contract_version 1 (legacy claim_policy), contract_version 2
 * (concurrency, execution, rate_limits, retry sections), and contract_version 3
 * (renames topology → agent_topology). V1 contracts are auto-migrated to V2
 * types at parse time. V3 maps agent_topology to the same topology field in
 * GroveContract.
 *
 * Mirrors spec/schemas/grove-contract.json — keep in sync.
 * See spec/GROVE-CONTRACT.md for the full specification.
 *
 * Wire format uses snake_case (YAML frontmatter). TypeScript uses camelCase.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { ContributionKind, ContributionMode, RelationType, ScoreDirection } from "./models.js";
import { type AgentTopology, AgentTopologySchema, wireToTopology } from "./topology.js";

export type { AgentRole, AgentTopology, EdgeType, RoleEdge, SpawningConfig } from "./topology.js";

// ---------------------------------------------------------------------------
// Shared Zod Schemas (snake_case — matches YAML frontmatter wire format)
// ---------------------------------------------------------------------------

const MetricDefinitionSchema = z
  .object({
    direction: z.enum(["minimize", "maximize"]),
    unit: z.string().max(64).optional(),
    description: z.string().max(256).optional(),
    gate: z.number().optional(),
  })
  .strict();

const GateSchema = z
  .object({
    type: z.enum(["metric_improves", "has_artifact", "has_relation", "min_reviews", "min_score"]),
    metric: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(64)
      .optional(),
    name: z.string().min(1).max(256).optional(),
    relation_type: z
      .enum(["derives_from", "responds_to", "reviews", "reproduces", "adopts"])
      .optional(),
    count: z.number().int().min(1).max(100).optional(),
    threshold: z.number().optional(),
  })
  .strict()
  .superRefine((gate, ctx) => {
    if (gate.type === "metric_improves" && gate.metric === undefined) {
      ctx.addIssue({ code: "custom", message: "metric_improves gate requires 'metric' field" });
    }
    if (gate.type === "has_artifact" && gate.name === undefined) {
      ctx.addIssue({ code: "custom", message: "has_artifact gate requires 'name' field" });
    }
    if (gate.type === "has_relation" && gate.relation_type === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "has_relation gate requires 'relation_type' field",
      });
    }
    if (gate.type === "min_reviews" && gate.count === undefined) {
      ctx.addIssue({ code: "custom", message: "min_reviews gate requires 'count' field" });
    }
    if (gate.type === "min_score") {
      if (gate.metric === undefined) {
        ctx.addIssue({ code: "custom", message: "min_score gate requires 'metric' field" });
      }
      if (gate.threshold === undefined) {
        ctx.addIssue({ code: "custom", message: "min_score gate requires 'threshold' field" });
      }
    }
  });

const TargetMetricSchema = z
  .object({
    metric: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(64),
    value: z.number(),
  })
  .strict();

const BudgetSchema = z
  .object({
    max_contributions: z.number().int().min(1).optional(),
    max_wall_clock_seconds: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((b) => b.max_contributions !== undefined || b.max_wall_clock_seconds !== undefined, {
    message: "budget must specify at least one of max_contributions or max_wall_clock_seconds",
  });

const QuorumReviewScoreSchema = z
  .object({
    min_reviews: z.number().int().min(1).max(100),
    min_score: z.number().min(0).max(1),
  })
  .strict();

const DeliberationLimitSchema = z
  .object({
    max_rounds: z.number().int().min(1).max(100).optional(),
    max_messages: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .refine((d) => d.max_rounds !== undefined || d.max_messages !== undefined, {
    message: "deliberation_limit must specify at least one of max_rounds or max_messages",
  });

const StopConditionsSchema = z
  .object({
    max_rounds_without_improvement: z.number().int().min(1).max(1000).optional(),
    target_metric: TargetMetricSchema.optional(),
    budget: BudgetSchema.optional(),
    quorum_review_score: QuorumReviewScoreSchema.optional(),
    deliberation_limit: DeliberationLimitSchema.optional(),
  })
  .strict();

const ArtifactRequirementsSchema = z.array(z.string().min(1).max(256)).min(1).max(20);

const RelationRequirementsSchema = z
  .array(z.enum(["derives_from", "responds_to", "reviews", "reproduces", "adopts"]))
  .min(1)
  .max(5)
  .refine((items) => new Set(items).size === items.length, {
    message: "duplicate relation types",
  });

const ContributionKindEnum = z.enum(["work", "review", "discussion", "adoption", "reproduction"]);

const AgentConstraintsSchema = z
  .object({
    allowed_kinds: z
      .array(ContributionKindEnum)
      .min(1)
      .max(5)
      .refine((items) => new Set(items).size === items.length, { message: "duplicate kinds" })
      .optional(),
    required_artifacts: z
      .object({
        work: ArtifactRequirementsSchema.optional(),
        review: ArtifactRequirementsSchema.optional(),
        discussion: ArtifactRequirementsSchema.optional(),
        adoption: ArtifactRequirementsSchema.optional(),
        reproduction: ArtifactRequirementsSchema.optional(),
      })
      .strict()
      .optional(),
    required_relations: z
      .object({
        work: RelationRequirementsSchema.optional(),
        review: RelationRequirementsSchema.optional(),
        discussion: RelationRequirementsSchema.optional(),
        adoption: RelationRequirementsSchema.optional(),
        reproduction: RelationRequirementsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MetricNamePattern = /^[a-z][a-z0-9_]*$/;

const MetricsSchema = z
  .record(z.string().regex(MetricNamePattern).min(1).max(64), MetricDefinitionSchema)
  .refine((m) => Object.keys(m).length <= 50, { message: "max 50 metrics" });

// ---------------------------------------------------------------------------
// V1 Schema (legacy — claim_policy)
// ---------------------------------------------------------------------------

const ClaimPolicySchema = z
  .object({
    default_lease_seconds: z.number().int().min(30).max(86400).optional(),
    max_claims_per_agent: z.number().int().min(0).max(100).optional(),
    heartbeat_required: z.boolean().optional(),
  })
  .strict();

const GroveContractV1Schema = z
  .object({
    contract_version: z.literal(1),
    name: z.string().min(1).max(128),
    description: z.string().max(1024).optional(),
    mode: z.enum(["evaluation", "exploration"]).optional(),
    seed: z.string().min(1).max(256).optional(),
    metrics: MetricsSchema.optional(),
    gates: z.array(GateSchema).max(20).optional(),
    stop_conditions: StopConditionsSchema.optional(),
    agent_constraints: AgentConstraintsSchema.optional(),
    claim_policy: ClaimPolicySchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// V2 Schemas (concurrency, execution, rate_limits, retry)
// ---------------------------------------------------------------------------

const ConcurrencySchema = z
  .object({
    max_active_claims: z.number().int().min(1).max(1000).optional(),
    max_claims_per_agent: z.number().int().min(0).max(100).optional(),
    max_claims_per_target: z.literal(1).optional(),
  })
  .strict();

const ExecutionSchema = z
  .object({
    default_lease_seconds: z.number().int().min(30).max(86400).optional(),
    max_lease_seconds: z.number().int().min(60).max(604800).optional(),
    heartbeat_interval_seconds: z.number().int().min(10).max(86400).optional(),
    stall_timeout_seconds: z.number().int().min(60).max(604800).optional(),
  })
  .strict();

const RateLimitsSchema = z
  .object({
    max_contributions_per_agent_per_hour: z.number().int().min(1).max(10000).optional(),
    max_contributions_per_grove_per_hour: z.number().int().min(1).max(100000).optional(),
    max_artifact_size_bytes: z.number().int().min(1).optional(),
    max_artifacts_per_contribution: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

const RetrySchema = z
  .object({
    base_delay_ms: z.number().int().min(100).max(600000).optional(),
    max_backoff_ms: z.number().int().min(1000).max(3600000).optional(),
    max_attempts: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const GossipSchema = z
  .object({
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    fan_out: z.number().int().min(1).max(20).optional(),
    partial_view_size: z.number().int().min(2).max(100).optional(),
    shuffle_length: z.number().int().min(1).max(50).optional(),
    suspicion_timeout_seconds: z.number().int().min(10).max(3600).optional(),
    failure_timeout_seconds: z.number().int().min(30).max(7200).optional(),
    digest_limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const OutcomePolicySchema = z
  .object({
    auto_accept: z
      .object({
        metric_improves: z.string().optional(),
        all_gates_pass: z.boolean().optional(),
      })
      .strict()
      .optional(),
    auto_reject: z
      .object({
        metric_regresses: z.string().optional(),
        missing_required_artifacts: z.boolean().optional(),
      })
      .strict()
      .optional(),
    require_manual_review: z.boolean().optional(),
  })
  .strict();

const GroveContractV2Schema = z
  .object({
    contract_version: z.literal(2),
    name: z.string().min(1).max(128),
    description: z.string().max(1024).optional(),
    mode: z.enum(["evaluation", "exploration"]).optional(),
    seed: z.string().min(1).max(256).optional(),
    metrics: MetricsSchema.optional(),
    gates: z.array(GateSchema).max(20).optional(),
    stop_conditions: StopConditionsSchema.optional(),
    agent_constraints: AgentConstraintsSchema.optional(),
    concurrency: ConcurrencySchema.optional(),
    execution: ExecutionSchema.optional(),
    rate_limits: RateLimitsSchema.optional(),
    retry: RetrySchema.optional(),
    gossip: GossipSchema.optional(),
    outcome_policy: OutcomePolicySchema.optional(),
    topology: AgentTopologySchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// V3 Schema (renames topology → agent_topology)
// ---------------------------------------------------------------------------

const GroveContractV3Schema = z
  .object({
    contract_version: z.literal(3),
    name: z.string().min(1).max(128),
    description: z.string().max(1024).optional(),
    mode: z.enum(["evaluation", "exploration"]).optional(),
    seed: z.string().min(1).max(256).optional(),
    metrics: MetricsSchema.optional(),
    gates: z.array(GateSchema).max(20).optional(),
    stop_conditions: StopConditionsSchema.optional(),
    agent_constraints: AgentConstraintsSchema.optional(),
    concurrency: ConcurrencySchema.optional(),
    execution: ExecutionSchema.optional(),
    rate_limits: RateLimitsSchema.optional(),
    retry: RetrySchema.optional(),
    gossip: GossipSchema.optional(),
    outcome_policy: OutcomePolicySchema.optional(),
    agent_topology: AgentTopologySchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// TypeScript Types (camelCase)
// ---------------------------------------------------------------------------

/** A metric definition from the GROVE.md contract. */
export interface MetricDefinition {
  readonly direction: ScoreDirection;
  readonly unit?: string | undefined;
  readonly description?: string | undefined;
  readonly gate?: number | undefined;
}

/** Gate types for contribution acceptance. */
export type GateType =
  | "metric_improves"
  | "has_artifact"
  | "has_relation"
  | "min_reviews"
  | "min_score";

/** A contribution gate rule. */
export interface Gate {
  readonly type: GateType;
  readonly metric?: string | undefined;
  readonly name?: string | undefined;
  readonly relationType?: RelationType | undefined;
  readonly count?: number | undefined;
  readonly threshold?: number | undefined;
}

/** Target metric stop condition. */
export interface TargetMetric {
  readonly metric: string;
  readonly value: number;
}

/** Budget stop condition. */
export interface Budget {
  readonly maxContributions?: number | undefined;
  readonly maxWallClockSeconds?: number | undefined;
}

/** Quorum review score stop condition. */
export interface QuorumReviewScore {
  readonly minReviews: number;
  readonly minScore: number;
}

/** Deliberation limit stop condition. */
export interface DeliberationLimit {
  readonly maxRounds?: number | undefined;
  readonly maxMessages?: number | undefined;
}

/** Stop conditions from the GROVE.md contract. */
export interface StopConditions {
  readonly maxRoundsWithoutImprovement?: number | undefined;
  readonly targetMetric?: TargetMetric | undefined;
  readonly budget?: Budget | undefined;
  readonly quorumReviewScore?: QuorumReviewScore | undefined;
  readonly deliberationLimit?: DeliberationLimit | undefined;
}

/** Agent constraints from the GROVE.md contract. */
export interface AgentConstraints {
  readonly allowedKinds?: readonly ContributionKind[] | undefined;
  readonly requiredArtifacts?:
    | Readonly<Partial<Record<ContributionKind, readonly string[]>>>
    | undefined;
  readonly requiredRelations?:
    | Readonly<Partial<Record<ContributionKind, readonly RelationType[]>>>
    | undefined;
}

/**
 * Claim policy from the GROVE.md contract (V1 only).
 * @deprecated Use concurrency + execution sections instead (contract_version: 2).
 */
export interface ClaimPolicy {
  readonly defaultLeaseSeconds?: number | undefined;
  readonly maxClaimsPerAgent?: number | undefined;
  readonly heartbeatRequired?: boolean | undefined;
}

/** Concurrency limits for bounded agent coordination. */
export interface ConcurrencyConfig {
  readonly maxActiveClaims?: number | undefined;
  readonly maxClaimsPerAgent?: number | undefined;
  readonly maxClaimsPerTarget?: number | undefined;
}

/** Execution timeout and lease configuration. */
export interface ExecutionConfig {
  readonly defaultLeaseSeconds?: number | undefined;
  readonly maxLeaseSeconds?: number | undefined;
  readonly heartbeatIntervalSeconds?: number | undefined;
  readonly stallTimeoutSeconds?: number | undefined;
}

/** Rate limits for contribution and artifact submission. */
export interface RateLimitsConfig {
  readonly maxContributionsPerAgentPerHour?: number | undefined;
  readonly maxContributionsPerGrovePerHour?: number | undefined;
  readonly maxArtifactSizeBytes?: number | undefined;
  readonly maxArtifactsPerContribution?: number | undefined;
}

/** Retry and backoff configuration. */
export interface RetryConfig {
  readonly baseDelayMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

/** Auto-accept policy configuration. */
export interface OutcomePolicyAutoAccept {
  readonly metricImproves?: string | undefined;
  readonly allGatesPass?: boolean | undefined;
}

/** Auto-reject policy configuration. */
export interface OutcomePolicyAutoReject {
  readonly metricRegresses?: string | undefined;
  readonly missingRequiredArtifacts?: boolean | undefined;
}

/** Outcome policy from the GROVE.md contract. */
export interface OutcomePolicy {
  readonly autoAccept?: OutcomePolicyAutoAccept | undefined;
  readonly autoReject?: OutcomePolicyAutoReject | undefined;
  readonly requireManualReview?: boolean | undefined;
}

/** Gossip protocol configuration from GROVE.md contract. */
export interface GossipContractConfig {
  readonly intervalSeconds?: number | undefined;
  readonly fanOut?: number | undefined;
  readonly partialViewSize?: number | undefined;
  readonly shuffleLength?: number | undefined;
  readonly suspicionTimeoutSeconds?: number | undefined;
  readonly failureTimeoutSeconds?: number | undefined;
  readonly digestLimit?: number | undefined;
}

/** Parsed GROVE.md contract (always in V2 normalized form). */
export interface GroveContract {
  readonly contractVersion: number;
  readonly name: string;
  readonly description?: string | undefined;
  readonly mode?: ContributionMode | undefined;
  readonly seed?: string | undefined;
  readonly metrics?: Readonly<Record<string, MetricDefinition>> | undefined;
  readonly gates?: readonly Gate[] | undefined;
  readonly stopConditions?: StopConditions | undefined;
  readonly agentConstraints?: AgentConstraints | undefined;
  /** @deprecated V1 only. Use concurrency + execution instead. Populated when parsing V1 contracts. */
  readonly claimPolicy?: ClaimPolicy | undefined;
  readonly concurrency?: ConcurrencyConfig | undefined;
  readonly execution?: ExecutionConfig | undefined;
  readonly rateLimits?: RateLimitsConfig | undefined;
  readonly retry?: RetryConfig | undefined;
  readonly gossip?: GossipContractConfig | undefined;
  readonly outcomePolicy?: OutcomePolicy | undefined;
  readonly topology?: AgentTopology | undefined;
}

// ---------------------------------------------------------------------------
// Wire format conversion (snake_case ↔ camelCase)
// ---------------------------------------------------------------------------

/** Convert a validated V1 snake_case wire object to a camelCase GroveContract. */
function wireV1ToContract(wire: z.infer<typeof GroveContractV1Schema>): GroveContract {
  const base = wireToContractBase(wire);
  const cp = wire.claim_policy;

  // Auto-migrate claim_policy fields into v2 sections
  const hasConcurrency = cp?.max_claims_per_agent !== undefined;
  const hasExecution =
    cp?.default_lease_seconds !== undefined || cp?.heartbeat_required !== undefined;

  return {
    ...base,
    // Preserve claimPolicy for backward compat / diagnostics
    ...(cp !== undefined && {
      claimPolicy: wireToClaimPolicy(cp),
    }),
    // Migrate to v2 sections
    ...(hasConcurrency && {
      concurrency: {
        ...(cp?.max_claims_per_agent !== undefined && {
          maxClaimsPerAgent: cp.max_claims_per_agent,
        }),
      },
    }),
    ...(hasExecution && {
      execution: {
        ...(cp?.default_lease_seconds !== undefined && {
          defaultLeaseSeconds: cp.default_lease_seconds,
        }),
        // heartbeat_required: true → default interval of 60s
        ...(cp?.heartbeat_required === true && { heartbeatIntervalSeconds: 60 }),
      },
    }),
  };
}

/** Convert a validated V2 snake_case wire object to a camelCase GroveContract. */
function wireV2ToContract(wire: z.infer<typeof GroveContractV2Schema>): GroveContract {
  const base = wireToContractBase(wire);

  return {
    ...base,
    ...(wire.concurrency !== undefined && {
      concurrency: wireToConcurrency(wire.concurrency),
    }),
    ...(wire.execution !== undefined && {
      execution: wireToExecution(wire.execution),
    }),
    ...(wire.rate_limits !== undefined && {
      rateLimits: wireToRateLimits(wire.rate_limits),
    }),
    ...(wire.retry !== undefined && {
      retry: wireToRetry(wire.retry),
    }),
    ...(wire.gossip !== undefined && {
      gossip: wireToGossip(wire.gossip),
    }),
    ...(wire.outcome_policy !== undefined && {
      outcomePolicy: wireToOutcomePolicy(wire.outcome_policy),
    }),
    ...(wire.topology !== undefined && {
      topology: wireToTopology(wire.topology),
    }),
  };
}

/** Convert a validated V3 snake_case wire object to a camelCase GroveContract. */
function wireV3ToContract(wire: z.infer<typeof GroveContractV3Schema>): GroveContract {
  const base = wireToContractBase(wire);

  return {
    ...base,
    ...(wire.concurrency !== undefined && {
      concurrency: wireToConcurrency(wire.concurrency),
    }),
    ...(wire.execution !== undefined && {
      execution: wireToExecution(wire.execution),
    }),
    ...(wire.rate_limits !== undefined && {
      rateLimits: wireToRateLimits(wire.rate_limits),
    }),
    ...(wire.retry !== undefined && {
      retry: wireToRetry(wire.retry),
    }),
    ...(wire.gossip !== undefined && {
      gossip: wireToGossip(wire.gossip),
    }),
    ...(wire.outcome_policy !== undefined && {
      outcomePolicy: wireToOutcomePolicy(wire.outcome_policy),
    }),
    ...(wire.agent_topology !== undefined && {
      topology: wireToTopology(wire.agent_topology),
    }),
  };
}

/** Shared base fields for V1, V2, and V3. */
function wireToContractBase(
  wire:
    | z.infer<typeof GroveContractV1Schema>
    | z.infer<typeof GroveContractV2Schema>
    | z.infer<typeof GroveContractV3Schema>,
): GroveContract {
  return {
    contractVersion: wire.contract_version,
    name: wire.name,
    ...(wire.description !== undefined && { description: wire.description }),
    ...(wire.mode !== undefined && { mode: wire.mode as ContributionMode }),
    ...(wire.seed !== undefined && { seed: wire.seed }),
    ...(wire.metrics !== undefined && {
      metrics: wire.metrics as Readonly<Record<string, MetricDefinition>>,
    }),
    ...(wire.gates !== undefined && {
      gates: wire.gates.map(
        (g): Gate => ({
          type: g.type,
          ...(g.metric !== undefined && { metric: g.metric }),
          ...(g.name !== undefined && { name: g.name }),
          ...(g.relation_type !== undefined && { relationType: g.relation_type as RelationType }),
          ...(g.count !== undefined && { count: g.count }),
          ...(g.threshold !== undefined && { threshold: g.threshold }),
        }),
      ),
    }),
    ...(wire.stop_conditions !== undefined && {
      stopConditions: wireToStopConditions(wire.stop_conditions),
    }),
    ...(wire.agent_constraints !== undefined && {
      agentConstraints: wireToAgentConstraints(wire.agent_constraints),
    }),
  };
}

function wireToStopConditions(
  wire: NonNullable<z.infer<typeof GroveContractV1Schema>["stop_conditions"]>,
): StopConditions {
  return {
    ...(wire.max_rounds_without_improvement !== undefined && {
      maxRoundsWithoutImprovement: wire.max_rounds_without_improvement,
    }),
    ...(wire.target_metric !== undefined && {
      targetMetric: { metric: wire.target_metric.metric, value: wire.target_metric.value },
    }),
    ...(wire.budget !== undefined && {
      budget: {
        ...(wire.budget.max_contributions !== undefined && {
          maxContributions: wire.budget.max_contributions,
        }),
        ...(wire.budget.max_wall_clock_seconds !== undefined && {
          maxWallClockSeconds: wire.budget.max_wall_clock_seconds,
        }),
      },
    }),
    ...(wire.quorum_review_score !== undefined && {
      quorumReviewScore: {
        minReviews: wire.quorum_review_score.min_reviews,
        minScore: wire.quorum_review_score.min_score,
      },
    }),
    ...(wire.deliberation_limit !== undefined && {
      deliberationLimit: {
        ...(wire.deliberation_limit.max_rounds !== undefined && {
          maxRounds: wire.deliberation_limit.max_rounds,
        }),
        ...(wire.deliberation_limit.max_messages !== undefined && {
          maxMessages: wire.deliberation_limit.max_messages,
        }),
      },
    }),
  };
}

function wireToAgentConstraints(
  wire: NonNullable<z.infer<typeof GroveContractV1Schema>["agent_constraints"]>,
): AgentConstraints {
  return {
    ...(wire.allowed_kinds !== undefined && {
      allowedKinds: wire.allowed_kinds as unknown as ContributionKind[],
    }),
    ...(wire.required_artifacts !== undefined && {
      requiredArtifacts: wire.required_artifacts as Partial<Record<ContributionKind, string[]>>,
    }),
    ...(wire.required_relations !== undefined && {
      requiredRelations: wire.required_relations as Partial<
        Record<ContributionKind, RelationType[]>
      >,
    }),
  };
}

function wireToClaimPolicy(
  wire: NonNullable<z.infer<typeof GroveContractV1Schema>["claim_policy"]>,
): ClaimPolicy {
  return {
    ...(wire.default_lease_seconds !== undefined && {
      defaultLeaseSeconds: wire.default_lease_seconds,
    }),
    ...(wire.max_claims_per_agent !== undefined && {
      maxClaimsPerAgent: wire.max_claims_per_agent,
    }),
    ...(wire.heartbeat_required !== undefined && {
      heartbeatRequired: wire.heartbeat_required,
    }),
  };
}

function wireToConcurrency(
  wire: NonNullable<z.infer<typeof GroveContractV2Schema>["concurrency"]>,
): ConcurrencyConfig {
  return {
    ...(wire.max_active_claims !== undefined && { maxActiveClaims: wire.max_active_claims }),
    ...(wire.max_claims_per_agent !== undefined && {
      maxClaimsPerAgent: wire.max_claims_per_agent,
    }),
    ...(wire.max_claims_per_target !== undefined && {
      maxClaimsPerTarget: wire.max_claims_per_target,
    }),
  };
}

function wireToExecution(
  wire: NonNullable<z.infer<typeof GroveContractV2Schema>["execution"]>,
): ExecutionConfig {
  return {
    ...(wire.default_lease_seconds !== undefined && {
      defaultLeaseSeconds: wire.default_lease_seconds,
    }),
    ...(wire.max_lease_seconds !== undefined && { maxLeaseSeconds: wire.max_lease_seconds }),
    ...(wire.heartbeat_interval_seconds !== undefined && {
      heartbeatIntervalSeconds: wire.heartbeat_interval_seconds,
    }),
    ...(wire.stall_timeout_seconds !== undefined && {
      stallTimeoutSeconds: wire.stall_timeout_seconds,
    }),
  };
}

function wireToRateLimits(
  wire: NonNullable<z.infer<typeof GroveContractV2Schema>["rate_limits"]>,
): RateLimitsConfig {
  return {
    ...(wire.max_contributions_per_agent_per_hour !== undefined && {
      maxContributionsPerAgentPerHour: wire.max_contributions_per_agent_per_hour,
    }),
    ...(wire.max_contributions_per_grove_per_hour !== undefined && {
      maxContributionsPerGrovePerHour: wire.max_contributions_per_grove_per_hour,
    }),
    ...(wire.max_artifact_size_bytes !== undefined && {
      maxArtifactSizeBytes: wire.max_artifact_size_bytes,
    }),
    ...(wire.max_artifacts_per_contribution !== undefined && {
      maxArtifactsPerContribution: wire.max_artifacts_per_contribution,
    }),
  };
}

function wireToRetry(
  wire: NonNullable<z.infer<typeof GroveContractV2Schema>["retry"]>,
): RetryConfig {
  return {
    ...(wire.base_delay_ms !== undefined && { baseDelayMs: wire.base_delay_ms }),
    ...(wire.max_backoff_ms !== undefined && { maxBackoffMs: wire.max_backoff_ms }),
    ...(wire.max_attempts !== undefined && { maxAttempts: wire.max_attempts }),
  };
}

function wireToGossip(
  wire: NonNullable<z.infer<typeof GroveContractV2Schema>["gossip"]>,
): GossipContractConfig {
  return {
    ...(wire.interval_seconds !== undefined && { intervalSeconds: wire.interval_seconds }),
    ...(wire.fan_out !== undefined && { fanOut: wire.fan_out }),
    ...(wire.partial_view_size !== undefined && { partialViewSize: wire.partial_view_size }),
    ...(wire.shuffle_length !== undefined && { shuffleLength: wire.shuffle_length }),
    ...(wire.suspicion_timeout_seconds !== undefined && {
      suspicionTimeoutSeconds: wire.suspicion_timeout_seconds,
    }),
    ...(wire.failure_timeout_seconds !== undefined && {
      failureTimeoutSeconds: wire.failure_timeout_seconds,
    }),
    ...(wire.digest_limit !== undefined && { digestLimit: wire.digest_limit }),
  };
}

function wireToOutcomePolicy(
  wire: NonNullable<z.infer<typeof GroveContractV2Schema>["outcome_policy"]>,
): OutcomePolicy {
  return {
    ...(wire.auto_accept !== undefined && {
      autoAccept: {
        ...(wire.auto_accept.metric_improves !== undefined && {
          metricImproves: wire.auto_accept.metric_improves,
        }),
        ...(wire.auto_accept.all_gates_pass !== undefined && {
          allGatesPass: wire.auto_accept.all_gates_pass,
        }),
      },
    }),
    ...(wire.auto_reject !== undefined && {
      autoReject: {
        ...(wire.auto_reject.metric_regresses !== undefined && {
          metricRegresses: wire.auto_reject.metric_regresses,
        }),
        ...(wire.auto_reject.missing_required_artifacts !== undefined && {
          missingRequiredArtifacts: wire.auto_reject.missing_required_artifacts,
        }),
      },
    }),
    ...(wire.require_manual_review !== undefined && {
      requireManualReview: wire.require_manual_review,
    }),
  };
}

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

/**
 * Validate metric cross-references in gates and stop conditions.
 * Ensures that any metric referenced actually exists in the metrics map.
 *
 * @throws {Error} if a referenced metric is not defined.
 */
function validateMetricReferences(contract: GroveContract): void {
  const metricNames = new Set(Object.keys(contract.metrics ?? {}));
  const errors: string[] = [];

  if (contract.gates !== undefined) {
    for (const gate of contract.gates) {
      if (
        (gate.type === "metric_improves" || gate.type === "min_score") &&
        gate.metric !== undefined &&
        !metricNames.has(gate.metric)
      ) {
        errors.push(`gate references undefined metric '${gate.metric}'`);
      }
    }
  }

  if (contract.stopConditions?.targetMetric !== undefined) {
    const { metric } = contract.stopConditions.targetMetric;
    if (!metricNames.has(metric)) {
      errors.push(`stop_conditions.target_metric references undefined metric '${metric}'`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid contract: ${errors.join("; ")}`);
  }
}

/**
 * Validate cross-field constraints within execution config.
 * E.g., default_lease_seconds ≤ max_lease_seconds.
 */
function validateExecutionConstraints(contract: GroveContract): void {
  const exec = contract.execution;
  if (exec === undefined) return;

  const errors: string[] = [];

  if (
    exec.defaultLeaseSeconds !== undefined &&
    exec.maxLeaseSeconds !== undefined &&
    exec.defaultLeaseSeconds > exec.maxLeaseSeconds
  ) {
    errors.push(
      `execution.default_lease_seconds (${exec.defaultLeaseSeconds}) exceeds max_lease_seconds (${exec.maxLeaseSeconds})`,
    );
  }

  if (
    exec.heartbeatIntervalSeconds !== undefined &&
    exec.stallTimeoutSeconds !== undefined &&
    exec.heartbeatIntervalSeconds >= exec.stallTimeoutSeconds
  ) {
    errors.push(
      `execution.heartbeat_interval_seconds (${exec.heartbeatIntervalSeconds}) must be less than stall_timeout_seconds (${exec.stallTimeoutSeconds})`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Invalid contract: ${errors.join("; ")}`);
  }
}

/**
 * Validate cross-field constraints within rate limits.
 * E.g., per-agent limit ≤ per-grove limit.
 */
function validateRateLimitConstraints(contract: GroveContract): void {
  const rl = contract.rateLimits;
  if (rl === undefined) return;

  if (
    rl.maxContributionsPerAgentPerHour !== undefined &&
    rl.maxContributionsPerGrovePerHour !== undefined &&
    rl.maxContributionsPerAgentPerHour > rl.maxContributionsPerGrovePerHour
  ) {
    throw new Error(
      `Invalid contract: rate_limits.max_contributions_per_agent_per_hour (${rl.maxContributionsPerAgentPerHour}) exceeds max_contributions_per_grove_per_hour (${rl.maxContributionsPerGrovePerHour})`,
    );
  }
}

/**
 * Validate cross-field constraints within gossip config.
 * E.g., suspicion_timeout < failure_timeout.
 */
function validateGossipConstraints(contract: GroveContract): void {
  const g = contract.gossip;
  if (g === undefined) return;

  if (
    g.suspicionTimeoutSeconds !== undefined &&
    g.failureTimeoutSeconds !== undefined &&
    g.suspicionTimeoutSeconds >= g.failureTimeoutSeconds
  ) {
    throw new Error(
      `Invalid contract: gossip.suspicion_timeout_seconds (${g.suspicionTimeoutSeconds}) must be less than failure_timeout_seconds (${g.failureTimeoutSeconds})`,
    );
  }

  if (
    g.shuffleLength !== undefined &&
    g.partialViewSize !== undefined &&
    g.shuffleLength > g.partialViewSize
  ) {
    throw new Error(
      `Invalid contract: gossip.shuffle_length (${g.shuffleLength}) exceeds partial_view_size (${g.partialViewSize})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Extract YAML frontmatter from a GROVE.md file.
 * Returns the YAML string between the first pair of `---` delimiters,
 * or null if no frontmatter is found.
 */
function extractFrontmatter(content: string): string | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) return null;

  return trimmed.slice(3, endIndex).trim();
}

/**
 * Parse and validate a raw YAML object as a GroveContract.
 * Dispatches to V1 or V2 schema based on contract_version.
 */
function parseRawObject(raw: unknown): GroveContract {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error("Contract data is not a valid object");
  }

  const obj = raw as Record<string, unknown>;
  const version = obj.contract_version;

  if (version === 1) {
    const result = GroveContractV1Schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid GROVE.md contract (v1): ${issues}`);
    }
    const contract = wireV1ToContract(result.data);
    validateMetricReferences(contract);
    validateExecutionConstraints(contract);
    return contract;
  }

  if (version === 2) {
    const result = GroveContractV2Schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid GROVE.md contract (v2): ${issues}`);
    }
    const contract = wireV2ToContract(result.data);
    validateMetricReferences(contract);
    validateExecutionConstraints(contract);
    validateRateLimitConstraints(contract);
    validateGossipConstraints(contract);
    return contract;
  }

  if (version === 3) {
    const result = GroveContractV3Schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid GROVE.md contract (v3): ${issues}`);
    }
    const contract = wireV3ToContract(result.data);
    validateMetricReferences(contract);
    validateExecutionConstraints(contract);
    validateRateLimitConstraints(contract);
    validateGossipConstraints(contract);
    return contract;
  }

  if (version === undefined) {
    throw new Error("GROVE.md contract missing required field 'contract_version'");
  }

  throw new Error(`Unsupported contract_version: ${String(version)} (supported: 1, 2, 3)`);
}

/**
 * Parse and validate a GROVE.md file's content.
 *
 * Extracts YAML frontmatter, validates against the appropriate schema
 * (V1 or V2), and returns a typed GroveContract in V2 normalized form.
 *
 * V1 contracts with claim_policy are auto-migrated to V2 sections
 * (concurrency, execution).
 *
 * @throws {Error} if frontmatter is missing, YAML is invalid, or
 *   validation fails.
 */
export function parseGroveContract(content: string): GroveContract {
  const yamlStr = extractFrontmatter(content);
  if (yamlStr === null) {
    throw new Error("GROVE.md has no YAML frontmatter (expected --- delimiters)");
  }

  const raw: unknown = parseYaml(yamlStr);
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error("GROVE.md frontmatter is not a valid YAML object");
  }

  return parseRawObject(raw);
}

/**
 * Parse a plain object (already extracted from YAML) as a GroveContract.
 * Useful when the frontmatter has already been parsed elsewhere.
 *
 * @throws {Error} if validation fails.
 */
export function parseGroveContractObject(obj: unknown): GroveContract {
  return parseRawObject(obj);
}
