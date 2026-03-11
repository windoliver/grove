/**
 * Mini autoresearch scenario — validates the Grove protocol end-to-end.
 *
 * Simulates 3 agents optimizing a training script:
 *   Agent A: initial work → review of B → adoption of B's ideas
 *   Agent B: derives from A with improvement → adoption synthesis
 *   Agent C: reproduces A's result
 *
 * Uses SQLite store (production path), not in-memory.
 * No GPU, no AI agents — pure protocol validation.
 */

import type { GroveContract } from "../../src/core/contract.js";
import { evaluateStopConditions } from "../../src/core/lifecycle.js";
import { createContribution } from "../../src/core/manifest.js";
import type { AgentIdentity, Contribution } from "../../src/core/models.js";
import {
  ContributionKind,
  ContributionMode,
  RelationType,
  ScoreDirection,
} from "../../src/core/models.js";
import {
  cleanupGrove,
  type GroveContext,
  nextTimestamp,
  resetTimestamps,
  setupGrove as setupGroveBase,
} from "../helpers.js";

// ---------------------------------------------------------------------------
// Agent identities
// ---------------------------------------------------------------------------

export const agentA: AgentIdentity = {
  agentId: "agent-a",
  agentName: "Claude-Researcher",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  platform: "lambda-h100",
};

export const agentB: AgentIdentity = {
  agentId: "agent-b",
  agentName: "Codex-Reviewer",
  provider: "openai",
  model: "codex",
  platform: "lambda-h100",
};

export const agentC: AgentIdentity = {
  agentId: "agent-c",
  agentName: "Claude-Reproducer",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  platform: "lambda-h100",
};

// ---------------------------------------------------------------------------
// Contract (GROVE.md equivalent)
// ---------------------------------------------------------------------------

export const contract: GroveContract = {
  contractVersion: 2,
  name: "mini-autoresearch",
  description: "Optimize GPT training for lower val_bpb",
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

// Re-export helpers for test files that import from this module.
export { cleanupGrove, type GroveContext, nextTimestamp, resetTimestamps } from "../helpers.js";

/** Create a grove context for the autoresearch scenario. */
export function setupGrove(): GroveContext {
  return setupGroveBase(contract, "autoresearch", "2026-03-10T10:05:00Z");
}

// ---------------------------------------------------------------------------
// Scenario steps — each returns the created contribution
// ---------------------------------------------------------------------------

/** Agent A creates the initial baseline work contribution. */
export function agentA_initialWork(): Contribution {
  return createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Baseline GPT training with AdamW optimizer",
    description: "Initial training run with standard hyperparameters. batch_size=64, lr=3e-4.",
    artifacts: {
      "train.ts": "blake3:aaaa000000000000000000000000000000000000000000000000000000000001",
    },
    relations: [],
    scores: {
      val_bpb: { value: 1.05, direction: ScoreDirection.Minimize, unit: "bpb" },
      peak_vram_gb: { value: 42.3, direction: ScoreDirection.Minimize, unit: "GB" },
    },
    tags: ["baseline", "adamw"],
    agent: agentA,
    createdAt: nextTimestamp(),
  });
}

/** Agent B derives from A's work with an improvement. */
export function agentB_derivesFromA(parentCid: string): Contribution {
  return createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Replace AdamW with MuonAdamW optimizer",
    description: "Switched to MuonAdamW with momentum-based updates. Same architecture otherwise.",
    artifacts: {
      "train.ts": "blake3:bbbb000000000000000000000000000000000000000000000000000000000002",
    },
    relations: [{ targetCid: parentCid, relationType: RelationType.DerivesFrom }],
    scores: {
      val_bpb: { value: 0.98, direction: ScoreDirection.Minimize, unit: "bpb" },
      peak_vram_gb: { value: 43.1, direction: ScoreDirection.Minimize, unit: "GB" },
    },
    tags: ["muonadamw", "optimizer"],
    agent: agentB,
    createdAt: nextTimestamp(),
  });
}

/** Agent A reviews Agent B's contribution. */
export function agentA_reviewsB(targetCid: string): Contribution {
  return createContribution({
    kind: ContributionKind.Review,
    mode: ContributionMode.Evaluation,
    summary: "Good optimizer change, verified fair comparison",
    description: "The MuonAdamW change is a clean swap. Training setup is otherwise identical.",
    artifacts: {},
    relations: [{ targetCid, relationType: RelationType.Reviews }],
    scores: {
      quality: { value: 8, direction: ScoreDirection.Maximize },
    },
    tags: ["review"],
    agent: agentA,
    createdAt: nextTimestamp(),
  });
}

/** Agent C reproduces Agent A's baseline result. */
export function agentC_reproducesA(targetCid: string): Contribution {
  return createContribution({
    kind: ContributionKind.Reproduction,
    mode: ContributionMode.Evaluation,
    summary: "Reproduced baseline, val_bpb=1.04 (within noise)",
    artifacts: {},
    relations: [
      {
        targetCid,
        relationType: RelationType.Reproduces,
        metadata: { result: "confirmed", delta: 0.01 },
      },
    ],
    scores: {
      val_bpb: { value: 1.04, direction: ScoreDirection.Minimize, unit: "bpb" },
    },
    tags: ["reproduction"],
    agent: agentC,
    createdAt: nextTimestamp(),
  });
}

/** Agent B adopts ideas from A's baseline into a synthesis. */
export function agentB_adoptsSynthesis(adoptsCid: string, derivesCid: string): Contribution {
  return createContribution({
    kind: ContributionKind.Adoption,
    mode: ContributionMode.Evaluation,
    summary: "Combine MuonAdamW with rotary embeddings from baseline analysis",
    description: "Adopted the training schedule insights from Agent A's baseline run.",
    artifacts: {
      "train.ts": "blake3:cccc000000000000000000000000000000000000000000000000000000000003",
    },
    relations: [
      { targetCid: adoptsCid, relationType: RelationType.Adopts },
      { targetCid: derivesCid, relationType: RelationType.DerivesFrom },
    ],
    scores: {
      val_bpb: { value: 0.93, direction: ScoreDirection.Minimize, unit: "bpb" },
      peak_vram_gb: { value: 44.7, direction: ScoreDirection.Minimize, unit: "GB" },
    },
    tags: ["muonadamw", "rotary", "synthesis"],
    agent: agentB,
    createdAt: nextTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Full scenario runner
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  readonly workA: Contribution;
  readonly workB: Contribution;
  readonly reviewAofB: Contribution;
  readonly reproductionC: Contribution;
  readonly adoptionB: Contribution;
  readonly allContributions: readonly Contribution[];
}

/** Run the complete autoresearch scenario, returning all contributions. */
export async function runScenario(ctx: GroveContext): Promise<ScenarioResult> {
  const { contributionStore } = ctx;

  // Step 1: Agent A creates baseline
  const workA = agentA_initialWork();
  await contributionStore.put(workA);

  // Step 2: Agent B improves on A
  const workB = agentB_derivesFromA(workA.cid);
  await contributionStore.put(workB);

  // Step 3: Agent A reviews B's contribution
  const reviewAofB = agentA_reviewsB(workB.cid);
  await contributionStore.put(reviewAofB);

  // Step 4: Agent C reproduces A's baseline
  const reproductionC = agentC_reproducesA(workA.cid);
  await contributionStore.put(reproductionC);

  // Step 5: Agent B creates adoption/synthesis
  const adoptionB = agentB_adoptsSynthesis(workA.cid, workB.cid);
  await contributionStore.put(adoptionB);

  const allContributions = [workA, workB, reviewAofB, reproductionC, adoptionB];

  return { workA, workB, reviewAofB, reproductionC, adoptionB, allContributions };
}

// ---------------------------------------------------------------------------
// Standalone runner — `bun run examples/autoresearch/scenario.ts`
// ---------------------------------------------------------------------------

if (import.meta.main) {
  resetTimestamps();
  const ctx = setupGrove();

  try {
    const result = await runScenario(ctx);

    console.log("=== Mini Autoresearch Scenario ===\n");
    console.log("Contributions:");
    for (const c of result.allContributions) {
      const scores = c.scores
        ? Object.entries(c.scores)
            .map(([k, v]) => `${k}=${v.value}`)
            .join(", ")
        : "none";
      console.log(`  [${c.kind}] ${c.summary}`);
      console.log(`    CID: ${c.cid.slice(0, 20)}...`);
      console.log(`    Agent: ${c.agent.agentName} (${c.agent.agentId})`);
      console.log(`    Scores: ${scores}`);
      console.log(
        `    Relations: ${c.relations.map((r) => `${r.relationType}→${r.targetCid.slice(0, 16)}...`).join(", ") || "none"}`,
      );
      console.log();
    }

    // Frontier
    const frontier = await ctx.frontier.compute({ metric: "val_bpb" });
    console.log("Frontier (by val_bpb, lower is better):");
    for (const entry of frontier.byMetric.val_bpb ?? []) {
      console.log(`  ${entry.value} — ${entry.summary} (${entry.cid.slice(0, 16)}...)`);
    }

    console.log("\nFrontier (by adoption count):");
    for (const entry of frontier.byAdoption) {
      console.log(`  ${entry.value} adoptions — ${entry.summary}`);
    }

    console.log("\nFrontier (by recency):");
    for (const entry of frontier.byRecency.slice(0, 3)) {
      console.log(`  ${entry.contribution.createdAt} — ${entry.summary}`);
    }

    // Stop conditions
    const stopResult = await evaluateStopConditions(contract, ctx.contributionStore);
    console.log(`\nStop conditions met: ${stopResult.stopped}`);
    for (const [name, cond] of Object.entries(stopResult.conditions)) {
      console.log(`  ${name}: ${cond.met ? "MET" : "not met"} — ${cond.reason}`);
    }

    console.log("\n=== Scenario complete ===");
  } finally {
    cleanupGrove(ctx);
  }
}
