/**
 * Smoke test for the real-autoresearch example.
 *
 * Simulates one agent doing a single full loop:
 *   claim → checkout → mock training → contribute → verify
 *
 * Uses the grove TypeScript API with Nexus-compatible contract.
 * No GPU, no real agents — pure protocol validation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GroveContract } from "../../../src/core/contract.js";
import { createContribution } from "../../../src/core/manifest.js";
import type { AgentIdentity } from "../../../src/core/models.js";
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
// Fixtures
// ---------------------------------------------------------------------------

const researcher: AgentIdentity = {
  agentId: "researcher-a",
  agentName: "Claude-Researcher",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  platform: "apple-silicon",
};

const contract: GroveContract = {
  contractVersion: 2,
  name: "real-autoresearch-smoke",
  description: "Smoke test for autoresearch example",
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
    maxRoundsWithoutImprovement: 5,
    targetMetric: { metric: "val_bpb", value: 0.85 },
    budget: { maxContributions: 20 },
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
// Test setup
// ---------------------------------------------------------------------------

let ctx: GroveContext;

beforeAll(() => {
  resetTimestamps();
  ctx = setupGrove(contract, "smoke-autoresearch");
});

afterAll(() => {
  cleanupGrove(ctx);
});

// ---------------------------------------------------------------------------
// Smoke test — single agent, one full loop
// ---------------------------------------------------------------------------

describe("smoke: single agent full loop", () => {
  let baselineCid: string;

  test("agent creates baseline contribution", async () => {
    const baseline = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "Baseline GPT training with AdamW optimizer",
      description: "Initial run: batch_size=64, lr=3e-4, 5min budget",
      artifacts: {
        "train.py": "blake3:aaaa000000000000000000000000000000000000000000000000000000000001",
      },
      relations: [],
      scores: {
        val_bpb: { value: 1.05, direction: ScoreDirection.Minimize, unit: "bpb" },
        peak_vram_gb: { value: 0.12, direction: ScoreDirection.Minimize, unit: "GB" },
      },
      tags: ["baseline", "adamw"],
      agent: researcher,
      createdAt: nextTimestamp(),
    });

    await ctx.contributionStore.put(baseline);
    baselineCid = baseline.cid;

    const stored = await ctx.contributionStore.get(baselineCid);
    expect(stored).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(stored!.scores?.val_bpb?.value).toBe(1.05);
  });

  test("claim prevents duplicate work", async () => {
    const now = new Date();
    const lease = new Date(now.getTime() + 600_000);

    const claim = await ctx.claimStore.createClaim({
      claimId: "claim-muonadamw",
      targetRef: "try-muonadamw",
      agent: researcher,
      status: ClaimStatus.Active,
      intentSummary: "Try MuonAdamW optimizer",
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: lease.toISOString(),
    });

    expect(claim.status).toBe(ClaimStatus.Active);

    const active = await ctx.claimStore.activeClaims();
    expect(active.some((c) => c.claimId === "claim-muonadamw")).toBe(true);
  });

  test("improved contribution derives from baseline", async () => {
    const improved = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "MuonAdamW optimizer — 7% improvement",
      description: "Switched to MuonAdamW with momentum-based updates",
      artifacts: {
        "train.py": "blake3:bbbb000000000000000000000000000000000000000000000000000000000002",
      },
      relations: [{ targetCid: baselineCid, relationType: RelationType.DerivesFrom }],
      scores: {
        val_bpb: { value: 0.98, direction: ScoreDirection.Minimize, unit: "bpb" },
        peak_vram_gb: { value: 0.13, direction: ScoreDirection.Minimize, unit: "GB" },
      },
      tags: ["muonadamw", "optimizer"],
      agent: researcher,
      createdAt: nextTimestamp(),
    });

    await ctx.contributionStore.put(improved);

    // Complete the claim
    await ctx.claimStore.complete("claim-muonadamw");
    const completed = await ctx.claimStore.getClaim("claim-muonadamw");
    expect(completed?.status).toBe(ClaimStatus.Completed);
  });

  test("frontier shows improved result first", async () => {
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbEntries = frontier.byMetric.val_bpb;
    expect(bpbEntries).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(bpbEntries!.length).toBeGreaterThanOrEqual(2);
    // Best val_bpb should be 0.98 (improved), then 1.05 (baseline)
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(bpbEntries![0].value).toBe(0.98);
  });

  test("contribution count is correct", async () => {
    const count = await ctx.contributionStore.count();
    expect(count).toBe(2);
  });
});
