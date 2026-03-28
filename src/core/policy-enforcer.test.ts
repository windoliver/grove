/**
 * PolicyEnforcer conformance tests.
 *
 * Tests the full enforcement pipeline:
 * - Score requirements (gate-driven)
 * - Gate checks (metric_improves, has_artifact, has_relation, min_score)
 * - Role-kind constraints
 * - Relation requirements
 * - Artifact requirements
 * - Outcome derivation (auto-accept/auto-reject)
 * - Stop condition evaluation (budget, target_metric, max_rounds_without_improvement)
 */

import { describe, expect, test } from "bun:test";

import type { GroveContract } from "./contract.js";
import { PolicyViolationError } from "./errors.js";
import type { Contribution, Score } from "./models.js";
import { PolicyEnforcer } from "./policy-enforcer.js";
import type { ContributionStore } from "./store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal contribution for testing. */
function makeContribution(overrides: Partial<Contribution> = {}): Contribution {
  return {
    cid: `blake3:${Math.random().toString(36).slice(2).padEnd(64, "0")}`,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary: "Test contribution",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "test-agent" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a score object. */
function score(value: number, direction: "minimize" | "maximize" = "minimize"): Score {
  return { value, direction };
}

/** Create a minimal in-memory contribution store for testing. */
function makeStore(contributions: Contribution[] = []): ContributionStore {
  const items = [...contributions];

  return {
    storeIdentity: undefined,
    put: async (c: Contribution) => {
      if (!items.find((x) => x.cid === c.cid)) items.push(c);
    },
    putMany: async (cs: readonly Contribution[]) => {
      for (const c of cs) {
        if (!items.find((x) => x.cid === c.cid)) items.push(c);
      }
    },
    get: async (cid: string) => items.find((c) => c.cid === cid),
    getMany: async (cids: readonly string[]) => {
      const cidSet = new Set(cids);
      const result = new Map<string, Contribution>();
      for (const c of items) {
        if (cidSet.has(c.cid)) result.set(c.cid, c);
      }
      return result;
    },
    list: async (query?) => {
      let result = [...items];
      if (query?.kind) result = result.filter((c) => c.kind === query.kind);
      if (query?.mode) result = result.filter((c) => c.mode === query.mode);
      if (query?.agentId) result = result.filter((c) => c.agent.agentId === query.agentId);
      if (query?.limit) result = result.slice(0, query.limit);
      return result;
    },
    children: async () => [],
    ancestors: async () => [],
    relationsOf: async () => [],
    relatedTo: async () => [],
    search: async () => [],
    findExisting: async () => [],
    count: async (query?) => {
      let result = [...items];
      if (query?.kind) result = result.filter((c) => c.kind === query.kind);
      if (query?.mode) result = result.filter((c) => c.mode === query.mode);
      return result.length;
    },
    countSince: async (query) => {
      return items.filter((c) => {
        if (query.agentId && c.agent.agentId !== query.agentId) return false;
        return c.createdAt >= query.since;
      }).length;
    },
    thread: async () => [],
    incomingSources: async () => [],
    replyCounts: async () => new Map(),
    hotThreads: async () => [],
    close: () => {
      /* noop */
    },
  };
}

/** Create a minimal contract for testing. */
function makeContract(overrides: Partial<GroveContract> = {}): GroveContract {
  return {
    contractVersion: 2,
    name: "test-contract",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Score enforcement (gate-driven)
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: score requirements", () => {
  test("missing score required by metric_improves gate → violation in lenient mode", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work", mode: "evaluation" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations.some((v) => v.type === "missing_score")).toBe(true);
  });

  test("missing score required by gate → throws in strict mode", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work", mode: "evaluation" });

    await expect(enforcer.enforce(contribution, true)).rejects.toBeInstanceOf(PolicyViolationError);
  });

  test("provided score → no violation", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
    });

    const result = await enforcer.enforce(contribution, false);
    // Only check score violations — gate checks may still have opinions
    expect(result.violations.filter((v) => v.type === "missing_score")).toHaveLength(0);
  });

  test("exploration mode → no score enforcement", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work", mode: "exploration" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "missing_score")).toHaveLength(0);
  });

  test("non-work kind → no score enforcement", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "review", mode: "evaluation" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "missing_score")).toHaveLength(0);
  });

  test("no gates defined → no score enforcement", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work", mode: "evaluation" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate checks
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: gate checks", () => {
  test("metric_improves: first contribution → passes (no baseline)", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "gate_failed")).toHaveLength(0);
  });

  test("metric_improves: better score (minimize) → passes", async () => {
    const existing = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.12) },
      createdAt: "2026-01-01T00:00:00Z",
    });

    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore([existing]);
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "gate_failed")).toHaveLength(0);
  });

  test("metric_improves: worse score (minimize) → gate_failed violation", async () => {
    const existing = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
      createdAt: "2026-01-01T00:00:00Z",
    });

    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore([existing]);
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.2) },
    });

    const result = await enforcer.enforce(contribution, false);
    const gateViolations = result.violations.filter((v) => v.type === "gate_failed");
    expect(gateViolations.length).toBe(1);
    expect(gateViolations[0]!.message).toContain("metric_improves");
  });

  test("has_artifact: artifact present → passes", async () => {
    const contract = makeContract({
      gates: [{ type: "has_artifact", name: "diff.patch" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      mode: "evaluation",
      artifacts: { "diff.patch": "blake3:abc123" },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "gate_failed")).toHaveLength(0);
  });

  test("has_artifact: artifact missing → gate_failed violation", async () => {
    const contract = makeContract({
      gates: [{ type: "has_artifact", name: "diff.patch" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ mode: "evaluation", artifacts: {} });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.some((v) => v.type === "gate_failed")).toBe(true);
  });

  test("has_relation: relation present → passes", async () => {
    const contract = makeContract({
      gates: [{ type: "has_relation", relationType: "derives_from" as "derives_from" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      mode: "evaluation",
      relations: [{ targetCid: "blake3:parent", relationType: "derives_from" }],
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "gate_failed")).toHaveLength(0);
  });

  test("min_score: score meets threshold → passes", async () => {
    const contract = makeContract({
      gates: [{ type: "min_score", metric: "quality", threshold: 0.7 }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      mode: "evaluation",
      scores: { quality: score(0.85, "maximize") },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "gate_failed")).toHaveLength(0);
  });

  test("min_score: score below threshold → gate_failed violation", async () => {
    const contract = makeContract({
      gates: [{ type: "min_score", metric: "quality", threshold: 0.7 }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      mode: "evaluation",
      scores: { quality: score(0.5, "maximize") },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.some((v) => v.type === "gate_failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Role-kind constraints
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: role-kind constraints", () => {
  test("allowed kind → passes", async () => {
    const contract = makeContract({
      agentConstraints: {
        allowedKinds: ["work", "plan"],
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "role_kind")).toHaveLength(0);
  });

  test("disallowed kind → role_kind violation", async () => {
    const contract = makeContract({
      agentConstraints: {
        allowedKinds: ["review"],
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.some((v) => v.type === "role_kind")).toBe(true);
    expect(result.passed).toBe(false);
  });

  test("disallowed kind → throws in strict mode", async () => {
    const contract = makeContract({
      mode: "evaluation",
      agentConstraints: {
        allowedKinds: ["review"],
      },
      gates: [{ type: "has_artifact", name: "dummy" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work", mode: "evaluation" });

    await expect(enforcer.enforce(contribution, true)).rejects.toBeInstanceOf(PolicyViolationError);
  });

  test("no allowedKinds → all kinds allowed", async () => {
    const contract = makeContract({
      agentConstraints: {},
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "ask_user" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "role_kind")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Relation requirements
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: relation requirements", () => {
  test("required relation present → passes", async () => {
    const contract = makeContract({
      agentConstraints: {
        requiredRelations: { review: ["reviews"] },
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "review",
      relations: [{ targetCid: "blake3:target", relationType: "reviews" }],
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "missing_relation")).toHaveLength(0);
  });

  test("required relation missing → missing_relation violation", async () => {
    const contract = makeContract({
      agentConstraints: {
        requiredRelations: { review: ["reviews"] },
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "review", relations: [] });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.some((v) => v.type === "missing_relation")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Artifact requirements
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: artifact requirements", () => {
  test("required artifact present → passes", async () => {
    const contract = makeContract({
      agentConstraints: {
        requiredArtifacts: { work: ["diff.patch"] },
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      artifacts: { "diff.patch": "blake3:abc" },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.violations.filter((v) => v.type === "missing_artifact")).toHaveLength(0);
  });

  test("required artifact missing → missing_artifact violation", async () => {
    const contract = makeContract({
      agentConstraints: {
        requiredArtifacts: { work: ["diff.patch", "config.json"] },
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      artifacts: { "diff.patch": "blake3:abc" },
    });

    const result = await enforcer.enforce(contribution, false);
    const artifactViolations = result.violations.filter((v) => v.type === "missing_artifact");
    expect(artifactViolations.length).toBe(1);
    expect(artifactViolations[0]!.message).toContain("config.json");
  });
});

// ---------------------------------------------------------------------------
// Outcome derivation
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: outcome derivation", () => {
  test("auto-accept: metric improves → derived 'accepted' outcome", async () => {
    const existing = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.12) },
      createdAt: "2026-01-01T00:00:00Z",
    });

    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      outcomePolicy: {
        autoAccept: { metricImproves: "val_bpb" },
      },
    });

    const store = makeStore([existing]);
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.derivedOutcome).toBeDefined();
    expect(result.derivedOutcome!.status).toBe("accepted");
    expect(result.derivedOutcome!.metricName).toBe("val_bpb");
  });

  test("auto-accept: first contribution → derived 'accepted'", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      outcomePolicy: {
        autoAccept: { metricImproves: "val_bpb" },
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.derivedOutcome).toBeDefined();
    expect(result.derivedOutcome!.status).toBe("accepted");
  });

  test("auto-reject: metric regresses → derived 'rejected' outcome", async () => {
    const existing = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
      createdAt: "2026-01-01T00:00:00Z",
    });

    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      outcomePolicy: {
        autoReject: { metricRegresses: "val_bpb" },
      },
    });

    const store = makeStore([existing]);
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.2) },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.derivedOutcome).toBeDefined();
    expect(result.derivedOutcome!.status).toBe("rejected");
    expect(result.derivedOutcome!.reason).toContain("regressed");
  });

  test("no outcome policy → no derived outcome", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.derivedOutcome).toBeUndefined();
  });

  test("exploration mode → no outcome derivation", async () => {
    const contract = makeContract({
      mode: "exploration",
      outcomePolicy: { autoAccept: { metricImproves: "val_bpb" } },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work", mode: "exploration" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.derivedOutcome).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stop condition evaluation
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: stop conditions", () => {
  test("budget: contributions exceed limit → stopped", async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeContribution({
        createdAt: new Date(Date.now() - (10 - i) * 1000).toISOString(),
      }),
    );

    const contract = makeContract({
      stopConditions: {
        budget: { maxContributions: 10 },
      },
    });

    const store = makeStore(items);
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution();

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult).toBeDefined();
    expect(result.stopResult!.stopped).toBe(true);
    expect(result.stopResult!.reason).toContain("Budget");
  });

  test("budget: contributions under limit → not stopped", async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makeContribution({
        createdAt: new Date(Date.now() - (5 - i) * 1000).toISOString(),
      }),
    );

    const contract = makeContract({
      stopConditions: {
        budget: { maxContributions: 100 },
      },
    });

    const store = makeStore(items);
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution();

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult).toBeDefined();
    expect(result.stopResult!.stopped).toBe(false);
  });

  test("target metric reached (minimize) → stopped", async () => {
    const existing = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(0.94) },
      createdAt: "2026-01-01T00:00:00Z",
    });

    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.95 },
      },
    });

    const store = makeStore([existing]);
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution();

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult).toBeDefined();
    expect(result.stopResult!.stopped).toBe(true);
    expect(result.stopResult!.reason).toContain("Target metric reached");
  });

  test("target metric not reached → not stopped", async () => {
    const existing = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.2) },
      createdAt: "2026-01-01T00:00:00Z",
    });

    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.95 },
      },
    });

    const store = makeStore([existing]);
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution();

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult).toBeDefined();
    expect(result.stopResult!.stopped).toBe(false);
  });

  test("no stop conditions → no stop result", async () => {
    const contract = makeContract();
    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution();

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// max_rounds_without_improvement stop condition
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: max_rounds_without_improvement", () => {
  test("stagnation triggers stop when no metric improved in last N contributions", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      stopConditions: { maxRoundsWithoutImprovement: 3 },
    });

    // Best score was the first contribution, then 3 subsequent ones didn't improve
    const t0 = "2025-01-01T00:00:00Z";
    const t1 = "2025-01-01T00:01:00Z";
    const t2 = "2025-01-01T00:02:00Z";
    const t3 = "2025-01-01T00:03:00Z";
    const store = makeStore([
      makeContribution({ mode: "evaluation", scores: { val_bpb: score(0.9) }, createdAt: t0 }),
      makeContribution({ mode: "evaluation", scores: { val_bpb: score(0.95) }, createdAt: t1 }),
      makeContribution({ mode: "evaluation", scores: { val_bpb: score(0.92) }, createdAt: t2 }),
      makeContribution({ mode: "evaluation", scores: { val_bpb: score(0.94) }, createdAt: t3 }),
    ]);

    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(0.93) },
      createdAt: "2025-01-01T00:04:00Z",
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult?.stopped).toBe(true);
    expect(result.stopResult?.reason).toContain("No metric improved");
  });

  test("improvement resets the counter — no stop when best score is recent", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      stopConditions: { maxRoundsWithoutImprovement: 3 },
    });

    // Best score is the most recent contribution
    const t0 = "2025-01-01T00:00:00Z";
    const t1 = "2025-01-01T00:01:00Z";
    const t2 = "2025-01-01T00:02:00Z";
    const store = makeStore([
      makeContribution({ mode: "evaluation", scores: { val_bpb: score(1.0) }, createdAt: t0 }),
      makeContribution({ mode: "evaluation", scores: { val_bpb: score(0.95) }, createdAt: t1 }),
      makeContribution({ mode: "evaluation", scores: { val_bpb: score(0.85) }, createdAt: t2 }),
    ]);

    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(0.92) },
      createdAt: "2025-01-01T00:03:00Z",
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult?.stopped).toBe(false);
  });

  test("respects direction — maximize metric uses correct best", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { accuracy: { direction: "maximize" } },
      stopConditions: { maxRoundsWithoutImprovement: 2 },
    });

    // Best maximize score (0.95) was the first contribution, then 2 non-improvements
    const t0 = "2025-01-01T00:00:00Z";
    const t1 = "2025-01-01T00:01:00Z";
    const t2 = "2025-01-01T00:02:00Z";
    const store = makeStore([
      makeContribution({
        mode: "evaluation",
        scores: { accuracy: score(0.95, "maximize") },
        createdAt: t0,
      }),
      makeContribution({
        mode: "evaluation",
        scores: { accuracy: score(0.8, "maximize") },
        createdAt: t1,
      }),
      makeContribution({
        mode: "evaluation",
        scores: { accuracy: score(0.85, "maximize") },
        createdAt: t2,
      }),
    ]);

    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { accuracy: score(0.82, "maximize") },
      createdAt: "2025-01-01T00:03:00Z",
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult?.stopped).toBe(true);
  });

  test("single contribution — not enough rounds to trigger stop", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      stopConditions: { maxRoundsWithoutImprovement: 3 },
    });

    const store = makeStore([
      makeContribution({
        mode: "evaluation",
        scores: { val_bpb: score(1.0) },
        createdAt: "2025-01-01T00:00:00Z",
      }),
    ]);

    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(0.95) },
      createdAt: "2025-01-01T00:01:00Z",
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult?.stopped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strict mode: violations throw for all types (not just role-kind)
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: strict mode throws for all violation types", () => {
  test("missing score → throws PolicyViolationError in strict mode", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: {}, // Missing val_bpb
    });

    await expect(enforcer.enforce(contribution, true)).rejects.toThrow(PolicyViolationError);
  });

  test("missing required relation → throws PolicyViolationError in strict mode", async () => {
    const contract = makeContract({
      agentConstraints: {
        requiredRelations: { review: ["reviews"] },
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "review",
      mode: "evaluation",
      relations: [], // Missing required reviews relation
    });

    await expect(enforcer.enforce(contribution, true)).rejects.toThrow(PolicyViolationError);
  });

  test("missing required artifact → throws PolicyViolationError in strict mode", async () => {
    const contract = makeContract({
      agentConstraints: {
        requiredArtifacts: { work: ["diff.patch"] },
      },
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      artifacts: {}, // Missing required diff.patch artifact
    });

    await expect(enforcer.enforce(contribution, true)).rejects.toThrow(PolicyViolationError);
  });
});

// ---------------------------------------------------------------------------
// Empty store edge cases
// ---------------------------------------------------------------------------

describe("PolicyEnforcer: edge cases", () => {
  test("empty store with metric_improves gate + score → passes", async () => {
    const contract = makeContract({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
    });

    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({
      kind: "work",
      mode: "evaluation",
      scores: { val_bpb: score(1.08) },
    });

    const result = await enforcer.enforce(contribution, false);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("no contract enforcement → always passes", async () => {
    const contract = makeContract();
    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "work" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.passed).toBe(true);
  });

  test("ask_user kind passes with no special requirements", async () => {
    const contract = makeContract();
    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "ask_user" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.passed).toBe(true);
  });

  test("response kind passes with no special requirements", async () => {
    const contract = makeContract();
    const store = makeStore();
    const enforcer = new PolicyEnforcer(contract, store);
    const contribution = makeContribution({ kind: "response" });

    const result = await enforcer.enforce(contribution, false);
    expect(result.passed).toBe(true);
  });
});
