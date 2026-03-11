import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentTopology } from "./contract.js";
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
    expect(() => parseGroveContract(content)).toThrow("missing required field 'contract_version'");
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
      "missing required field 'contract_version'",
    );
  });

  test("rejects null input", () => {
    expect(() => parseGroveContractObject(null)).toThrow("not a valid object");
  });

  test("rejects invalid V2 schema", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad",
        concurrency: { max_active_claims: -1 },
      }),
    ).toThrow("Invalid GROVE.md contract (v2)");
  });
});

// ---------------------------------------------------------------------------
// V2 contract parsing
// ---------------------------------------------------------------------------

describe("V2 contracts", () => {
  test("parses V2 contract with concurrency, execution, rate_limits, retry", () => {
    const content = `---
contract_version: 2
name: v2-grove
concurrency:
  max_active_claims: 10
  max_claims_per_agent: 3
  max_claims_per_target: 1
execution:
  default_lease_seconds: 300
  max_lease_seconds: 3600
  heartbeat_interval_seconds: 30
  stall_timeout_seconds: 120
rate_limits:
  max_contributions_per_agent_per_hour: 50
  max_contributions_per_grove_per_hour: 200
  max_artifact_size_bytes: 10485760
  max_artifacts_per_contribution: 5
retry:
  base_delay_ms: 1000
  max_backoff_ms: 60000
  max_attempts: 5
---
`;
    const contract = parseGroveContract(content);
    expect(contract.contractVersion).toBe(2);
    expect(contract.name).toBe("v2-grove");

    expect(contract.concurrency?.maxActiveClaims).toBe(10);
    expect(contract.concurrency?.maxClaimsPerAgent).toBe(3);
    expect(contract.concurrency?.maxClaimsPerTarget).toBe(1);

    expect(contract.execution?.defaultLeaseSeconds).toBe(300);
    expect(contract.execution?.maxLeaseSeconds).toBe(3600);
    expect(contract.execution?.heartbeatIntervalSeconds).toBe(30);
    expect(contract.execution?.stallTimeoutSeconds).toBe(120);

    expect(contract.rateLimits?.maxContributionsPerAgentPerHour).toBe(50);
    expect(contract.rateLimits?.maxContributionsPerGrovePerHour).toBe(200);
    expect(contract.rateLimits?.maxArtifactSizeBytes).toBe(10485760);
    expect(contract.rateLimits?.maxArtifactsPerContribution).toBe(5);

    expect(contract.retry?.baseDelayMs).toBe(1000);
    expect(contract.retry?.maxBackoffMs).toBe(60000);
    expect(contract.retry?.maxAttempts).toBe(5);
  });

  test("parses minimal V2 contract", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "minimal-v2",
    });
    expect(contract.contractVersion).toBe(2);
    expect(contract.concurrency).toBeUndefined();
    expect(contract.execution).toBeUndefined();
    expect(contract.rateLimits).toBeUndefined();
    expect(contract.retry).toBeUndefined();
  });

  test("rejects unsupported contract_version with supported list", () => {
    expect(() => parseGroveContractObject({ contract_version: 99, name: "bad" })).toThrow(
      "supported: 1, 2, 3",
    );
  });

  test("rejects defaultLeaseSeconds exceeding maxLeaseSeconds", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-lease",
        execution: {
          default_lease_seconds: 7200,
          max_lease_seconds: 3600,
        },
      }),
    ).toThrow("default_lease_seconds");
  });

  test("rejects heartbeatIntervalSeconds >= stallTimeoutSeconds", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-heartbeat",
        execution: {
          heartbeat_interval_seconds: 120,
          stall_timeout_seconds: 60,
        },
      }),
    ).toThrow("heartbeat_interval_seconds");
  });

  test("rejects per-agent rate exceeding per-grove rate", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-rate",
        rate_limits: {
          max_contributions_per_agent_per_hour: 100,
          max_contributions_per_grove_per_hour: 50,
        },
      }),
    ).toThrow("max_contributions_per_agent_per_hour");
  });
});

// ---------------------------------------------------------------------------
// Gate validation errors
// ---------------------------------------------------------------------------

describe("gate validation", () => {
  test("rejects has_artifact gate without name", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 1,
        name: "test",
        gates: [{ type: "has_artifact" }],
      }),
    ).toThrow("Invalid GROVE.md contract");
  });

  test("rejects has_relation gate without relation_type", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 1,
        name: "test",
        gates: [{ type: "has_relation" }],
      }),
    ).toThrow("Invalid GROVE.md contract");
  });

  test("rejects min_reviews gate without count", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 1,
        name: "test",
        gates: [{ type: "min_reviews" }],
      }),
    ).toThrow("Invalid GROVE.md contract");
  });

  test("rejects min_score gate without metric", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 1,
        name: "test",
        gates: [{ type: "min_score", threshold: 0.5 }],
      }),
    ).toThrow("Invalid GROVE.md contract");
  });

  test("rejects min_score gate without threshold", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 1,
        name: "test",
        metrics: { acc: { direction: "maximize" } },
        gates: [{ type: "min_score", metric: "acc" }],
      }),
    ).toThrow("Invalid GROVE.md contract");
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

// ---------------------------------------------------------------------------
// Gossip contract config
// ---------------------------------------------------------------------------

describe("gossip contract config", () => {
  test("parses V2 contract with gossip section", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "gossip-grove",
      gossip: {
        interval_seconds: 60,
        fan_out: 5,
        partial_view_size: 20,
        shuffle_length: 8,
        suspicion_timeout_seconds: 120,
        failure_timeout_seconds: 300,
        digest_limit: 10,
      },
    });

    expect(contract.gossip).toBeDefined();
    expect(contract.gossip?.intervalSeconds).toBe(60);
    expect(contract.gossip?.fanOut).toBe(5);
    expect(contract.gossip?.partialViewSize).toBe(20);
    expect(contract.gossip?.shuffleLength).toBe(8);
    expect(contract.gossip?.suspicionTimeoutSeconds).toBe(120);
    expect(contract.gossip?.failureTimeoutSeconds).toBe(300);
    expect(contract.gossip?.digestLimit).toBe(10);
  });

  test("gossip section is optional", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "no-gossip",
    });

    expect(contract.gossip).toBeUndefined();
  });

  test("rejects suspicion_timeout >= failure_timeout", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-gossip",
        gossip: {
          suspicion_timeout_seconds: 200,
          failure_timeout_seconds: 100,
        },
      }),
    ).toThrow("suspicion_timeout_seconds");
  });

  test("rejects shuffle_length > partial_view_size", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-gossip",
        gossip: {
          shuffle_length: 15,
          partial_view_size: 10,
        },
      }),
    ).toThrow("shuffle_length");
  });

  test("rejects unknown gossip fields", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-gossip",
        gossip: {
          unknown_field: 42,
        },
      }),
    ).toThrow();
  });

  test("gossip not available in V1 contracts", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 1,
        name: "v1-gossip",
        gossip: { interval_seconds: 30 },
      }),
    ).toThrow();
  });

  test("parses partial gossip config", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "partial-gossip",
      gossip: {
        interval_seconds: 45,
      },
    });

    expect(contract.gossip?.intervalSeconds).toBe(45);
    expect(contract.gossip?.fanOut).toBeUndefined();
    expect(contract.gossip?.partialViewSize).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Outcome policy
// ---------------------------------------------------------------------------

describe("outcome_policy contract config", () => {
  test("parses V2 contract with full outcome_policy", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "outcome-grove",
      outcome_policy: {
        auto_accept: {
          metric_improves: "val_bpb",
          all_gates_pass: true,
        },
        auto_reject: {
          metric_regresses: "val_bpb",
          missing_required_artifacts: true,
        },
        require_manual_review: false,
      },
    });

    expect(contract.outcomePolicy).toBeDefined();
    expect(contract.outcomePolicy?.autoAccept?.metricImproves).toBe("val_bpb");
    expect(contract.outcomePolicy?.autoAccept?.allGatesPass).toBe(true);
    expect(contract.outcomePolicy?.autoReject?.metricRegresses).toBe("val_bpb");
    expect(contract.outcomePolicy?.autoReject?.missingRequiredArtifacts).toBe(true);
    expect(contract.outcomePolicy?.requireManualReview).toBe(false);
  });

  test("outcome_policy is optional", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "no-outcome",
    });

    expect(contract.outcomePolicy).toBeUndefined();
  });

  test("parses partial outcome_policy with only auto_accept", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "partial-outcome",
      outcome_policy: {
        auto_accept: {
          all_gates_pass: true,
        },
      },
    });

    expect(contract.outcomePolicy?.autoAccept?.allGatesPass).toBe(true);
    expect(contract.outcomePolicy?.autoAccept?.metricImproves).toBeUndefined();
    expect(contract.outcomePolicy?.autoReject).toBeUndefined();
    expect(contract.outcomePolicy?.requireManualReview).toBeUndefined();
  });

  test("parses outcome_policy with only require_manual_review", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "manual-review",
      outcome_policy: {
        require_manual_review: true,
      },
    });

    expect(contract.outcomePolicy?.requireManualReview).toBe(true);
    expect(contract.outcomePolicy?.autoAccept).toBeUndefined();
    expect(contract.outcomePolicy?.autoReject).toBeUndefined();
  });

  test("rejects unknown fields in outcome_policy", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-outcome",
        outcome_policy: {
          unknown_field: true,
        },
      }),
    ).toThrow();
  });

  test("rejects unknown fields in auto_accept", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-outcome",
        outcome_policy: {
          auto_accept: {
            bad_field: "oops",
          },
        },
      }),
    ).toThrow();
  });

  test("outcome_policy not available in V1 contracts", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 1,
        name: "v1-outcome",
        outcome_policy: {
          require_manual_review: true,
        },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Topology contract config
// ---------------------------------------------------------------------------

describe("topology contract config", () => {
  test("parses V2 contract with full topology (graph structure, multiple roles with edges, spawning)", () => {
    const content = `---
contract_version: 2
name: topology-grove
topology:
  structure: graph
  roles:
    - name: orchestrator
      description: Coordinates worker agents
      max_instances: 1
      edges:
        - target: worker
          edge_type: delegates
        - target: reviewer
          edge_type: requests
    - name: worker
      description: Performs tasks
      max_instances: 5
      edges:
        - target: orchestrator
          edge_type: reports
    - name: reviewer
      description: Reviews work output
      max_instances: 2
      edges:
        - target: orchestrator
          edge_type: feedback
  spawning:
    dynamic: true
    max_depth: 3
    max_children_per_agent: 5
    timeout_seconds: 300
  edge_types:
    - custom-notify
    - custom-sync
---
`;
    const contract = parseGroveContract(content);
    expect(contract.contractVersion).toBe(2);

    const topo = contract.topology as AgentTopology;
    expect(topo).toBeDefined();
    expect(topo.structure).toBe("graph");

    // Roles
    expect(topo.roles).toHaveLength(3);
    expect(topo.roles[0]?.name).toBe("orchestrator");
    expect(topo.roles[0]?.description).toBe("Coordinates worker agents");
    expect(topo.roles[0]?.maxInstances).toBe(1);
    expect(topo.roles[0]?.edges).toHaveLength(2);
    expect(topo.roles[0]?.edges?.[0]?.target).toBe("worker");
    expect(topo.roles[0]?.edges?.[0]?.edgeType).toBe("delegates");
    expect(topo.roles[0]?.edges?.[1]?.target).toBe("reviewer");
    expect(topo.roles[0]?.edges?.[1]?.edgeType).toBe("requests");

    expect(topo.roles[1]?.name).toBe("worker");
    expect(topo.roles[1]?.maxInstances).toBe(5);
    expect(topo.roles[1]?.edges).toHaveLength(1);
    expect(topo.roles[1]?.edges?.[0]?.target).toBe("orchestrator");
    expect(topo.roles[1]?.edges?.[0]?.edgeType).toBe("reports");

    expect(topo.roles[2]?.name).toBe("reviewer");
    expect(topo.roles[2]?.edges?.[0]?.edgeType).toBe("feedback");

    // Spawning
    expect(topo.spawning).toBeDefined();
    expect(topo.spawning?.dynamic).toBe(true);
    expect(topo.spawning?.maxDepth).toBe(3);
    expect(topo.spawning?.maxChildrenPerAgent).toBe(5);
    expect(topo.spawning?.timeoutSeconds).toBe(300);

    // Custom edge types
    expect(topo.edgeTypes).toEqual(["custom-notify", "custom-sync"]);
  });

  test("parses minimal topology (flat, one role, no edges)", () => {
    const content = `---
contract_version: 2
name: flat-grove
topology:
  structure: flat
  roles:
    - name: agent
---
`;
    const contract = parseGroveContract(content);
    const topo = contract.topology as AgentTopology;
    expect(topo).toBeDefined();
    expect(topo.structure).toBe("flat");
    expect(topo.roles).toHaveLength(1);
    expect(topo.roles[0]?.name).toBe("agent");
    expect(topo.roles[0]?.edges).toBeUndefined();
    expect(topo.spawning).toBeUndefined();
    expect(topo.edgeTypes).toBeUndefined();
  });

  test("topology is optional — omitted topology parses fine", () => {
    const contract = parseGroveContractObject({
      contract_version: 2,
      name: "no-topology",
    });
    expect(contract.topology).toBeUndefined();
  });

  test("rejects edge referencing undefined role name", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-edge",
        topology: {
          structure: "graph",
          roles: [
            {
              name: "orchestrator",
              edges: [{ target: "nonexistent", edge_type: "delegates" }],
            },
          ],
        },
      }),
    ).toThrow("not a defined role");
  });

  test("rejects self-edges (role name same as edge target)", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "self-edge",
        topology: {
          structure: "graph",
          roles: [
            {
              name: "agent",
              edges: [{ target: "agent", edge_type: "delegates" }],
            },
          ],
        },
      }),
    ).toThrow("self-edge");
  });

  test("rejects flat topology with edges", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "flat-with-edges",
        topology: {
          structure: "flat",
          roles: [
            { name: "alpha" },
            {
              name: "beta",
              edges: [{ target: "alpha", edge_type: "feeds" }],
            },
          ],
        },
      }),
    ).toThrow("flat topology must not have edges");
  });

  test("rejects duplicate role names", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "dup-roles",
        topology: {
          structure: "graph",
          roles: [{ name: "agent" }, { name: "agent" }],
        },
      }),
    ).toThrow("duplicate role names");
  });

  test("rejects unknown fields in topology (strict mode)", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "strict-topo",
        topology: {
          structure: "graph",
          roles: [{ name: "agent" }],
          unknown_field: true,
        },
      }),
    ).toThrow();
  });

  test("rejects topology in V1 contracts", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 1,
        name: "v1-topology",
        topology: {
          structure: "flat",
          roles: [{ name: "agent" }],
        },
      }),
    ).toThrow();
  });

  test("parses tree topology with valid single-parent constraint", () => {
    const content = `---
contract_version: 2
name: tree-grove
topology:
  structure: tree
  roles:
    - name: root
      edges:
        - target: child-a
          edge_type: delegates
        - target: child-b
          edge_type: delegates
    - name: child-a
    - name: child-b
---
`;
    const contract = parseGroveContract(content);
    const topo = contract.topology as AgentTopology;
    expect(topo).toBeDefined();
    expect(topo.structure).toBe("tree");
    expect(topo.roles).toHaveLength(3);
    expect(topo.roles[0]?.name).toBe("root");
    expect(topo.roles[0]?.edges).toHaveLength(2);
  });

  test("rejects tree topology where a role has multiple incoming edges", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 2,
        name: "bad-tree",
        topology: {
          structure: "tree",
          roles: [
            {
              name: "root",
              edges: [{ target: "child", edge_type: "delegates" }],
            },
            {
              name: "other-parent",
              edges: [{ target: "child", edge_type: "delegates" }],
            },
            { name: "child" },
          ],
        },
      }),
    ).toThrow("single parent");
  });
});

// ---------------------------------------------------------------------------
// V3 contract parsing (agent_topology)
// ---------------------------------------------------------------------------

describe("V3 contracts", () => {
  test("parses V3 contract with agent_topology", () => {
    const content = `---
contract_version: 3
name: v3-grove
agent_topology:
  structure: graph
  roles:
    - name: orchestrator
      max_instances: 1
      edges:
        - target: worker
          edge_type: delegates
    - name: worker
      max_instances: 5
  spawning:
    dynamic: true
    max_depth: 3
---
`;
    const contract = parseGroveContract(content);
    expect(contract.contractVersion).toBe(3);
    expect(contract.name).toBe("v3-grove");

    const topo = contract.topology as AgentTopology;
    expect(topo).toBeDefined();
    expect(topo.structure).toBe("graph");
    expect(topo.roles).toHaveLength(2);
    expect(topo.roles[0]?.name).toBe("orchestrator");
    expect(topo.roles[1]?.name).toBe("worker");
    expect(topo.spawning?.dynamic).toBe(true);
    expect(topo.spawning?.maxDepth).toBe(3);
  });

  test("parses minimal V3 contract", () => {
    const contract = parseGroveContractObject({
      contract_version: 3,
      name: "minimal-v3",
    });
    expect(contract.contractVersion).toBe(3);
    expect(contract.topology).toBeUndefined();
    expect(contract.concurrency).toBeUndefined();
  });

  test("V3 maps agent_topology to topology field in GroveContract", () => {
    const contract = parseGroveContractObject({
      contract_version: 3,
      name: "v3-mapping",
      agent_topology: {
        structure: "flat",
        roles: [{ name: "agent" }],
      },
    });
    expect(contract.topology).toBeDefined();
    expect(contract.topology?.structure).toBe("flat");
    expect(contract.topology?.roles[0]?.name).toBe("agent");
  });

  test("V3 supports concurrency, execution, rate_limits, retry, gossip, outcome_policy", () => {
    const contract = parseGroveContractObject({
      contract_version: 3,
      name: "v3-full",
      concurrency: { max_active_claims: 10 },
      execution: { default_lease_seconds: 300 },
      rate_limits: { max_contributions_per_agent_per_hour: 50 },
      retry: { max_attempts: 3 },
      gossip: { interval_seconds: 30 },
      outcome_policy: { require_manual_review: true },
    });
    expect(contract.concurrency?.maxActiveClaims).toBe(10);
    expect(contract.execution?.defaultLeaseSeconds).toBe(300);
    expect(contract.rateLimits?.maxContributionsPerAgentPerHour).toBe(50);
    expect(contract.retry?.maxAttempts).toBe(3);
    expect(contract.gossip?.intervalSeconds).toBe(30);
    expect(contract.outcomePolicy?.requireManualReview).toBe(true);
  });

  test("V3 rejects old 'topology' field (strict mode)", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 3,
        name: "v3-old-topology",
        topology: {
          structure: "flat",
          roles: [{ name: "agent" }],
        },
      }),
    ).toThrow("Invalid GROVE.md contract (v3)");
  });

  test("V3 validates metric cross-references", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 3,
        name: "v3-bad-metric",
        metrics: { accuracy: { direction: "maximize" } },
        gates: [{ type: "metric_improves", metric: "nonexistent" }],
      }),
    ).toThrow("undefined metric 'nonexistent'");
  });

  test("V3 validates execution constraints", () => {
    expect(() =>
      parseGroveContractObject({
        contract_version: 3,
        name: "v3-bad-exec",
        execution: {
          default_lease_seconds: 7200,
          max_lease_seconds: 3600,
        },
      }),
    ).toThrow("default_lease_seconds");
  });
});
