/**
 * Multi-agent collaboration scenario tests.
 *
 * Validates:
 *   1. Implement + Review convergence — DAG chain, review scores
 *   2. Parallel claim deduplication — conflict, alternative, expiry re-claim
 *   3. Cross-agent adoption — frontier ordering, DAG lineage, reproduction
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { evaluateStopConditions } from "../../src/core/lifecycle.js";
import { verifyCid } from "../../src/core/manifest.js";
import {
  ClaimStatus,
  ContributionKind,
  ContributionMode,
  RelationType,
} from "../../src/core/models.js";
import {
  cleanupGrove,
  contract,
  type GroveContext,
  resetTimestamps,
  runScenario1,
  runScenario2,
  runScenario3,
  type Scenario1Result,
  type Scenario2Result,
  type Scenario3Result,
  setupGrove,
} from "./scenario.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let ctx: GroveContext;
let s1: Scenario1Result;
let s2: Scenario2Result;
let s3: Scenario3Result;

beforeAll(async () => {
  resetTimestamps();
  ctx = setupGrove();
  s1 = await runScenario1(ctx);
  s2 = await runScenario2(ctx);
  s3 = await runScenario3(ctx);
});

afterAll(() => {
  cleanupGrove(ctx);
});

// ---------------------------------------------------------------------------
// Scenario 1: Implement + Review convergence
// ---------------------------------------------------------------------------

describe("scenario 1: implement + review convergence", () => {
  test("all contributions have valid CIDs", () => {
    for (const c of [s1.initialWork, s1.firstReview, s1.improvedWork, s1.finalReview]) {
      expect(c.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
      expect(verifyCid(c)).toBe(true);
    }
  });

  test("initial work is evaluation mode with throughput score", () => {
    expect(s1.initialWork.kind).toBe(ContributionKind.Work);
    expect(s1.initialWork.mode).toBe(ContributionMode.Evaluation);
    expect(s1.initialWork.scores?.throughput?.value).toBe(1200);
  });

  test("first review targets initial work with reviews relation", () => {
    expect(s1.firstReview.kind).toBe(ContributionKind.Review);
    expect(s1.firstReview.relations).toHaveLength(1);
    expect(s1.firstReview.relations[0].targetCid).toBe(s1.initialWork.cid);
    expect(s1.firstReview.relations[0].relationType).toBe(RelationType.Reviews);
    expect(s1.firstReview.relations[0].metadata?.score).toBe(0.5);
  });

  test("improved work derives_from initial work", () => {
    expect(s1.improvedWork.kind).toBe(ContributionKind.Work);
    expect(s1.improvedWork.relations).toHaveLength(1);
    expect(s1.improvedWork.relations[0].targetCid).toBe(s1.initialWork.cid);
    expect(s1.improvedWork.relations[0].relationType).toBe(RelationType.DerivesFrom);
  });

  test("improved work has better throughput", () => {
    const initial = s1.initialWork.scores?.throughput?.value ?? 0;
    const improved = s1.improvedWork.scores?.throughput?.value ?? 0;
    expect(improved).toBeGreaterThan(initial);
  });

  test("final review targets improved work with higher score", () => {
    expect(s1.finalReview.relations[0].targetCid).toBe(s1.improvedWork.cid);
    expect(s1.finalReview.relations[0].relationType).toBe(RelationType.Reviews);
    const firstScore = s1.firstReview.relations[0].metadata?.score as number;
    const finalScore = s1.finalReview.relations[0].metadata?.score as number;
    expect(finalScore).toBeGreaterThan(firstScore);
  });

  test("DAG shows work → review → work → review chain via store", async () => {
    // Initial work should have children: review + improved work
    const childrenOfInitial = await ctx.contributionStore.children(s1.initialWork.cid);
    const childCids = childrenOfInitial.map((c) => c.cid);
    expect(childCids).toContain(s1.firstReview.cid);
    expect(childCids).toContain(s1.improvedWork.cid);

    // Improved work should have child: final review
    const childrenOfImproved = await ctx.contributionStore.children(s1.improvedWork.cid);
    expect(childrenOfImproved.map((c) => c.cid)).toContain(s1.finalReview.cid);
  });

  test("ancestors() traces lineage correctly", async () => {
    const ancestors = await ctx.contributionStore.ancestors(s1.improvedWork.cid);
    expect(ancestors.map((c) => c.cid)).toContain(s1.initialWork.cid);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Parallel claim deduplication + expiry re-claim
// ---------------------------------------------------------------------------

describe("scenario 2: claim deduplication", () => {
  test("Agent A successfully claims optimize-parser", () => {
    expect(s2.agentAClaim.status).toBe(ClaimStatus.Active);
    expect(s2.agentAClaim.targetRef).toBe("optimize-parser");
    expect(s2.agentAClaim.agent.agentId).toBe("agent-implementer");
  });

  test("Agent C gets conflict error when claiming same target", () => {
    expect(s2.agentCConflictError).toContain("optimize-parser");
    expect(s2.agentCConflictError).toContain("agent-implementer");
  });

  test("Agent C picks alternative work successfully", () => {
    expect(s2.agentCAlternativeClaim.status).toBe(ClaimStatus.Active);
    expect(s2.agentCAlternativeClaim.targetRef).toBe("optimize-lexer");
    expect(s2.agentCAlternativeClaim.agent.agentId).toBe("agent-reproducer");
  });

  test("no duplicate work — claims are on different targets", () => {
    expect(s2.agentAClaim.targetRef).not.toBe(s2.agentCAlternativeClaim.targetRef);
  });

  test("Agent C re-claims expired target successfully", () => {
    expect(s2.agentCReclaimAfterExpiry.status).toBe(ClaimStatus.Active);
    expect(s2.agentCReclaimAfterExpiry.targetRef).toBe("optimize-cache");
    expect(s2.agentCReclaimAfterExpiry.agent.agentId).toBe("agent-reproducer");
  });

  test("expired claim is no longer active", async () => {
    const expiredClaim = await ctx.claimStore.getClaim("claim-cache-expired");
    expect(expiredClaim).toBeDefined();
    expect(expiredClaim?.status).toBe(ClaimStatus.Expired);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Cross-agent adoption
// ---------------------------------------------------------------------------

describe("scenario 3: cross-agent adoption", () => {
  test("technique X and Y are independent work contributions", () => {
    expect(s3.techniqueX.kind).toBe(ContributionKind.Work);
    expect(s3.techniqueY.kind).toBe(ContributionKind.Work);
    expect(s3.techniqueX.relations).toHaveLength(0);
    expect(s3.techniqueY.relations).toHaveLength(0);
  });

  test("technique Y has better throughput than X", () => {
    const xThroughput = s3.techniqueX.scores?.throughput?.value ?? 0;
    const yThroughput = s3.techniqueY.scores?.throughput?.value ?? 0;
    expect(yThroughput).toBeGreaterThan(xThroughput);
  });

  test("synthesis adopts Y and derives_from X", () => {
    expect(s3.synthesis.kind).toBe(ContributionKind.Adoption);
    expect(s3.synthesis.relations).toHaveLength(2);
    const derivesFrom = s3.synthesis.relations.find(
      (r) => r.relationType === RelationType.DerivesFrom,
    );
    const adopts = s3.synthesis.relations.find((r) => r.relationType === RelationType.Adopts);
    expect(derivesFrom).toBeDefined();
    expect(adopts).toBeDefined();
    expect(derivesFrom?.targetCid).toBe(s3.techniqueX.cid);
    expect(adopts?.targetCid).toBe(s3.techniqueY.cid);
  });

  test("synthesis has the best throughput", () => {
    const synthesisThroughput = s3.synthesis.scores?.throughput?.value ?? 0;
    const xThroughput = s3.techniqueX.scores?.throughput?.value ?? 0;
    const yThroughput = s3.techniqueY.scores?.throughput?.value ?? 0;
    expect(synthesisThroughput).toBeGreaterThan(xThroughput);
    expect(synthesisThroughput).toBeGreaterThan(yThroughput);
  });

  test("reproduction confirms the synthesis", () => {
    expect(s3.reproduction.kind).toBe(ContributionKind.Reproduction);
    expect(s3.reproduction.relations).toHaveLength(1);
    expect(s3.reproduction.relations[0].targetCid).toBe(s3.synthesis.cid);
    expect(s3.reproduction.relations[0].relationType).toBe(RelationType.Reproduces);
    expect(s3.reproduction.relations[0].metadata?.result).toBe("confirmed");
  });

  test("frontier shows synthesis as best by throughput", async () => {
    const frontier = await ctx.frontier.compute({ metric: "throughput" });
    const throughputEntries = frontier.byMetric.throughput;
    expect(throughputEntries).toBeDefined();
    // Best throughput should be the synthesis (9200) or reproduction (9150)
    expect(throughputEntries?.[0].value).toBe(9200);
    expect(throughputEntries?.[0].cid).toBe(s3.synthesis.cid);
  });

  test("frontier shows synthesis as best by latency", async () => {
    const frontier = await ctx.frontier.compute({ metric: "latency_p99" });
    const latencyEntries = frontier.byMetric.latency_p99;
    expect(latencyEntries).toBeDefined();
    // Best latency (minimize) should be synthesis (18ms)
    expect(latencyEntries?.[0].value).toBe(18);
    expect(latencyEntries?.[0].cid).toBe(s3.synthesis.cid);
  });

  test("adoption frontier shows technique Y adopted most", async () => {
    const frontier = await ctx.frontier.compute();
    // techniqueY has 1 adopts relation (from synthesis)
    // techniqueX has 1 derives_from relation (from synthesis)
    const adoptionCids = frontier.byAdoption.map((e) => e.cid);
    expect(adoptionCids).toContain(s3.techniqueY.cid);
    expect(adoptionCids).toContain(s3.techniqueX.cid);
  });

  test("reproduction frontier shows synthesis reproduced", async () => {
    const frontier = await ctx.frontier.compute();
    const reprodCids = frontier.byReproduction.map((e) => e.cid);
    expect(reprodCids).toContain(s3.synthesis.cid);
  });

  test("DAG lineage: synthesis → techniqueX, synthesis → techniqueY", async () => {
    const ancestors = await ctx.contributionStore.ancestors(s3.synthesis.cid);
    const ancestorCids = ancestors.map((c) => c.cid);
    expect(ancestorCids).toContain(s3.techniqueX.cid);
    expect(ancestorCids).toContain(s3.techniqueY.cid);
  });

  test("children of techniqueY include synthesis (via adopts)", async () => {
    const children = await ctx.contributionStore.children(s3.techniqueY.cid);
    expect(children.map((c) => c.cid)).toContain(s3.synthesis.cid);
  });
});

// ---------------------------------------------------------------------------
// Cross-scenario: stop conditions
// ---------------------------------------------------------------------------

describe("stop conditions", () => {
  test("grove is not stopped (target throughput 10000 not reached, best is 9200)", async () => {
    const stopResult = await evaluateStopConditions(contract, ctx.contributionStore);
    const targetMetric = stopResult.conditions.target_metric;
    expect(targetMetric).toBeDefined();
    expect(targetMetric?.met).toBe(false);
  });

  test("budget not exhausted (contributions < 20)", async () => {
    const stopResult = await evaluateStopConditions(contract, ctx.contributionStore);
    const budget = stopResult.conditions.budget;
    expect(budget).toBeDefined();
    expect(budget?.met).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-scenario: frontier reflects all contributions
// ---------------------------------------------------------------------------

describe("unified frontier", () => {
  test("frontier recency includes contributions from all scenarios", async () => {
    const frontier = await ctx.frontier.compute();
    // Should have contributions from both scenario 1 and scenario 3
    const allCids = frontier.byRecency.map((e) => e.cid);
    expect(allCids).toContain(s1.initialWork.cid);
    expect(allCids).toContain(s3.synthesis.cid);
  });

  test("frontier search finds contributions across scenarios", async () => {
    const workerResults = await ctx.contributionStore.search("worker pool");
    expect(workerResults.length).toBeGreaterThanOrEqual(1);

    const simdResults = await ctx.contributionStore.search("SIMD");
    expect(simdResults.length).toBeGreaterThanOrEqual(1);
  });
});
