import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseGroveContract, parseGroveContractObject } from "./contract.js";

// ---------------------------------------------------------------------------
// parseGroveContract — YAML frontmatter parsing
// ---------------------------------------------------------------------------

describe("parseGroveContract", () => {
  test("parses minimal valid GROVE.md", () => {
    const content = `---
contract_version: 1
name: test-grove
---
# Test Grove
`;
    const contract = parseGroveContract(content);
    expect(contract.contractVersion).toBe(1);
    expect(contract.name).toBe("test-grove");
    expect(contract.description).toBeUndefined();
    expect(contract.mode).toBeUndefined();
    expect(contract.metrics).toBeUndefined();
    expect(contract.gates).toBeUndefined();
    expect(contract.stopConditions).toBeUndefined();
    expect(contract.agentConstraints).toBeUndefined();
    expect(contract.claimPolicy).toBeUndefined();
  });

  test("parses full contract with all fields", () => {
    const content = `---
contract_version: 1
name: full-grove
description: A full test grove
mode: evaluation
seed: initial-seed

metrics:
  val_bpb:
    direction: minimize
    unit: bpb
    description: Validation bits-per-byte
    gate: 1.5
  throughput:
    direction: maximize
    unit: tokens/sec

gates:
  - type: metric_improves
    metric: val_bpb
  - type: has_artifact
    name: run.log
  - type: has_relation
    relation_type: derives_from
  - type: min_reviews
    count: 2
    threshold: 0.7
  - type: min_score
    metric: val_bpb
    threshold: 1.0

stop_conditions:
  max_rounds_without_improvement: 10
  target_metric:
    metric: val_bpb
    value: 0.85
  budget:
    max_contributions: 500
    max_wall_clock_seconds: 86400
  quorum_review_score:
    min_reviews: 3
    min_score: 0.8
  deliberation_limit:
    max_rounds: 5
    max_messages: 100

agent_constraints:
  allowed_kinds:
    - work
    - review
    - reproduction
  required_artifacts:
    work:
      - train.py
      - run.log
  required_relations:
    review:
      - reviews

claim_policy:
  default_lease_seconds: 600
  max_claims_per_agent: 2
  heartbeat_required: true
---

# Full Grove
`;
    const contract = parseGroveContract(content);

    // Metadata
    expect(contract.contractVersion).toBe(1);
    expect(contract.name).toBe("full-grove");
    expect(contract.description).toBe("A full test grove");
    expect(contract.mode).toBe("evaluation");
    expect(contract.seed).toBe("initial-seed");

    // Metrics
    expect(contract.metrics).toBeDefined();
    expect(contract.metrics?.val_bpb?.direction).toBe("minimize");
    expect(contract.metrics?.val_bpb?.unit).toBe("bpb");
    expect(contract.metrics?.val_bpb?.gate).toBe(1.5);
    expect(contract.metrics?.throughput?.direction).toBe("maximize");

    // Gates
    expect(contract.gates).toHaveLength(5);
    expect(contract.gates?.[0]?.type).toBe("metric_improves");
    expect(contract.gates?.[0]?.metric).toBe("val_bpb");
    expect(contract.gates?.[1]?.type).toBe("has_artifact");
    expect(contract.gates?.[1]?.name).toBe("run.log");
    expect(contract.gates?.[2]?.type).toBe("has_relation");
    expect(contract.gates?.[2]?.relationType).toBe("derives_from");
    expect(contract.gates?.[3]?.type).toBe("min_reviews");
    expect(contract.gates?.[3]?.count).toBe(2);
    expect(contract.gates?.[3]?.threshold).toBe(0.7);
    expect(contract.gates?.[4]?.type).toBe("min_score");
    expect(contract.gates?.[4]?.metric).toBe("val_bpb");
    expect(contract.gates?.[4]?.threshold).toBe(1.0);

    // Stop conditions
    expect(contract.stopConditions).toBeDefined();
    expect(contract.stopConditions?.maxRoundsWithoutImprovement).toBe(10);
    expect(contract.stopConditions?.targetMetric).toEqual({ metric: "val_bpb", value: 0.85 });
    expect(contract.stopConditions?.budget).toEqual({
      maxContributions: 500,
      maxWallClockSeconds: 86400,
    });
    expect(contract.stopConditions?.quorumReviewScore).toEqual({ minReviews: 3, minScore: 0.8 });
    expect(contract.stopConditions?.deliberationLimit).toEqual({ maxRounds: 5, maxMessages: 100 });

    // Agent constraints
    expect(contract.agentConstraints).toBeDefined();
    expect(contract.agentConstraints?.allowedKinds).toEqual(["work", "review", "reproduction"]);
    expect(contract.agentConstraints?.requiredArtifacts).toEqual({
      work: ["train.py", "run.log"],
    });
    expect(contract.agentConstraints?.requiredRelations).toEqual({ review: ["reviews"] });

    // Claim policy
    expect(contract.claimPolicy).toBeDefined();
    expect(contract.claimPolicy?.defaultLeaseSeconds).toBe(600);
    expect(contract.claimPolicy?.maxClaimsPerAgent).toBe(2);
    expect(contract.claimPolicy?.heartbeatRequired).toBe(true);
  });

  test("handles missing optional fields gracefully", () => {
    const content = `---
contract_version: 1
name: sparse-grove
stop_conditions:
  budget:
    max_contributions: 100
  deliberation_limit:
    max_messages: 50
---
`;
    const contract = parseGroveContract(content);
    expect(contract.stopConditions?.budget?.maxContributions).toBe(100);
    expect(contract.stopConditions?.budget?.maxWallClockSeconds).toBeUndefined();
    expect(contract.stopConditions?.deliberationLimit?.maxRounds).toBeUndefined();
    expect(contract.stopConditions?.deliberationLimit?.maxMessages).toBe(50);
  });

  test("rejects missing frontmatter", () => {
    expect(() => parseGroveContract("# No frontmatter")).toThrow("no YAML frontmatter");
  });

  test("rejects unclosed frontmatter", () => {
    expect(() => parseGroveContract("---\ncontract_version: 1\nname: test\n")).toThrow(
      "no YAML frontmatter",
    );
  });

  test("rejects missing contract_version", () => {
    const content = `---
name: no-version
---
`;
    expect(() => parseGroveContract(content)).toThrow("Invalid GROVE.md contract");
  });

  test("rejects missing name", () => {
    const content = `---
contract_version: 1
---
`;
    expect(() => parseGroveContract(content)).toThrow("Invalid GROVE.md contract");
  });

  test("rejects unknown top-level fields", () => {
    const content = `---
contract_version: 1
name: test
unknown_field: oops
---
`;
    expect(() => parseGroveContract(content)).toThrow("Invalid GROVE.md contract");
  });

  test("rejects invalid metric name pattern", () => {
    const content = `---
contract_version: 1
name: test
metrics:
  InvalidName:
    direction: minimize
---
`;
    expect(() => parseGroveContract(content)).toThrow("Invalid GROVE.md contract");
  });

  test("rejects invalid gate type", () => {
    const content = `---
contract_version: 1
name: test
gates:
  - type: invalid_gate
---
`;
    expect(() => parseGroveContract(content)).toThrow("Invalid GROVE.md contract");
  });

  test("rejects metric_improves gate without metric field", () => {
    const content = `---
contract_version: 1
name: test
gates:
  - type: metric_improves
---
`;
    expect(() => parseGroveContract(content)).toThrow("Invalid GROVE.md contract");
  });

  test("rejects budget with neither field", () => {
    const content = `---
contract_version: 1
name: test
stop_conditions:
  budget: {}
---
`;
    expect(() => parseGroveContract(content)).toThrow("Invalid GROVE.md contract");
  });

  test("rejects duplicate relation types in required_relations", () => {
    const content = `---
contract_version: 1
name: test
agent_constraints:
  required_relations:
    review:
      - reviews
      - reviews
---
`;
    expect(() => parseGroveContract(content)).toThrow("Invalid GROVE.md contract");
  });

  test("rejects target_metric referencing undefined metric", () => {
    const content = `---
contract_version: 1
name: test
metrics:
  val_bpb:
    direction: minimize
stop_conditions:
  target_metric:
    metric: nonexistent
    value: 0.85
---
`;
    expect(() => parseGroveContract(content)).toThrow("undefined metric 'nonexistent'");
  });

  test("rejects gate referencing undefined metric", () => {
    const content = `---
contract_version: 1
name: test
metrics:
  val_bpb:
    direction: minimize
gates:
  - type: metric_improves
    metric: typo_metric
---
`;
    expect(() => parseGroveContract(content)).toThrow("undefined metric 'typo_metric'");
  });

  test("accepts max_rounds_without_improvement with no metrics (evaluates as not-met at runtime)", () => {
    const content = `---
contract_version: 1
name: test
stop_conditions:
  max_rounds_without_improvement: 5
---
`;
    const contract = parseGroveContract(content);
    expect(contract.stopConditions?.maxRoundsWithoutImprovement).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// parseGroveContractObject — plain object parsing
// ---------------------------------------------------------------------------

describe("parseGroveContractObject", () => {
  test("parses a valid plain object", () => {
    const obj = {
      contract_version: 1,
      name: "object-grove",
      metrics: {
        accuracy: { direction: "maximize" },
      },
    };
    const contract = parseGroveContractObject(obj);
    expect(contract.name).toBe("object-grove");
    expect(contract.metrics?.accuracy?.direction).toBe("maximize");
  });

  test("rejects invalid object", () => {
    expect(() => parseGroveContractObject({ name: "no-version" })).toThrow(
      "Invalid grove contract",
    );
  });
});

// ---------------------------------------------------------------------------
// Example file conformance tests
// ---------------------------------------------------------------------------

describe("example GROVE.md files", () => {
  const specExamplesDir = join(import.meta.dir, "../../spec/examples");

  test("autoresearch.grove.md parses successfully", () => {
    const content = readFileSync(join(specExamplesDir, "autoresearch.grove.md"), "utf-8");
    const contract = parseGroveContract(content);

    expect(contract.name).toBe("llm-pretraining-optimization");
    expect(contract.mode).toBe("exploration");
    expect(contract.seed).toBe("initial-baseline-run");
    expect(Object.keys(contract.metrics ?? {})).toEqual(["val_bpb", "train_loss", "throughput"]);
    expect(contract.gates).toHaveLength(2);
    expect(contract.stopConditions?.maxRoundsWithoutImprovement).toBe(10);
    expect(contract.stopConditions?.targetMetric?.metric).toBe("val_bpb");
    expect(contract.stopConditions?.targetMetric?.value).toBe(0.85);
    expect(contract.stopConditions?.budget?.maxContributions).toBe(500);
    expect(contract.stopConditions?.budget?.maxWallClockSeconds).toBe(86400);
    expect(contract.claimPolicy?.defaultLeaseSeconds).toBe(600);
  });

  test("code-optimization.grove.md parses successfully", () => {
    const content = readFileSync(join(specExamplesDir, "code-optimization.grove.md"), "utf-8");
    const contract = parseGroveContract(content);

    expect(contract.name).toBe("attention-kernel-optimization");
    expect(contract.mode).toBe("evaluation");
    expect(Object.keys(contract.metrics ?? {})).toEqual(["latency_ms", "throughput", "memory_mb"]);
    expect(contract.gates).toHaveLength(3);
    expect(contract.stopConditions?.targetMetric?.metric).toBe("latency_ms");
    expect(contract.stopConditions?.targetMetric?.value).toBe(10);
    expect(contract.stopConditions?.quorumReviewScore?.minReviews).toBe(2);
    expect(contract.stopConditions?.quorumReviewScore?.minScore).toBe(0.8);
    expect(contract.stopConditions?.deliberationLimit?.maxRounds).toBe(5);
    expect(contract.agentConstraints?.allowedKinds).toEqual(["work", "review", "reproduction"]);
  });
});
