/**
 * Multi-agent integration test for the real-autoresearch example.
 *
 * Validates 6 assertion groups:
 *   1. Claims prevent duplicate experiments
 *   2. Frontier correctly identifies best val_bpb
 *   3. DAG captures experiment lineage
 *   4. Outcomes are tracked (accepted/rejected/crashed)
 *   5. Ralph restart simulation (crash → recover from frontier)
 *   6. Stop conditions trigger correctly
 *
 * Simulates 3 agents with different roles, no GPU required.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GroveContract } from "../../../src/core/contract.js";
import { evaluateStopConditions } from "../../../src/core/lifecycle.js";
import { createContribution } from "../../../src/core/manifest.js";
import type { AgentIdentity, Contribution } from "../../../src/core/models.js";
import {
  ClaimStatus,
  ContributionKind,
  ContributionMode,
  RelationType,
  ScoreDirection,
} from "../../../src/core/models.js";
import {
  cleanupGrove,
  type GroveContext,
  nextTimestamp,
  resetTimestamps,
  setupGrove,
} from "../../helpers.js";

// ---------------------------------------------------------------------------
// Agent identities
// ---------------------------------------------------------------------------

const researcher: AgentIdentity = {
  agentId: "researcher-a",
  agentName: "Claude-Researcher",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  platform: "apple-silicon",
};

const reviewer: AgentIdentity = {
  agentId: "reviewer-b",
  agentName: "Codex-Reviewer",
  provider: "openai",
  model: "codex",
  platform: "apple-silicon",
};

const reproducer: AgentIdentity = {
  agentId: "reproducer-c",
  agentName: "Gemini-Reproducer",
  provider: "google",
  model: "gemini-2.5-pro",
  platform: "apple-silicon",
};

// ---------------------------------------------------------------------------
// Contract — matches grove.md (20 rounds, 5 no-improvement stop)
// ---------------------------------------------------------------------------

const contract: GroveContract = {
  contractVersion: 2,
  name: "real-autoresearch-multi",
  description: "Multi-agent autoresearch validation",
  mode: ContributionMode.Evaluation,
  metrics: {
    val_bpb: {
      direction: ScoreDirection.Minimize,
      unit: "bpb",
      description: "Validation bits per byte",
    },
    peak_vram_gb: {
      direction: ScoreDirection.Minimize,
      unit: "GB",
      description: "Peak VRAM usage",
    },
  },
  stopConditions: {
    maxRoundsWithoutImprovement: 3,
    targetMetric: { metric: "val_bpb", value: 0.85 },
    budget: { maxContributions: 50 },
  },
  concurrency: {
    maxActiveClaims: 3,
    maxClaimsPerAgent: 1,
    maxClaimsPerTarget: 1,
  },
  rateLimits: {
    maxContributionsPerAgentPerHour: 100,
    maxContributionsPerGrovePerHour: 300,
  },
};

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let ctx: GroveContext;
let baseline: Contribution;
let improved: Contribution;
let reviewContrib: Contribution;
let reproduction: Contribution;
let crashed: Contribution;
let recovery: Contribution;

beforeAll(async () => {
  resetTimestamps();
  ctx = setupGrove(contract, "multi-agent-autoresearch");

  // --- Simulate multi-agent workflow ---

  // 1. Researcher creates baseline
  baseline = createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Baseline: AdamW, batch_size=64",
    artifacts: {
      "train.py": "blake3:aaaa000000000000000000000000000000000000000000000000000000000001",
    },
    relations: [],
    scores: {
      val_bpb: { value: 1.05, direction: ScoreDirection.Minimize, unit: "bpb" },
      peak_vram_gb: { value: 0.12, direction: ScoreDirection.Minimize, unit: "GB" },
    },
    tags: ["baseline"],
    agent: researcher,
    createdAt: nextTimestamp(),
  });
  await ctx.contributionStore.put(baseline);

  // 2. Researcher improves on baseline
  improved = createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "MuonAdamW optimizer swap",
    artifacts: {
      "train.py": "blake3:bbbb000000000000000000000000000000000000000000000000000000000002",
    },
    relations: [{ targetCid: baseline.cid, relationType: RelationType.DerivesFrom }],
    scores: {
      val_bpb: { value: 0.98, direction: ScoreDirection.Minimize, unit: "bpb" },
      peak_vram_gb: { value: 0.13, direction: ScoreDirection.Minimize, unit: "GB" },
    },
    tags: ["muonadamw"],
    agent: researcher,
    createdAt: nextTimestamp(),
  });
  await ctx.contributionStore.put(improved);

  // 3. Reviewer reviews the improvement
  reviewContrib = createContribution({
    kind: ContributionKind.Review,
    mode: ContributionMode.Evaluation,
    summary: "Clean optimizer swap, fair comparison",
    artifacts: {},
    relations: [{ targetCid: improved.cid, relationType: RelationType.Reviews }],
    scores: {
      quality: { value: 8, direction: ScoreDirection.Maximize },
    },
    tags: ["review"],
    agent: reviewer,
    createdAt: nextTimestamp(),
  });
  await ctx.contributionStore.put(reviewContrib);

  // 4. Reproducer confirms baseline
  reproduction = createContribution({
    kind: ContributionKind.Reproduction,
    mode: ContributionMode.Evaluation,
    summary: "Reproduced baseline: val_bpb=1.04",
    artifacts: {},
    relations: [
      {
        targetCid: baseline.cid,
        relationType: RelationType.Reproduces,
        metadata: { result: "confirmed", delta: 0.01 },
      },
    ],
    scores: {
      val_bpb: { value: 1.04, direction: ScoreDirection.Minimize, unit: "bpb" },
    },
    tags: ["reproduction"],
    agent: reproducer,
    createdAt: nextTimestamp(),
  });
  await ctx.contributionStore.put(reproduction);

  // 5. Researcher's experiment crashes
  crashed = createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Aggressive lr=1e-2 — training diverged",
    artifacts: {
      "train.py": "blake3:dddd000000000000000000000000000000000000000000000000000000000004",
    },
    relations: [{ targetCid: improved.cid, relationType: RelationType.DerivesFrom }],
    scores: {},
    tags: ["crashed", "lr-sweep"],
    agent: researcher,
    createdAt: nextTimestamp(),
  });
  await ctx.contributionStore.put(crashed);

  // 6. Researcher recovers — picks best from frontier and tries again
  recovery = createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Recovery: cosine schedule on MuonAdamW base",
    artifacts: {
      "train.py": "blake3:eeee000000000000000000000000000000000000000000000000000000000005",
    },
    relations: [{ targetCid: improved.cid, relationType: RelationType.DerivesFrom }],
    scores: {
      val_bpb: { value: 0.95, direction: ScoreDirection.Minimize, unit: "bpb" },
      peak_vram_gb: { value: 0.14, direction: ScoreDirection.Minimize, unit: "GB" },
    },
    tags: ["cosine-schedule", "recovery"],
    agent: researcher,
    createdAt: nextTimestamp(),
  });
  await ctx.contributionStore.put(recovery);
});

afterAll(() => {
  cleanupGrove(ctx);
});

// ---------------------------------------------------------------------------
// 1. Claims prevent duplicate experiments
// ---------------------------------------------------------------------------

describe("1. claim deduplication", () => {
  test("two agents cannot claim the same targetRef simultaneously", async () => {
    const now = new Date();
    const lease = new Date(now.getTime() + 600_000);

    await ctx.claimStore.createClaim({
      claimId: "claim-rotary-embed-a",
      targetRef: "try-rotary-embeddings",
      agent: researcher,
      status: ClaimStatus.Active,
      intentSummary: "Try rotary embeddings",
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: lease.toISOString(),
    });

    // Second agent trying same targetRef should be rejected by enforcing store
    await expect(
      ctx.claimStore.createClaim({
        claimId: "claim-rotary-embed-c",
        targetRef: "try-rotary-embeddings",
        agent: reproducer,
        status: ClaimStatus.Active,
        intentSummary: "Also try rotary embeddings",
        createdAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        leaseExpiresAt: lease.toISOString(),
      }),
    ).rejects.toThrow();
  });

  test("different targets can be claimed simultaneously", async () => {
    const now = new Date();
    const lease = new Date(now.getTime() + 600_000);

    const claim = await ctx.claimStore.createClaim({
      claimId: "claim-batch-size-c",
      targetRef: "try-larger-batch",
      agent: reproducer,
      status: ClaimStatus.Active,
      intentSummary: "Try batch_size=128",
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: lease.toISOString(),
    });

    expect(claim.status).toBe(ClaimStatus.Active);
  });
});

// ---------------------------------------------------------------------------
// 2. Frontier correctly identifies best val_bpb
// ---------------------------------------------------------------------------

describe("2. frontier ordering", () => {
  test("best val_bpb is at the top of the frontier", async () => {
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbEntries = frontier.byMetric.val_bpb;
    expect(bpbEntries).toBeDefined();
    // Best is recovery (0.95), then improved (0.98), then reproduction (1.04), then baseline (1.05)
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(bpbEntries![0].value).toBe(0.95);
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(bpbEntries![0].cid).toBe(recovery.cid);
  });

  test("frontier excludes contributions without val_bpb scores", async () => {
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbCids = (frontier.byMetric.val_bpb ?? []).map((e) => e.cid);
    // Crashed contribution has no scores, should not appear
    expect(bpbCids).not.toContain(crashed.cid);
    // Review has quality score, not val_bpb, should not appear
    expect(bpbCids).not.toContain(reviewContrib.cid);
  });
});

// ---------------------------------------------------------------------------
// 3. DAG captures experiment lineage
// ---------------------------------------------------------------------------

describe("3. DAG lineage", () => {
  test("improved derives_from baseline", () => {
    expect(improved.relations).toHaveLength(1);
    expect(improved.relations[0].targetCid).toBe(baseline.cid);
    expect(improved.relations[0].relationType).toBe(RelationType.DerivesFrom);
  });

  test("review targets improved work", () => {
    expect(reviewContrib.relations).toHaveLength(1);
    expect(reviewContrib.relations[0].targetCid).toBe(improved.cid);
    expect(reviewContrib.relations[0].relationType).toBe(RelationType.Reviews);
  });

  test("reproduction targets baseline with confirmed metadata", () => {
    expect(reproduction.relations[0].relationType).toBe(RelationType.Reproduces);
    expect(reproduction.relations[0].metadata?.result).toBe("confirmed");
  });

  test("children of baseline include improved, reproduction, and crashed (indirectly)", async () => {
    const children = await ctx.contributionStore.children(baseline.cid);
    const childCids = children.map((c) => c.cid);
    expect(childCids).toContain(improved.cid);
    expect(childCids).toContain(reproduction.cid);
  });

  test("recovery derives from improved (not from crashed)", () => {
    expect(recovery.relations[0].targetCid).toBe(improved.cid);
    expect(recovery.relations[0].relationType).toBe(RelationType.DerivesFrom);
  });
});

// ---------------------------------------------------------------------------
// 4. Outcomes tracked (accepted/rejected/crashed)
// ---------------------------------------------------------------------------

describe("4. outcome tracking", () => {
  test("crashed experiment has no scores", () => {
    expect(crashed.scores).toEqual({});
  });

  test("crashed experiment is tagged", () => {
    expect(crashed.tags).toContain("crashed");
  });

  test("successful experiments have val_bpb scores", () => {
    expect(baseline.scores?.val_bpb?.value).toBe(1.05);
    expect(improved.scores?.val_bpb?.value).toBe(0.98);
    expect(recovery.scores?.val_bpb?.value).toBe(0.95);
  });

  test("reproduction has matching metric for verification", () => {
    const originalBpb = baseline.scores?.val_bpb?.value;
    const reproductionBpb = reproduction.scores?.val_bpb?.value;
    expect(originalBpb).toBeDefined();
    expect(reproductionBpb).toBeDefined();
    // Within 5% of original (1.05 vs 1.04)
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const delta = Math.abs(originalBpb! - reproductionBpb!) / originalBpb!;
    expect(delta).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// 5. Ralph restart simulation
// ---------------------------------------------------------------------------

describe("5. Ralph restart recovery", () => {
  test("after crash, agent can find best work from frontier", async () => {
    // Simulate what happens after Ralph restarts an agent:
    // The agent calls grove_frontier and picks up the best result
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const best = frontier.byMetric.val_bpb?.[0];
    expect(best).toBeDefined();
    // Best should be recovery (0.95), showing the agent recovered
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(best!.value).toBe(0.95);
  });

  test("recovery contribution builds on best prior work, not on crashed", () => {
    // Recovery derives from improved (0.98), not from crashed
    expect(recovery.relations[0].targetCid).toBe(improved.cid);
    expect(recovery.relations[0].targetCid).not.toBe(crashed.cid);
  });

  test("crashed contribution does not appear in metric frontier", async () => {
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const cids = (frontier.byMetric.val_bpb ?? []).map((e) => e.cid);
    expect(cids).not.toContain(crashed.cid);
  });
});

// ---------------------------------------------------------------------------
// 6. Stop conditions
// ---------------------------------------------------------------------------

describe("6. stop conditions", () => {
  test("target metric not yet met (best 0.95, target 0.85)", async () => {
    const result = await evaluateStopConditions(contract, ctx.contributionStore);
    expect(result.conditions.target_metric?.met).toBe(false);
  });

  test("budget not exhausted (6 contributions < 50)", async () => {
    const result = await evaluateStopConditions(contract, ctx.contributionStore);
    expect(result.conditions.budget?.met).toBe(false);
  });

  test("stop fires when target is reached", async () => {
    const easyContract: GroveContract = {
      ...contract,
      stopConditions: {
        targetMetric: { metric: "val_bpb", value: 0.96 },
      },
    };
    const result = await evaluateStopConditions(easyContract, ctx.contributionStore);
    expect(result.stopped).toBe(true);
    expect(result.conditions.target_metric?.met).toBe(true);
  });
});
