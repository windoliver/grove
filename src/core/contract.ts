/**
 * GROVE.md contract types, Zod schemas, and parser.
 *
 * Mirrors spec/schemas/grove-contract.json — keep in sync.
 * See spec/GROVE-CONTRACT.md for the full specification.
 *
 * Wire format uses snake_case (YAML frontmatter). TypeScript uses camelCase.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { ContributionKind, ContributionMode, RelationType, ScoreDirection } from "./models.js";

// ---------------------------------------------------------------------------
// Zod Schemas (snake_case — matches YAML frontmatter wire format)
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

const ClaimPolicySchema = z
  .object({
    default_lease_seconds: z.number().int().min(30).max(86400).optional(),
    max_claims_per_agent: z.number().int().min(0).max(100).optional(),
    heartbeat_required: z.boolean().optional(),
  })
  .strict();

const MetricNamePattern = /^[a-z][a-z0-9_]*$/;

/** Top-level GROVE.md frontmatter schema (snake_case wire format). */
const GroveContractSchema = z
  .object({
    contract_version: z.literal(1),
    name: z.string().min(1).max(128),
    description: z.string().max(1024).optional(),
    mode: z.enum(["evaluation", "exploration"]).optional(),
    seed: z.string().min(1).max(256).optional(),
    metrics: z
      .record(z.string().regex(MetricNamePattern).min(1).max(64), MetricDefinitionSchema)
      .refine((m) => Object.keys(m).length <= 50, { message: "max 50 metrics" })
      .optional(),
    gates: z.array(GateSchema).max(20).optional(),
    stop_conditions: StopConditionsSchema.optional(),
    agent_constraints: AgentConstraintsSchema.optional(),
    claim_policy: ClaimPolicySchema.optional(),
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

/** Claim policy from the GROVE.md contract. */
export interface ClaimPolicy {
  readonly defaultLeaseSeconds?: number | undefined;
  readonly maxClaimsPerAgent?: number | undefined;
  readonly heartbeatRequired?: boolean | undefined;
}

/** Parsed GROVE.md contract. */
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
  readonly claimPolicy?: ClaimPolicy | undefined;
}

// ---------------------------------------------------------------------------
// Wire format conversion (snake_case ↔ camelCase)
// ---------------------------------------------------------------------------

/** Convert a validated snake_case wire object to a camelCase GroveContract. */
function wireToContract(wire: z.infer<typeof GroveContractSchema>): GroveContract {
  const contract: GroveContract = {
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
    ...(wire.claim_policy !== undefined && {
      claimPolicy: wireToClaimPolicy(wire.claim_policy),
    }),
  };
  return contract;
}

function wireToStopConditions(
  wire: NonNullable<z.infer<typeof GroveContractSchema>["stop_conditions"]>,
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
  wire: NonNullable<z.infer<typeof GroveContractSchema>["agent_constraints"]>,
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
  wire: NonNullable<z.infer<typeof GroveContractSchema>["claim_policy"]>,
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

// ---------------------------------------------------------------------------
// Parser
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
 * Parse and validate a GROVE.md file's content.
 *
 * Extracts YAML frontmatter, validates against the Zod schema,
 * and returns a typed GroveContract.
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

  const result = GroveContractSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid GROVE.md contract: ${issues}`);
  }

  const contract = wireToContract(result.data);
  validateMetricReferences(contract);
  return contract;
}

/**
 * Parse a plain object (already extracted from YAML) as a GroveContract.
 * Useful when the frontmatter has already been parsed elsewhere.
 *
 * @throws {Error} if validation fails.
 */
export function parseGroveContractObject(obj: unknown): GroveContract {
  const result = GroveContractSchema.safeParse(obj);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid grove contract: ${issues}`);
  }

  const contract = wireToContract(result.data);
  validateMetricReferences(contract);
  return contract;
}
