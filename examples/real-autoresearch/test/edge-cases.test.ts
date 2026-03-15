/**
 * Edge case tests for autoresearch agent-grove interactions.
 *
 * Tests:
 *   1. Empty frontier bootstrap (first agent, no prior work)
 *   2. Contribution with outcome=crashed (no scores)
 *   3. Invalid metric values (NaN, negative, extreme)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GroveContract } from "../../../src/core/contract.js";
import { evaluateStopConditions } from "../../../src/core/lifecycle.js";
import { createContribution } from "../../../src/core/manifest.js";
import type { AgentIdentity } from "../../../src/core/models.js";
import { ContributionKind, ContributionMode, ScoreDirection } from "../../../src/core/models.js";
import {
  cleanupGrove,
  type GroveContext,
  nextTimestamp,
  resetTimestamps,
  setupGrove,
} from "../../helpers.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const agent: AgentIdentity = {
  agentId: "edge-agent",
  agentName: "Edge-Tester",
  provider: "test",
  model: "test",
  platform: "test",
};

const contract: GroveContract = {
  contractVersion: 2,
  name: "edge-cases",
  description: "Edge case testing",
  mode: ContributionMode.Evaluation,
  metrics: {
    val_bpb: {
      direction: ScoreDirection.Minimize,
      unit: "bpb",
      description: "Validation bits per byte",
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
// 1. Empty frontier bootstrap
// ---------------------------------------------------------------------------

describe("empty frontier bootstrap", () => {
  let ctx: GroveContext;

  beforeAll(() => {
    resetTimestamps();
    ctx = setupGrove(contract, "edge-bootstrap");
  });

  afterAll(() => {
    cleanupGrove(ctx);
  });

  test("frontier returns empty results when no contributions exist", async () => {
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbEntries = frontier.byMetric.val_bpb ?? [];
    expect(bpbEntries).toHaveLength(0);
    expect(frontier.byAdoption).toHaveLength(0);
    expect(frontier.byRecency).toHaveLength(0);
  });

  test("no stop conditions are met on empty grove", async () => {
    const result = await evaluateStopConditions(contract, ctx.contributionStore);
    expect(result.stopped).toBe(false);
  });

  test("first contribution bootstraps the frontier", async () => {
    const first = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "First experiment — baseline",
      artifacts: {
        "train.py": "blake3:0000000000000000000000000000000000000000000000000000000000000001",
      },
      relations: [],
      scores: {
        val_bpb: { value: 1.1, direction: ScoreDirection.Minimize, unit: "bpb" },
      },
      tags: ["baseline"],
      agent,
      createdAt: nextTimestamp(),
    });

    await ctx.contributionStore.put(first);

    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbEntries = frontier.byMetric.val_bpb ?? [];
    expect(bpbEntries).toHaveLength(1);
    expect(bpbEntries[0].value).toBe(1.1);
    expect(bpbEntries[0].cid).toBe(first.cid);
  });
});

// ---------------------------------------------------------------------------
// 2. Crashed contribution (no scores)
// ---------------------------------------------------------------------------

describe("crashed contribution", () => {
  let ctx: GroveContext;

  beforeAll(() => {
    resetTimestamps();
    ctx = setupGrove(contract, "edge-crashed");
  });

  afterAll(() => {
    cleanupGrove(ctx);
  });

  test("contribution with no scores is stored successfully", async () => {
    const crashed = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "OOM crash during training",
      artifacts: {
        "train.py": "blake3:cccc000000000000000000000000000000000000000000000000000000000001",
      },
      relations: [],
      scores: {},
      tags: ["crashed", "oom"],
      agent,
      createdAt: nextTimestamp(),
    });

    await ctx.contributionStore.put(crashed);
    const stored = await ctx.contributionStore.get(crashed.cid);
    expect(stored).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(stored!.tags).toContain("crashed");
  });

  test("crashed contribution does not appear in metric frontier", async () => {
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbEntries = frontier.byMetric.val_bpb ?? [];
    // No contributions have val_bpb scores
    expect(bpbEntries).toHaveLength(0);
  });

  test("crashed contribution appears in recency frontier", async () => {
    const frontier = await ctx.frontier.compute();
    expect(frontier.byRecency.length).toBeGreaterThanOrEqual(1);
  });

  test("count includes crashed contributions", async () => {
    const count = await ctx.contributionStore.count();
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid/extreme metric values
// ---------------------------------------------------------------------------

describe("extreme metric values", () => {
  let ctx: GroveContext;

  beforeAll(() => {
    resetTimestamps();
    ctx = setupGrove(contract, "edge-extreme");
  });

  afterAll(() => {
    cleanupGrove(ctx);
  });

  test("negative val_bpb is stored and ranked", async () => {
    const negative = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "Negative val_bpb — suspicious result",
      artifacts: {
        "train.py": "blake3:eeee000000000000000000000000000000000000000000000000000000000001",
      },
      relations: [],
      scores: {
        val_bpb: { value: -0.5, direction: ScoreDirection.Minimize, unit: "bpb" },
      },
      tags: ["suspicious"],
      agent,
      createdAt: nextTimestamp(),
    });

    await ctx.contributionStore.put(negative);

    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbEntries = frontier.byMetric.val_bpb ?? [];
    expect(bpbEntries.length).toBeGreaterThanOrEqual(1);
    // Negative value is still stored and ranked
    expect(bpbEntries[0].value).toBe(-0.5);
  });

  test("very large val_bpb is stored correctly", async () => {
    const large = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "Extremely bad result",
      artifacts: {
        "train.py": "blake3:ffff000000000000000000000000000000000000000000000000000000000002",
      },
      relations: [],
      scores: {
        val_bpb: { value: 999.99, direction: ScoreDirection.Minimize, unit: "bpb" },
      },
      tags: ["diverged"],
      agent,
      createdAt: nextTimestamp(),
    });

    await ctx.contributionStore.put(large);

    const stored = await ctx.contributionStore.get(large.cid);
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(stored!.scores?.val_bpb?.value).toBe(999.99);
  });

  test("zero val_bpb is stored and ranked", async () => {
    const zero = createContribution({
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "Perfect score (impossible but valid)",
      artifacts: {
        "train.py": "blake3:0000000000000000000000000000000000000000000000000000000000000099",
      },
      relations: [],
      scores: {
        val_bpb: { value: 0, direction: ScoreDirection.Minimize, unit: "bpb" },
      },
      tags: ["perfect"],
      agent,
      createdAt: nextTimestamp(),
    });

    await ctx.contributionStore.put(zero);

    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    const bpbEntries = frontier.byMetric.val_bpb ?? [];
    // Zero should be ranked as best (minimize)
    expect(bpbEntries.length).toBeGreaterThanOrEqual(3);
    // Frontier is sorted: -0.5, 0, 999.99
    expect(bpbEntries[0].value).toBe(-0.5);
    expect(bpbEntries[1].value).toBe(0);
  });

  test("target metric triggers when extreme value beats threshold", async () => {
    // The -0.5 and 0 values beat the 0.85 target
    const result = await evaluateStopConditions(contract, ctx.contributionStore);
    expect(result.conditions.target_metric?.met).toBe(true);
  });
});
