/**
 * Deep structural assertions for the mini autoresearch scenario.
 *
 * Validates: CID determinism, immutability, relation graph, frontier ordering,
 * claims, lifecycle states, stop conditions, and idempotency.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GroveContract } from "../../src/core/contract.js";
import {
  deriveLifecycleState,
  deriveLifecycleStates,
  evaluateStopConditions,
  LifecycleState,
} from "../../src/core/lifecycle.js";
import { verifyCid } from "../../src/core/manifest.js";
import { ClaimStatus, ContributionKind, RelationType } from "../../src/core/models.js";
import {
  agentA,
  agentA_initialWork,
  agentB,
  agentC,
  cleanupGrove,
  contract,
  type GroveContext,
  resetTimestamps,
  runScenario,
  type ScenarioResult,
  setupGrove,
} from "./scenario.js";

// ---------------------------------------------------------------------------
// Shared state for the entire describe block
// ---------------------------------------------------------------------------

let ctx: GroveContext;
let result: ScenarioResult;

beforeAll(async () => {
  resetTimestamps();
  ctx = setupGrove();
  result = await runScenario(ctx);
});

afterAll(() => {
  cleanupGrove(ctx);
});

// ---------------------------------------------------------------------------
// 1. CID determinism
// ---------------------------------------------------------------------------

describe("CID determinism", () => {
  test("same input produces same CID across calls", () => {
    resetTimestamps();
    const first = agentA_initialWork();
    resetTimestamps();
    const second = agentA_initialWork();
    expect(first.cid).toBe(second.cid);
  });

  test("CID matches blake3 format", () => {
    for (const c of result.allContributions) {
      expect(c.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    }
  });

  test("all CIDs are unique", () => {
    const cids = result.allContributions.map((c) => c.cid);
    expect(new Set(cids).size).toBe(cids.length);
  });

  test("verifyCid returns true for all contributions", () => {
    for (const c of result.allContributions) {
      expect(verifyCid(c)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Contribution immutability
// ---------------------------------------------------------------------------

describe("contribution immutability", () => {
  test("contributions are frozen", () => {
    for (const c of result.allContributions) {
      expect(Object.isFrozen(c)).toBe(true);
    }
  });

  test("nested objects are frozen", () => {
    expect(Object.isFrozen(result.workA.agent)).toBe(true);
    expect(Object.isFrozen(result.workA.scores)).toBe(true);
    expect(Object.isFrozen(result.workA.tags)).toBe(true);
    expect(Object.isFrozen(result.workA.artifacts)).toBe(true);
  });

  test("mutation throws", () => {
    expect(() => {
      (result.workA as { summary: string }).summary = "hacked";
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Relation graph
// ---------------------------------------------------------------------------

describe("relation graph", () => {
  test("Agent B's work derives_from Agent A", () => {
    expect(result.workB.relations).toHaveLength(1);
    expect(result.workB.relations[0].targetCid).toBe(result.workA.cid);
    expect(result.workB.relations[0].relationType).toBe(RelationType.DerivesFrom);
  });

  test("review targets B's work", () => {
    expect(result.reviewAofB.relations).toHaveLength(1);
    expect(result.reviewAofB.relations[0].targetCid).toBe(result.workB.cid);
    expect(result.reviewAofB.relations[0].relationType).toBe(RelationType.Reviews);
  });

  test("reproduction targets A's work with confirmed metadata", () => {
    expect(result.reproductionC.relations).toHaveLength(1);
    expect(result.reproductionC.relations[0].targetCid).toBe(result.workA.cid);
    expect(result.reproductionC.relations[0].relationType).toBe(RelationType.Reproduces);
    expect(result.reproductionC.relations[0].metadata?.result).toBe("confirmed");
  });

  test("adoption has both adopts and derives_from relations", () => {
    expect(result.adoptionB.relations).toHaveLength(2);
    const adopts = result.adoptionB.relations.find((r) => r.relationType === RelationType.Adopts);
    const derives = result.adoptionB.relations.find(
      (r) => r.relationType === RelationType.DerivesFrom,
    );
    expect(adopts).toBeDefined();
    expect(derives).toBeDefined();
    expect(adopts!.targetCid).toBe(result.workA.cid);
    expect(derives!.targetCid).toBe(result.workB.cid);
  });

  test("children() returns incoming edges", async () => {
    const childrenOfA = await ctx.contributionStore.children(result.workA.cid);
    const childCids = childrenOfA.map((c) => c.cid);
    // B derives from A, C reproduces A, adoption adopts A
    expect(childCids).toContain(result.workB.cid);
    expect(childCids).toContain(result.reproductionC.cid);
    expect(childCids).toContain(result.adoptionB.cid);
  });

  test("ancestors() returns outgoing edge targets", async () => {
    const ancestorsOfAdoption = await ctx.contributionStore.ancestors(result.adoptionB.cid);
    const ancestorCids = ancestorsOfAdoption.map((c) => c.cid);
    expect(ancestorCids).toContain(result.workA.cid);
    expect(ancestorCids).toContain(result.workB.cid);
  });

  test("relationsOf() returns typed relations", async () => {
    const reviews = await ctx.contributionStore.relationsOf(
      result.reviewAofB.cid,
      RelationType.Reviews,
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].targetCid).toBe(result.workB.cid);
  });

  test("relatedTo() returns contributions pointing at target", async () => {
    const reviewsOfB = await ctx.contributionStore.relatedTo(
      result.workB.cid,
      RelationType.Reviews,
    );
    expect(reviewsOfB).toHaveLength(1);
    expect(reviewsOfB[0].cid).toBe(result.reviewAofB.cid);
  });
});

// ---------------------------------------------------------------------------
// 4. Frontier by metric
// ---------------------------------------------------------------------------

describe("frontier by metric", () => {
  test("val_bpb frontier orders by minimize (lowest first)", async () => {
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbEntries = frontier.byMetric.val_bpb;
    expect(bpbEntries).toBeDefined();
    expect(bpbEntries!.length).toBeGreaterThanOrEqual(1);
    // Best val_bpb is 0.93 (adoption), then 0.98 (workB), then 1.04 (reproduction), then 1.05 (workA)
    expect(bpbEntries![0].value).toBe(0.93);
    expect(bpbEntries![0].cid).toBe(result.adoptionB.cid);
  });

  test("peak_vram_gb frontier orders by minimize", async () => {
    const frontier = await ctx.frontier.compute({ metric: "peak_vram_gb" });
    const vramEntries = frontier.byMetric.peak_vram_gb;
    expect(vramEntries).toBeDefined();
    // Best VRAM is 42.3 (workA)
    expect(vramEntries![0].value).toBe(42.3);
    expect(vramEntries![0].cid).toBe(result.workA.cid);
  });

  test("frontier respects agent filter", async () => {
    const frontier = await ctx.frontier.compute({ metric: "val_bpb", agentId: "agent-b" });
    const bpbEntries = frontier.byMetric.val_bpb ?? [];
    for (const entry of bpbEntries) {
      expect(entry.contribution.agent.agentId).toBe("agent-b");
    }
  });

  test("frontier respects tag filter", async () => {
    const frontier = await ctx.frontier.compute({ tags: ["baseline"] });
    const recency = frontier.byRecency;
    for (const entry of recency) {
      expect(entry.contribution.tags).toContain("baseline");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Frontier by adoption
// ---------------------------------------------------------------------------

describe("frontier by adoption", () => {
  test("adoption counts reflect derives_from and adopts relations", async () => {
    const frontier = await ctx.frontier.compute();
    // byAdoption counts incoming derives_from + adopts edges (NOT reproduces)
    // workA: derives_from by B + adopts by adoptionB = 2
    // workB: derives_from by adoptionB = 1
    expect(frontier.byAdoption.length).toBeGreaterThanOrEqual(2);
    expect(frontier.byAdoption[0].cid).toBe(result.workA.cid);
    expect(frontier.byAdoption[0].value).toBe(2);
    expect(frontier.byAdoption[1].cid).toBe(result.workB.cid);
    expect(frontier.byAdoption[1].value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Frontier by reproduction
// ---------------------------------------------------------------------------

describe("frontier by reproduction", () => {
  test("reproduced contributions appear in reproduction frontier", async () => {
    const frontier = await ctx.frontier.compute();
    // workA was reproduced by agentC with "confirmed" result
    const reprodCids = frontier.byReproduction.map((e) => e.cid);
    expect(reprodCids).toContain(result.workA.cid);
  });
});

// ---------------------------------------------------------------------------
// 7. Claims
// ---------------------------------------------------------------------------

describe("claims", () => {
  test("create and retrieve a claim", async () => {
    const now = new Date();
    const lease = new Date(now.getTime() + 300_000);
    const claim = await ctx.claimStore.createClaim({
      claimId: "claim-optimize-parser",
      targetRef: "optimize-parser",
      agent: agentA,
      status: ClaimStatus.Active,
      intentSummary: "Optimize the parser module",
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: lease.toISOString(),
    });

    expect(claim.status).toBe(ClaimStatus.Active);
    const retrieved = await ctx.claimStore.getClaim("claim-optimize-parser");
    expect(retrieved).toBeDefined();
    expect(retrieved!.targetRef).toBe("optimize-parser");
  });

  test("active claims are listed", async () => {
    const active = await ctx.claimStore.activeClaims();
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(active.some((c) => c.claimId === "claim-optimize-parser")).toBe(true);
  });

  test("complete a claim transitions status", async () => {
    const completed = await ctx.claimStore.complete("claim-optimize-parser");
    expect(completed.status).toBe(ClaimStatus.Completed);

    const active = await ctx.claimStore.activeClaims();
    expect(active.some((c) => c.claimId === "claim-optimize-parser")).toBe(false);
  });

  test("release a claim transitions status", async () => {
    const now = new Date();
    const lease = new Date(now.getTime() + 300_000);
    await ctx.claimStore.createClaim({
      claimId: "claim-to-release",
      targetRef: "some-work",
      agent: agentB,
      status: ClaimStatus.Active,
      intentSummary: "Will be released",
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: lease.toISOString(),
    });

    const released = await ctx.claimStore.release("claim-to-release");
    expect(released.status).toBe(ClaimStatus.Released);
  });

  test("expired claims are detected", async () => {
    const past = new Date(Date.now() - 600_000);
    const expired = new Date(Date.now() - 300_000);
    await ctx.claimStore.createClaim({
      claimId: "claim-expired",
      targetRef: "expired-work",
      agent: agentC,
      status: ClaimStatus.Active,
      intentSummary: "This claim has expired",
      createdAt: past.toISOString(),
      heartbeatAt: past.toISOString(),
      leaseExpiresAt: expired.toISOString(),
    });

    const expiredClaims = await ctx.claimStore.expireStale();
    expect(expiredClaims.some((e) => e.claim.claimId === "claim-expired")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Lifecycle states
// ---------------------------------------------------------------------------

describe("lifecycle states", () => {
  test("workA is adopted (adopts relation takes precedence over reproduced)", async () => {
    // workA has both: reproduced (confirmed by C) and adopted (by B's adoption)
    // Lifecycle precedence: superseded > challenged > adopted > reproduced > under_review > published
    // adopted > reproduced, so adopted wins
    const state = await deriveLifecycleState(result.workA.cid, ctx.contributionStore);
    expect(state).toBe(LifecycleState.Adopted);
  });

  test("reviewed work is under_review", async () => {
    const state = await deriveLifecycleState(result.workB.cid, ctx.contributionStore);
    expect(state).toBe(LifecycleState.UnderReview);
  });

  test("batch lifecycle states are consistent", async () => {
    const cids = result.allContributions.map((c) => c.cid);
    const states = await deriveLifecycleStates(cids, ctx.contributionStore);
    expect(states.size).toBe(cids.length);

    // Each state should match individual derivation
    for (const cid of cids) {
      const individual = await deriveLifecycleState(cid, ctx.contributionStore);
      expect(states.get(cid)).toBe(individual);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Stop conditions
// ---------------------------------------------------------------------------

describe("stop conditions", () => {
  test("target metric not yet met (best is 0.93, target is 0.85)", async () => {
    const stopResult = await evaluateStopConditions(contract, ctx.contributionStore);
    const targetMetric = stopResult.conditions.target_metric;
    expect(targetMetric).toBeDefined();
    expect(targetMetric!.met).toBe(false);
  });

  test("budget not exhausted (5 contributions < 50 max)", async () => {
    const stopResult = await evaluateStopConditions(contract, ctx.contributionStore);
    const budget = stopResult.conditions.budget;
    expect(budget).toBeDefined();
    expect(budget!.met).toBe(false);
  });

  test("stop conditions fire when target is reached", async () => {
    // Create a contract with a target that our best result (0.93) already beats
    const easyContract: GroveContract = {
      ...contract,
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.95 },
      },
    };
    const stopResult = await evaluateStopConditions(easyContract, ctx.contributionStore);
    expect(stopResult.stopped).toBe(true);
    expect(stopResult.conditions.target_metric?.met).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  test("putting the same contribution twice is a no-op", async () => {
    const countBefore = await ctx.contributionStore.count();
    await ctx.contributionStore.put(result.workA);
    const countAfter = await ctx.contributionStore.count();
    expect(countAfter).toBe(countBefore);
  });

  test("putMany with duplicates does not duplicate", async () => {
    const countBefore = await ctx.contributionStore.count();
    await ctx.contributionStore.putMany(result.allContributions);
    const countAfter = await ctx.contributionStore.count();
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// 11. Store queries
// ---------------------------------------------------------------------------

describe("store queries", () => {
  test("list by kind filters correctly", async () => {
    const reviews = await ctx.contributionStore.list({ kind: ContributionKind.Review });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].cid).toBe(result.reviewAofB.cid);
  });

  test("list by agent filters correctly", async () => {
    const byAgentB = await ctx.contributionStore.list({ agentId: "agent-b" });
    expect(byAgentB).toHaveLength(2); // workB + adoptionB
    for (const c of byAgentB) {
      expect(c.agent.agentId).toBe("agent-b");
    }
  });

  test("list by tags filters with AND conjunction", async () => {
    const muon = await ctx.contributionStore.list({ tags: ["muonadamw"] });
    expect(muon.length).toBeGreaterThanOrEqual(2); // workB + adoptionB
    const synthesis = await ctx.contributionStore.list({ tags: ["muonadamw", "synthesis"] });
    expect(synthesis).toHaveLength(1); // only adoptionB has both tags
  });

  test("search finds by summary text", async () => {
    const results = await ctx.contributionStore.search("MuonAdamW");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((c) => c.cid === result.workB.cid)).toBe(true);
  });

  test("findExisting detects duplicate work", async () => {
    const existing = await ctx.contributionStore.findExisting(
      "agent-a",
      result.workB.cid,
      ContributionKind.Review,
      RelationType.Reviews,
    );
    expect(existing).toHaveLength(1);
    expect(existing[0].cid).toBe(result.reviewAofB.cid);
  });

  test("count returns correct total", async () => {
    const total = await ctx.contributionStore.count();
    expect(total).toBe(5);
  });

  test("list with limit and offset paginates", async () => {
    const page1 = await ctx.contributionStore.list({ limit: 2 });
    const page2 = await ctx.contributionStore.list({ limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    const allCids = [...page1, ...page2].map((c) => c.cid);
    expect(new Set(allCids).size).toBe(4); // no overlap
  });

  test("get returns undefined for nonexistent CID", async () => {
    const missing = await ctx.contributionStore.get(
      "blake3:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(missing).toBeUndefined();
  });
});
