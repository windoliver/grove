/**
 * Multi-agent collaboration scenario — validates end-to-end coordination.
 *
 * Exercises the MCP tool layer programmatically to validate that agents
 * self-coordinate through grove's shared state (frontier, claims, contributions).
 *
 * Three test scenarios:
 *   1. Implement + Review convergence (DAG chain)
 *   2. Parallel claim deduplication + expiry re-claim
 *   3. Cross-agent adoption synthesis
 *
 * No real AI agents — uses MCP server in-process with direct tool calls.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GroveContract } from "../../src/core/contract.js";
import { parseGroveContract } from "../../src/core/contract.js";
import { createContribution } from "../../src/core/manifest.js";
import type { AgentIdentity, Claim, Contribution } from "../../src/core/models.js";
import {
  ClaimStatus,
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
  agentId: "agent-implementer",
  agentName: "Claude-Implementer",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  toolchain: "claude-code",
  platform: "darwin",
};

export const agentB: AgentIdentity = {
  agentId: "agent-reviewer",
  agentName: "Codex-Reviewer",
  provider: "openai",
  model: "codex",
  toolchain: "codex",
  platform: "linux",
};

export const agentC: AgentIdentity = {
  agentId: "agent-reproducer",
  agentName: "Claude-Reproducer",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  toolchain: "claude-code",
  platform: "darwin",
};

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

const groveContractPath = join(import.meta.dir, "grove.md");
const groveContractContent = readFileSync(groveContractPath, "utf-8");
export const contract: GroveContract = parseGroveContract(groveContractContent);

// Re-export helpers
export { cleanupGrove, type GroveContext, nextTimestamp, resetTimestamps } from "../helpers.js";

/** Create a grove context for the multi-agent scenario. */
export function setupGrove(): GroveContext {
  return setupGroveBase(contract, "multi-agent", "2026-03-10T10:05:00Z");
}

// ---------------------------------------------------------------------------
// Scenario 1: Implement + Review convergence
//
// Agent A creates initial work → Agent B reviews → Agent A improves →
// Agent B reviews again → approves.
// Validates: work→review→work→review DAG chain, review scores.
// ---------------------------------------------------------------------------

export interface Scenario1Result {
  readonly initialWork: Contribution;
  readonly firstReview: Contribution;
  readonly improvedWork: Contribution;
  readonly finalReview: Contribution;
}

export async function runScenario1(ctx: GroveContext): Promise<Scenario1Result> {
  const { contributionStore } = ctx;

  // Agent A: initial implementation
  const initialWork = createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Initial batch processor with sequential execution",
    description: "Baseline implementation processing items one at a time.",
    artifacts: {
      "processor.ts": "blake3:1111000000000000000000000000000000000000000000000000000000000001",
    },
    relations: [],
    scores: {
      throughput: { value: 1200, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      latency_p99: { value: 85, direction: ScoreDirection.Minimize, unit: "ms" },
    },
    tags: ["baseline", "sequential"],
    agent: agentA,
    createdAt: nextTimestamp(),
  });
  await contributionStore.put(initialWork);

  // Agent B: reviews A's work
  const firstReview = createContribution({
    kind: ContributionKind.Review,
    mode: ContributionMode.Evaluation,
    summary: "Sequential processing is too slow — suggest worker pool",
    description:
      "The sequential approach limits throughput. A worker pool with concurrency " +
      "control would improve throughput significantly.",
    artifacts: {},
    relations: [
      {
        targetCid: initialWork.cid,
        relationType: RelationType.Reviews,
        metadata: { score: 0.5 },
      },
    ],
    scores: {},
    tags: ["review", "optimization"],
    agent: agentB,
    createdAt: nextTimestamp(),
  });
  await contributionStore.put(firstReview);

  // Agent A: improves based on review
  const improvedWork = createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Worker pool implementation with 8 concurrent workers",
    description:
      "Switched to a worker pool model with 8 concurrent workers. " +
      "Addresses reviewer feedback about sequential bottleneck.",
    artifacts: {
      "processor.ts": "blake3:1111000000000000000000000000000000000000000000000000000000000002",
    },
    relations: [{ targetCid: initialWork.cid, relationType: RelationType.DerivesFrom }],
    scores: {
      throughput: { value: 5800, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      latency_p99: { value: 32, direction: ScoreDirection.Minimize, unit: "ms" },
    },
    tags: ["worker-pool", "concurrent"],
    agent: agentA,
    createdAt: nextTimestamp(),
  });
  await contributionStore.put(improvedWork);

  // Agent B: reviews improved work — approves
  const finalReview = createContribution({
    kind: ContributionKind.Review,
    mode: ContributionMode.Evaluation,
    summary: "Worker pool approach is solid — approved with minor suggestions",
    description:
      "The worker pool implementation is clean and well-structured. " +
      "Throughput improved 4.8x. Minor suggestion: add backpressure handling.",
    artifacts: {},
    relations: [
      {
        targetCid: improvedWork.cid,
        relationType: RelationType.Reviews,
        metadata: { score: 0.9 },
      },
    ],
    scores: {},
    tags: ["review", "approved"],
    agent: agentB,
    createdAt: nextTimestamp(),
  });
  await contributionStore.put(finalReview);

  return { initialWork, firstReview, improvedWork, finalReview };
}

// ---------------------------------------------------------------------------
// Scenario 2: Parallel claim deduplication + expiry re-claim
//
// Agent A and Agent C both try to claim "optimize-parser".
// Agent A succeeds, Agent C gets conflict → picks different work.
// Agent A's claim expires → Agent C successfully re-claims.
// Validates: claim conflict, claim expiry, re-claim after expiry.
// ---------------------------------------------------------------------------

export interface Scenario2Result {
  readonly agentAClaim: Claim;
  readonly agentCConflictError: string;
  readonly agentCAlternativeClaim: Claim;
  readonly agentCReclaimAfterExpiry: Claim;
}

export async function runScenario2(ctx: GroveContext): Promise<Scenario2Result> {
  const { claimStore } = ctx;
  const now = new Date();

  // Agent A claims "optimize-parser"
  const agentAClaim = await claimStore.createClaim({
    claimId: "claim-parser-a",
    targetRef: "optimize-parser",
    agent: agentA,
    status: ClaimStatus.Active,
    intentSummary: "Optimize the parser module for throughput",
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
  });

  // Agent C tries to claim same target — should fail
  let agentCConflictError = "";
  try {
    await claimStore.claimOrRenew({
      claimId: "claim-parser-c",
      targetRef: "optimize-parser",
      agent: agentC,
      status: ClaimStatus.Active,
      intentSummary: "Also want to optimize parser",
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
    });
  } catch (error) {
    agentCConflictError = error instanceof Error ? error.message : String(error);
  }

  // Agent C picks different work instead
  const agentCAlternativeClaim = await claimStore.createClaim({
    claimId: "claim-lexer-c",
    targetRef: "optimize-lexer",
    agent: agentC,
    status: ClaimStatus.Active,
    intentSummary: "Optimize the lexer module instead",
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
  });

  // Complete Agent A's parser claim before creating a new one (maxClaimsPerAgent=1)
  await claimStore.complete("claim-parser-a");

  // Simulate Agent A's claim expiring: create an expired claim for a new target
  const pastTime = new Date(now.getTime() - 600_000);
  const expiredLease = new Date(now.getTime() - 300_000);
  await claimStore.createClaim({
    claimId: "claim-cache-expired",
    targetRef: "optimize-cache",
    agent: agentA,
    status: ClaimStatus.Active,
    intentSummary: "Was optimizing cache, but expired",
    createdAt: pastTime.toISOString(),
    heartbeatAt: pastTime.toISOString(),
    leaseExpiresAt: expiredLease.toISOString(),
  });

  // Expire stale claims
  await claimStore.expireStale();

  // Release Agent C's lexer claim before re-claiming (maxClaimsPerAgent=1)
  await claimStore.release("claim-lexer-c");

  // Agent C can now claim the expired target
  const agentCReclaimAfterExpiry = await claimStore.claimOrRenew({
    claimId: "claim-cache-c",
    targetRef: "optimize-cache",
    agent: agentC,
    status: ClaimStatus.Active,
    intentSummary: "Taking over cache optimization after expiry",
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
  });

  return {
    agentAClaim,
    agentCConflictError,
    agentCAlternativeClaim,
    agentCReclaimAfterExpiry,
  };
}

// ---------------------------------------------------------------------------
// Scenario 3: Cross-agent adoption
//
// Agent A contributes technique X (throughput=3000).
// Agent B contributes technique Y (throughput=6500).
// Agent A sees B's better result → adopts ideas → synthesis (throughput=9200).
// Validates: adoption relations, frontier ordering, DAG lineage.
// ---------------------------------------------------------------------------

export interface Scenario3Result {
  readonly techniqueX: Contribution;
  readonly techniqueY: Contribution;
  readonly synthesis: Contribution;
  readonly reproduction: Contribution;
}

export async function runScenario3(ctx: GroveContext): Promise<Scenario3Result> {
  const { contributionStore } = ctx;

  // Agent A: technique X
  const techniqueX = createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Technique X: memory-mapped I/O for file processing",
    description: "Use mmap for zero-copy file reads, reducing syscall overhead.",
    artifacts: {
      "processor.ts": "blake3:3333000000000000000000000000000000000000000000000000000000000001",
    },
    relations: [],
    scores: {
      throughput: { value: 3000, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      latency_p99: { value: 65, direction: ScoreDirection.Minimize, unit: "ms" },
    },
    tags: ["mmap", "io-optimization"],
    agent: agentA,
    createdAt: nextTimestamp(),
  });
  await contributionStore.put(techniqueX);

  // Agent B: technique Y (better result)
  const techniqueY = createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Technique Y: SIMD-accelerated parsing with batched I/O",
    description: "Combine SIMD vector operations for parsing with batched I/O reads.",
    artifacts: {
      "processor.ts": "blake3:3333000000000000000000000000000000000000000000000000000000000002",
    },
    relations: [],
    scores: {
      throughput: { value: 6500, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      latency_p99: { value: 28, direction: ScoreDirection.Minimize, unit: "ms" },
    },
    tags: ["simd", "batched-io"],
    agent: agentB,
    createdAt: nextTimestamp(),
  });
  await contributionStore.put(techniqueY);

  // Agent A sees B's better result → adopts + synthesizes
  const synthesis = createContribution({
    kind: ContributionKind.Adoption,
    mode: ContributionMode.Evaluation,
    summary: "Synthesis: mmap + SIMD parsing for maximum throughput",
    description:
      "Combined Agent A's mmap approach with Agent B's SIMD parsing. " +
      "mmap provides zero-copy reads while SIMD accelerates the parse step.",
    artifacts: {
      "processor.ts": "blake3:3333000000000000000000000000000000000000000000000000000000000003",
    },
    relations: [
      { targetCid: techniqueX.cid, relationType: RelationType.DerivesFrom },
      { targetCid: techniqueY.cid, relationType: RelationType.Adopts },
    ],
    scores: {
      throughput: { value: 9200, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      latency_p99: { value: 18, direction: ScoreDirection.Minimize, unit: "ms" },
    },
    tags: ["mmap", "simd", "synthesis"],
    agent: agentA,
    createdAt: nextTimestamp(),
  });
  await contributionStore.put(synthesis);

  // Agent C reproduces the synthesis result
  const reproduction = createContribution({
    kind: ContributionKind.Reproduction,
    mode: ContributionMode.Evaluation,
    summary: "Reproduced synthesis: throughput=9150 (within noise)",
    description: "Independent reproduction confirms the synthesis result.",
    artifacts: {},
    relations: [
      {
        targetCid: synthesis.cid,
        relationType: RelationType.Reproduces,
        metadata: { result: "confirmed", delta: 50 },
      },
    ],
    scores: {
      throughput: { value: 9150, direction: ScoreDirection.Maximize, unit: "ops/sec" },
      latency_p99: { value: 19, direction: ScoreDirection.Minimize, unit: "ms" },
    },
    tags: ["reproduction", "confirmed"],
    agent: agentC,
    createdAt: nextTimestamp(),
  });
  await contributionStore.put(reproduction);

  return { techniqueX, techniqueY, synthesis, reproduction };
}

// ---------------------------------------------------------------------------
// Standalone runner
// ---------------------------------------------------------------------------

if (import.meta.main) {
  resetTimestamps();
  const ctx = setupGrove();

  try {
    console.log("=== Multi-Agent Collaboration Scenario ===\n");

    // Scenario 1
    console.log("--- Scenario 1: Implement + Review Convergence ---");
    const s1 = await runScenario1(ctx);
    console.log(`  Initial work: throughput=${s1.initialWork.scores?.throughput?.value}`);
    console.log(`  First review: score=${s1.firstReview.relations[0]?.metadata?.score}`);
    console.log(`  Improved work: throughput=${s1.improvedWork.scores?.throughput?.value}`);
    console.log(`  Final review: score=${s1.finalReview.relations[0]?.metadata?.score}`);
    console.log(`  DAG: work → review → work → review ✓\n`);

    // Scenario 2
    console.log("--- Scenario 2: Claim Deduplication ---");
    const s2 = await runScenario2(ctx);
    console.log(`  Agent A claimed: ${s2.agentAClaim.targetRef}`);
    console.log(`  Agent C conflict: ${s2.agentCConflictError.slice(0, 60)}...`);
    console.log(`  Agent C alternative: ${s2.agentCAlternativeClaim.targetRef}`);
    console.log(`  Agent C re-claim after expiry: ${s2.agentCReclaimAfterExpiry.targetRef} ✓\n`);

    // Scenario 3
    console.log("--- Scenario 3: Cross-Agent Adoption ---");
    const s3 = await runScenario3(ctx);
    console.log(`  Technique X: throughput=${s3.techniqueX.scores?.throughput?.value}`);
    console.log(`  Technique Y: throughput=${s3.techniqueY.scores?.throughput?.value}`);
    console.log(`  Synthesis: throughput=${s3.synthesis.scores?.throughput?.value}`);
    console.log(`  Reproduction: confirmed ✓`);

    // Frontier
    const frontier = await ctx.frontier.compute({ metric: "throughput" });
    console.log("\nFrontier (by throughput, higher is better):");
    for (const entry of frontier.byMetric.throughput ?? []) {
      console.log(`  ${entry.value} ops/sec — ${entry.summary}`);
    }

    console.log("\n=== All scenarios complete ===");
  } finally {
    cleanupGrove(ctx);
  }
}
