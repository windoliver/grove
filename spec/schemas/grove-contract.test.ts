import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import contributionSchema from "./contribution.json";
import groveContractSchema from "./grove-contract.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a configured Ajv validator with the grove-contract schema. */
function createValidator() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  // Register contribution schema for cross-file $ref resolution
  ajv.addSchema(contributionSchema);
  return ajv.compile(groveContractSchema);
}

/** Minimal valid grove contract. */
function validContract(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    contract_version: 1,
    name: "test-grove",
    ...overrides,
  };
}

/** Extract YAML frontmatter from a GROVE.md file. */
function extractFrontmatter(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`No YAML frontmatter found in ${filePath}`);
  return parseYaml(match[1]) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Schema validation — valid contracts
// ---------------------------------------------------------------------------

describe("grove-contract schema — valid contracts", () => {
  const validate = createValidator();

  test("accepts minimal valid contract (name + contract_version only)", () => {
    expect(validate(validContract())).toBe(true);
  });

  test("accepts contract with all top-level fields", () => {
    const contract = validContract({
      description: "A test grove",
      mode: "evaluation",
      seed: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      metrics: {},
      gates: [],
      stop_conditions: {},
      agent_constraints: {},
      claim_policy: {},
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts exploration mode", () => {
    expect(validate(validContract({ mode: "exploration" }))).toBe(true);
  });

  test("accepts evaluation mode", () => {
    expect(validate(validContract({ mode: "evaluation" }))).toBe(true);
  });

  test("accepts seed as descriptive ref", () => {
    expect(validate(validContract({ seed: "initial-baseline-run" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Metrics section
// ---------------------------------------------------------------------------

describe("grove-contract schema — metrics", () => {
  const validate = createValidator();

  test("accepts metric with direction only", () => {
    const contract = validContract({
      metrics: { val_bpb: { direction: "minimize" } },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts metric with all fields", () => {
    const contract = validContract({
      metrics: {
        val_bpb: {
          direction: "minimize",
          unit: "bpb",
          description: "Validation bits-per-byte",
          gate: 1.5,
        },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts maximize direction", () => {
    const contract = validContract({
      metrics: { accuracy: { direction: "maximize" } },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts multiple metrics", () => {
    const contract = validContract({
      metrics: {
        val_bpb: { direction: "minimize" },
        throughput: { direction: "maximize" },
        memory: { direction: "minimize" },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts empty metrics object", () => {
    expect(validate(validContract({ metrics: {} }))).toBe(true);
  });

  test("accepts negative gate thresholds", () => {
    const contract = validContract({
      metrics: { log_loss: { direction: "minimize", gate: -0.5 } },
    });
    expect(validate(contract)).toBe(true);
  });

  test("rejects metric without direction", () => {
    const contract = validContract({
      metrics: { val_bpb: { unit: "bpb" } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects invalid direction value", () => {
    const contract = validContract({
      metrics: { val_bpb: { direction: "ascending" } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects metric name starting with number", () => {
    const contract = validContract({
      metrics: { "1metric": { direction: "minimize" } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects metric name with uppercase", () => {
    const contract = validContract({
      metrics: { ValBpb: { direction: "minimize" } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects metric name with hyphens", () => {
    const contract = validContract({
      metrics: { "val-bpb": { direction: "minimize" } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects metric with unknown properties", () => {
    const contract = validContract({
      metrics: { val_bpb: { direction: "minimize", unknown: true } },
    });
    expect(validate(contract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gates section
// ---------------------------------------------------------------------------

describe("grove-contract schema — gates", () => {
  const validate = createValidator();

  test("accepts metric_improves gate", () => {
    const contract = validContract({
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts has_artifact gate", () => {
    const contract = validContract({
      gates: [{ type: "has_artifact", name: "run.log" }],
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts has_relation gate", () => {
    const contract = validContract({
      gates: [{ type: "has_relation", relation_type: "derives_from" }],
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts min_reviews gate", () => {
    const contract = validContract({
      gates: [{ type: "min_reviews", count: 2, threshold: 0.7 }],
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts min_score gate", () => {
    const contract = validContract({
      gates: [{ type: "min_score", metric: "val_bpb", threshold: 0.9 }],
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts multiple gates", () => {
    const contract = validContract({
      gates: [
        { type: "metric_improves", metric: "val_bpb" },
        { type: "has_artifact", name: "run.log" },
        { type: "min_reviews", count: 1 },
      ],
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts empty gates array", () => {
    expect(validate(validContract({ gates: [] }))).toBe(true);
  });

  test("accepts all valid relation types in has_relation gate", () => {
    for (const rt of ["derives_from", "responds_to", "reviews", "reproduces", "adopts"]) {
      const contract = validContract({
        gates: [{ type: "has_relation", relation_type: rt }],
      });
      expect(validate(contract)).toBe(true);
    }
  });

  test("rejects gate without type", () => {
    const contract = validContract({
      gates: [{ metric: "val_bpb" }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects invalid gate type", () => {
    const contract = validContract({
      gates: [{ type: "custom_check" }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects invalid relation_type in gate", () => {
    const contract = validContract({
      gates: [{ type: "has_relation", relation_type: "follows" }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects gate with unknown properties", () => {
    const contract = validContract({
      gates: [{ type: "metric_improves", metric: "val_bpb", unknown: true }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("accepts min_score gate with raw metric threshold (non-normalized)", () => {
    const contract = validContract({
      gates: [{ type: "min_score", metric: "latency_ms", threshold: 10 }],
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts min_score gate with negative threshold", () => {
    const contract = validContract({
      gates: [{ type: "min_score", metric: "log_loss", threshold: -2.5 }],
    });
    expect(validate(contract)).toBe(true);
  });

  test("rejects count of 0", () => {
    const contract = validContract({
      gates: [{ type: "min_reviews", count: 0 }],
    });
    expect(validate(contract)).toBe(false);
  });

  // Gate type-specific required field enforcement (if/then)
  test("rejects metric_improves gate without metric", () => {
    const contract = validContract({
      gates: [{ type: "metric_improves" }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects has_artifact gate without name", () => {
    const contract = validContract({
      gates: [{ type: "has_artifact" }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects has_relation gate without relation_type", () => {
    const contract = validContract({
      gates: [{ type: "has_relation" }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects min_reviews gate without count", () => {
    const contract = validContract({
      gates: [{ type: "min_reviews", threshold: 0.5 }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects min_score gate without metric", () => {
    const contract = validContract({
      gates: [{ type: "min_score", threshold: 0.5 }],
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects min_score gate without threshold", () => {
    const contract = validContract({
      gates: [{ type: "min_score", metric: "val_bpb" }],
    });
    expect(validate(contract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stop conditions section
// ---------------------------------------------------------------------------

describe("grove-contract schema — stop conditions", () => {
  const validate = createValidator();

  test("accepts max_rounds_without_improvement", () => {
    const contract = validContract({
      stop_conditions: { max_rounds_without_improvement: 10 },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts target_metric", () => {
    const contract = validContract({
      stop_conditions: {
        target_metric: { metric: "val_bpb", value: 0.85 },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts budget with both fields", () => {
    const contract = validContract({
      stop_conditions: {
        budget: { max_contributions: 500, max_wall_clock_seconds: 86400 },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts budget with only max_contributions", () => {
    const contract = validContract({
      stop_conditions: { budget: { max_contributions: 100 } },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts quorum_review_score", () => {
    const contract = validContract({
      stop_conditions: {
        quorum_review_score: { min_reviews: 3, min_score: 0.8 },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts deliberation_limit", () => {
    const contract = validContract({
      stop_conditions: {
        deliberation_limit: { max_rounds: 5, max_messages: 50 },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts all stop conditions together", () => {
    const contract = validContract({
      stop_conditions: {
        max_rounds_without_improvement: 10,
        target_metric: { metric: "val_bpb", value: 0.85 },
        budget: { max_contributions: 500, max_wall_clock_seconds: 86400 },
        quorum_review_score: { min_reviews: 2, min_score: 0.8 },
        deliberation_limit: { max_rounds: 5, max_messages: 100 },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts empty stop_conditions object", () => {
    expect(validate(validContract({ stop_conditions: {} }))).toBe(true);
  });

  test("rejects max_rounds_without_improvement of 0", () => {
    const contract = validContract({
      stop_conditions: { max_rounds_without_improvement: 0 },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects negative max_rounds_without_improvement", () => {
    const contract = validContract({
      stop_conditions: { max_rounds_without_improvement: -1 },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects target_metric without metric name", () => {
    const contract = validContract({
      stop_conditions: { target_metric: { value: 0.85 } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects target_metric without value", () => {
    const contract = validContract({
      stop_conditions: { target_metric: { metric: "val_bpb" } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects quorum_review_score without min_reviews", () => {
    const contract = validContract({
      stop_conditions: { quorum_review_score: { min_score: 0.8 } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects quorum_review_score with min_score above 1", () => {
    const contract = validContract({
      stop_conditions: {
        quorum_review_score: { min_reviews: 2, min_score: 1.5 },
      },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects unknown stop condition fields", () => {
    const contract = validContract({
      stop_conditions: { custom_stop: true },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects budget with unknown fields", () => {
    const contract = validContract({
      stop_conditions: { budget: { max_tokens: 1000000 } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects empty budget object", () => {
    const contract = validContract({
      stop_conditions: { budget: {} },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects empty deliberation_limit object", () => {
    const contract = validContract({
      stop_conditions: { deliberation_limit: {} },
    });
    expect(validate(contract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agent constraints section
// ---------------------------------------------------------------------------

describe("grove-contract schema — agent constraints", () => {
  const validate = createValidator();

  test("accepts allowed_kinds with all contribution kinds", () => {
    const contract = validContract({
      agent_constraints: {
        allowed_kinds: ["work", "review", "discussion", "adoption", "reproduction"],
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts allowed_kinds with subset", () => {
    const contract = validContract({
      agent_constraints: { allowed_kinds: ["work", "review"] },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts required_artifacts per kind", () => {
    const contract = validContract({
      agent_constraints: {
        required_artifacts: {
          work: ["train.py", "run.log"],
          reproduction: ["run.log"],
        },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts required_relations per kind", () => {
    const contract = validContract({
      agent_constraints: {
        required_relations: {
          review: ["reviews"],
          reproduction: ["reproduces"],
        },
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts empty agent_constraints", () => {
    expect(validate(validContract({ agent_constraints: {} }))).toBe(true);
  });

  test("rejects invalid contribution kind in allowed_kinds", () => {
    const contract = validContract({
      agent_constraints: { allowed_kinds: ["work", "critique"] },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects empty allowed_kinds array", () => {
    const contract = validContract({
      agent_constraints: { allowed_kinds: [] },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects duplicate allowed_kinds", () => {
    const contract = validContract({
      agent_constraints: { allowed_kinds: ["work", "work"] },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects invalid relation type in required_relations", () => {
    const contract = validContract({
      agent_constraints: {
        required_relations: { review: ["follows"] },
      },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects unknown contribution kind key in required_artifacts", () => {
    const contract = validContract({
      agent_constraints: {
        required_artifacts: { critique: ["report.md"] },
      },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects unknown contribution kind key in required_relations", () => {
    const contract = validContract({
      agent_constraints: {
        required_relations: { critique: ["reviews"] },
      },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects unknown properties in agent_constraints", () => {
    const contract = validContract({
      agent_constraints: { max_agents: 5 },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects empty required_artifacts array", () => {
    const contract = validContract({
      agent_constraints: { required_artifacts: { work: [] } },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects empty required_relations array", () => {
    const contract = validContract({
      agent_constraints: { required_relations: { review: [] } },
    });
    expect(validate(contract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim policy section
// ---------------------------------------------------------------------------

describe("grove-contract schema — claim policy", () => {
  const validate = createValidator();

  test("accepts all claim policy fields", () => {
    const contract = validContract({
      claim_policy: {
        default_lease_seconds: 600,
        max_claims_per_agent: 3,
        heartbeat_required: true,
      },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts claim policy with only default_lease_seconds", () => {
    const contract = validContract({
      claim_policy: { default_lease_seconds: 300 },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts max_claims_per_agent of 0 (unlimited)", () => {
    const contract = validContract({
      claim_policy: { max_claims_per_agent: 0 },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts heartbeat_required false", () => {
    const contract = validContract({
      claim_policy: { heartbeat_required: false },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts empty claim policy", () => {
    expect(validate(validContract({ claim_policy: {} }))).toBe(true);
  });

  test("rejects lease below minimum (30 seconds)", () => {
    const contract = validContract({
      claim_policy: { default_lease_seconds: 10 },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects lease above maximum (24 hours)", () => {
    const contract = validContract({
      claim_policy: { default_lease_seconds: 100000 },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects negative max_claims_per_agent", () => {
    const contract = validContract({
      claim_policy: { max_claims_per_agent: -1 },
    });
    expect(validate(contract)).toBe(false);
  });

  test("rejects unknown claim policy properties", () => {
    const contract = validContract({
      claim_policy: { auto_renew: true },
    });
    expect(validate(contract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Top-level validation — missing required fields and strict mode
// ---------------------------------------------------------------------------

describe("grove-contract schema — required fields and strict mode", () => {
  const validate = createValidator();

  test("rejects missing contract_version", () => {
    expect(validate({ name: "test" })).toBe(false);
  });

  test("rejects missing name", () => {
    expect(validate({ contract_version: 1 })).toBe(false);
  });

  test("rejects empty object", () => {
    expect(validate({})).toBe(false);
  });

  test("rejects wrong contract_version", () => {
    expect(validate(validContract({ contract_version: 2 }))).toBe(false);
  });

  test("rejects contract_version as string", () => {
    expect(validate(validContract({ contract_version: "1" }))).toBe(false);
  });

  test("rejects empty name", () => {
    expect(validate(validContract({ name: "" }))).toBe(false);
  });

  test("rejects name exceeding max length", () => {
    expect(validate(validContract({ name: "x".repeat(129) }))).toBe(false);
  });

  test("rejects invalid mode value", () => {
    expect(validate(validContract({ mode: "discovery" }))).toBe(false);
  });

  test("rejects empty seed", () => {
    expect(validate(validContract({ seed: "" }))).toBe(false);
  });

  test("rejects unknown top-level properties", () => {
    expect(validate(validContract({ unknown_field: "value" }))).toBe(false);
  });

  test("rejects contract_version 0", () => {
    expect(validate(validContract({ contract_version: 0 }))).toBe(false);
  });

  test("rejects negative contract_version", () => {
    expect(validate(validContract({ contract_version: -1 }))).toBe(false);
  });

  test("rejects floating point contract_version", () => {
    expect(validate(validContract({ contract_version: 1.5 }))).toBe(false);
  });

  test("accepts name at max length (128 chars)", () => {
    expect(validate(validContract({ name: "x".repeat(128) }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Boundary tests — maxProperties, maxItems, max values
// ---------------------------------------------------------------------------

describe("grove-contract schema — boundary values", () => {
  const validate = createValidator();

  test("accepts exactly 50 metrics (maxProperties boundary)", () => {
    const metrics: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      metrics[`metric_${String(i).padStart(3, "0")}`] = { direction: "minimize" };
    }
    expect(validate(validContract({ metrics }))).toBe(true);
  });

  test("rejects 51 metrics (exceeds maxProperties)", () => {
    const metrics: Record<string, unknown> = {};
    for (let i = 0; i < 51; i++) {
      metrics[`metric_${String(i).padStart(3, "0")}`] = { direction: "minimize" };
    }
    expect(validate(validContract({ metrics }))).toBe(false);
  });

  test("accepts exactly 20 gates (maxItems boundary)", () => {
    const gates = Array.from({ length: 20 }, () => ({
      type: "has_artifact",
      name: "run.log",
    }));
    expect(validate(validContract({ gates }))).toBe(true);
  });

  test("rejects 21 gates (exceeds maxItems)", () => {
    const gates = Array.from({ length: 21 }, () => ({
      type: "has_artifact",
      name: "run.log",
    }));
    expect(validate(validContract({ gates }))).toBe(false);
  });

  test("accepts max_rounds_without_improvement at maximum (1000)", () => {
    const contract = validContract({
      stop_conditions: { max_rounds_without_improvement: 1000 },
    });
    expect(validate(contract)).toBe(true);
  });

  test("rejects max_rounds_without_improvement above maximum (1001)", () => {
    const contract = validContract({
      stop_conditions: { max_rounds_without_improvement: 1001 },
    });
    expect(validate(contract)).toBe(false);
  });

  test("accepts default_lease_seconds at minimum (30)", () => {
    const contract = validContract({
      claim_policy: { default_lease_seconds: 30 },
    });
    expect(validate(contract)).toBe(true);
  });

  test("accepts default_lease_seconds at maximum (86400)", () => {
    const contract = validContract({
      claim_policy: { default_lease_seconds: 86400 },
    });
    expect(validate(contract)).toBe(true);
  });

  test("rejects floating point default_lease_seconds", () => {
    const contract = validContract({
      claim_policy: { default_lease_seconds: 300.5 },
    });
    expect(validate(contract)).toBe(false);
  });

  test("accepts max_claims_per_agent at maximum (100)", () => {
    const contract = validContract({
      claim_policy: { max_claims_per_agent: 100 },
    });
    expect(validate(contract)).toBe(true);
  });

  test("rejects max_claims_per_agent above maximum (101)", () => {
    const contract = validContract({
      claim_policy: { max_claims_per_agent: 101 },
    });
    expect(validate(contract)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Example GROVE.md files — validate frontmatter against schema
// ---------------------------------------------------------------------------

describe("grove-contract schema — example GROVE.md files", () => {
  const validate = createValidator();
  const examplesDir = join(import.meta.dir, "..", "examples");

  test("autoresearch.grove.md frontmatter is valid", () => {
    const frontmatter = extractFrontmatter(join(examplesDir, "autoresearch.grove.md"));
    expect(validate(frontmatter)).toBe(true);
  });

  test("code-optimization.grove.md frontmatter is valid", () => {
    const frontmatter = extractFrontmatter(join(examplesDir, "code-optimization.grove.md"));
    expect(validate(frontmatter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-schema consistency
// ---------------------------------------------------------------------------

describe("grove-contract schema — cross-schema consistency", () => {
  test("mode enum matches contribution schema contribution_mode enum", () => {
    const contractMode = groveContractSchema.properties.mode;
    const contributionMode = (contributionSchema.$defs as { contribution_mode: { enum: string[] } })
      .contribution_mode;

    // grove-contract uses $ref to contribution_mode, so mode should have $ref
    expect(contractMode.$ref).toBe(
      "https://grove.dev/schemas/contribution.json#/$defs/contribution_mode",
    );
    // The referenced enum should have both modes
    expect(contributionMode.enum).toEqual(["evaluation", "exploration"]);
  });

  test("metric direction uses $ref to contribution schema score_direction", () => {
    const metricDef = groveContractSchema.$defs.metric_definition;
    expect(metricDef.properties.direction.$ref).toBe(
      "https://grove.dev/schemas/contribution.json#/$defs/score_direction",
    );
  });

  test("gate relation_type uses $ref to contribution schema relation_type", () => {
    const gate = groveContractSchema.$defs.gate;
    expect(gate.properties.relation_type.$ref).toBe(
      "https://grove.dev/schemas/contribution.json#/$defs/relation_type",
    );
  });

  test("allowed_kinds items use $ref to contribution schema contribution_kind", () => {
    const allowedKinds = groveContractSchema.$defs.agent_constraints.properties.allowed_kinds;
    expect(allowedKinds.items.$ref).toBe(
      "https://grove.dev/schemas/contribution.json#/$defs/contribution_kind",
    );
  });

  test("relation_requirements items use $ref to contribution schema relation_type", () => {
    const relReqs = groveContractSchema.$defs.relation_requirements;
    expect(relReqs.items.$ref).toBe(
      "https://grove.dev/schemas/contribution.json#/$defs/relation_type",
    );
  });

  test("gate type enum covers all expected gate types", () => {
    const gateTypes = groveContractSchema.$defs.gate.properties.type.enum;
    expect(gateTypes).toEqual([
      "metric_improves",
      "has_artifact",
      "has_relation",
      "min_reviews",
      "min_score",
    ]);
  });
});
