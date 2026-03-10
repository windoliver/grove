/**
 * Code exploration scenario — validates grove in exploration mode (no metrics).
 *
 * Simulates 3 agents investigating performance bottlenecks:
 *   Agent A: contributes a finding about database connection pool exhaustion
 *   Agent B: responds with a related finding about query N+1 patterns
 *   Agent C: reviews Agent A's finding
 *
 * In exploration mode, frontier is ranked by adoption + recency, not metrics.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroveContract } from "../../src/core/contract.js";
import { EnforcingClaimStore, EnforcingContributionStore } from "../../src/core/enforcing-store.js";
import { DefaultFrontierCalculator } from "../../src/core/frontier.js";
import { createContribution } from "../../src/core/manifest.js";
import type { AgentIdentity, Contribution } from "../../src/core/models.js";
import {
  ContributionKind,
  ContributionMode,
  RelationType,
  ScoreDirection,
} from "../../src/core/models.js";
import type { ClaimStore, ContributionStore } from "../../src/core/store.js";
import { createSqliteStores } from "../../src/local/sqlite-store.js";

// ---------------------------------------------------------------------------
// Agent identities
// ---------------------------------------------------------------------------

export const agentA: AgentIdentity = {
  agentId: "explorer-a",
  agentName: "Claude-Explorer",
  provider: "anthropic",
};

export const agentB: AgentIdentity = {
  agentId: "explorer-b",
  agentName: "Codex-Explorer",
  provider: "openai",
};

export const agentC: AgentIdentity = {
  agentId: "explorer-c",
  agentName: "Claude-Reviewer",
  provider: "anthropic",
};

// ---------------------------------------------------------------------------
// Grove setup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const contract: GroveContract = {
  contractVersion: 2,
  name: "code-exploration",
  description: "Investigate performance bottlenecks",
  mode: ContributionMode.Exploration,
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
// Grove setup
// ---------------------------------------------------------------------------

export interface GroveContext {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: DefaultFrontierCalculator;
  readonly dbPath: string;
  readonly close: () => void;
}

let dbCounter = 0;

export function setupGrove(): GroveContext {
  dbCounter += 1;
  const dbPath = join(tmpdir(), `grove-e2e-exploration-${Date.now()}-${dbCounter}.db`);
  const stores = createSqliteStores(dbPath);
  // Provide a clock matching the scenario's deterministic timestamps (2026-03-10T14:…)
  // so the enforcing wrapper's clock-skew check doesn't reject them.
  const clock = () => new Date("2026-03-10T14:05:00Z");
  const contributionStore = new EnforcingContributionStore(stores.contributionStore, contract, {
    clock,
  });
  const claimStore = new EnforcingClaimStore(stores.claimStore, contract);
  const frontier = new DefaultFrontierCalculator(contributionStore);
  return { contributionStore, claimStore, frontier, dbPath, close: stores.close };
}

export function cleanupGrove(ctx: GroveContext): void {
  ctx.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${ctx.dbPath}${suffix}`);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

let timestampCounter = 0;

export function nextTimestamp(): string {
  timestampCounter += 1;
  const minutes = String(Math.floor(timestampCounter / 60)).padStart(2, "0");
  const seconds = String(timestampCounter % 60).padStart(2, "0");
  return `2026-03-10T14:${minutes}:${seconds}Z`;
}

export function resetTimestamps(): void {
  timestampCounter = 0;
}

// ---------------------------------------------------------------------------
// Scenario steps
// ---------------------------------------------------------------------------

/** Agent A contributes a finding about DB connection pool exhaustion. */
export function agentA_finding(): Contribution {
  return createContribution({
    kind: ContributionKind.Work,
    mode: ContributionMode.Exploration,
    summary: "Database connection pool exhausts at >100 concurrent requests",
    description:
      "Profiling shows the connection pool (max 20 connections) saturates under load. " +
      "P99 latency spikes from 50ms to 2.3s when concurrent requests exceed 100.",
    artifacts: {
      "profile.txt": "blake3:dddd000000000000000000000000000000000000000000000000000000000001",
    },
    relations: [],
    tags: ["performance", "database", "connection-pool"],
    agent: agentA,
    createdAt: nextTimestamp(),
  });
}

/** Agent B responds to A with a related finding about N+1 queries. */
export function agentB_responds(parentCid: string): Contribution {
  return createContribution({
    kind: ContributionKind.Discussion,
    mode: ContributionMode.Exploration,
    summary: "N+1 query pattern in user endpoint amplifies connection pool pressure",
    description:
      "The /api/users endpoint loads each user's profile separately instead of batching. " +
      "With 50 users per page, this generates 51 queries per request.",
    artifacts: {
      "query-log.txt": "blake3:dddd000000000000000000000000000000000000000000000000000000000002",
    },
    relations: [{ targetCid: parentCid, relationType: RelationType.RespondsTo }],
    tags: ["performance", "database", "n-plus-one"],
    agent: agentB,
    createdAt: nextTimestamp(),
  });
}

/** Agent C reviews Agent A's finding. */
export function agentC_reviewsFinding(targetCid: string): Contribution {
  return createContribution({
    kind: ContributionKind.Review,
    mode: ContributionMode.Exploration,
    summary: "Confirmed pool exhaustion finding, suggest pgBouncer",
    description:
      "Verified the connection pool issue. Recommend pgBouncer for connection pooling " +
      "as an immediate fix while the N+1 pattern is addressed.",
    artifacts: {},
    relations: [{ targetCid, relationType: RelationType.Reviews }],
    scores: {
      quality: { value: 9, direction: ScoreDirection.Maximize },
    },
    tags: ["review", "performance"],
    agent: agentC,
    createdAt: nextTimestamp(),
  });
}

/** Agent A responds to B with a follow-up discussion. */
export function agentA_followUp(parentCid: string): Contribution {
  return createContribution({
    kind: ContributionKind.Discussion,
    mode: ContributionMode.Exploration,
    summary: "Agree on N+1 fix — DataLoader pattern would solve both issues",
    description:
      "Using a DataLoader pattern would batch the user queries AND reduce total connection usage. " +
      "This addresses both Agent B's N+1 finding and the pool exhaustion.",
    artifacts: {},
    relations: [{ targetCid: parentCid, relationType: RelationType.RespondsTo }],
    tags: ["performance", "database", "solution"],
    agent: agentA,
    createdAt: nextTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Full scenario runner
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  readonly findingA: Contribution;
  readonly responseB: Contribution;
  readonly reviewC: Contribution;
  readonly followUpA: Contribution;
  readonly allContributions: readonly Contribution[];
}

export async function runScenario(ctx: GroveContext): Promise<ScenarioResult> {
  const { contributionStore } = ctx;

  const findingA = agentA_finding();
  await contributionStore.put(findingA);

  const responseB = agentB_responds(findingA.cid);
  await contributionStore.put(responseB);

  const reviewC = agentC_reviewsFinding(findingA.cid);
  await contributionStore.put(reviewC);

  const followUpA = agentA_followUp(responseB.cid);
  await contributionStore.put(followUpA);

  const allContributions = [findingA, responseB, reviewC, followUpA];

  return { findingA, responseB, reviewC, followUpA, allContributions };
}

// ---------------------------------------------------------------------------
// Standalone runner
// ---------------------------------------------------------------------------

if (import.meta.main) {
  resetTimestamps();
  const ctx = setupGrove();

  try {
    const result = await runScenario(ctx);

    console.log("=== Code Exploration Scenario ===\n");
    console.log("Contributions:");
    for (const c of result.allContributions) {
      console.log(`  [${c.kind}] ${c.summary}`);
      console.log(`    CID: ${c.cid.slice(0, 20)}...`);
      console.log(`    Agent: ${c.agent.agentName}`);
      console.log(`    Mode: ${c.mode}`);
      console.log(
        `    Relations: ${c.relations.map((r) => `${r.relationType}→${r.targetCid.slice(0, 16)}...`).join(", ") || "none"}`,
      );
      console.log();
    }

    // Frontier (exploration mode — no metrics, ranked by adoption + recency)
    const frontier = await ctx.frontier.compute({ mode: ContributionMode.Exploration });

    console.log("Frontier (by recency, exploration mode):");
    for (const entry of frontier.byRecency) {
      console.log(`  ${entry.contribution.createdAt} — ${entry.summary}`);
    }

    console.log("\nFrontier (by adoption count):");
    for (const entry of frontier.byAdoption) {
      console.log(`  ${entry.value} adoptions — ${entry.summary}`);
    }

    console.log("\nFrontier (by review score):");
    for (const entry of frontier.byReviewScore) {
      console.log(`  score ${entry.value} — ${entry.summary}`);
    }

    // Thread traversal
    const thread = await ctx.contributionStore.thread(result.findingA.cid);
    console.log(`\nThread from finding A (${thread.length} nodes):`);
    for (const node of thread) {
      const indent = "  ".repeat(node.depth + 1);
      console.log(`${indent}[depth=${node.depth}] ${node.contribution.summary}`);
    }

    // Search
    const dbFindings = await ctx.contributionStore.search("database");
    console.log(`\nSearch "database": ${dbFindings.length} results`);
    for (const c of dbFindings) {
      console.log(`  ${c.summary}`);
    }

    console.log("\n=== Scenario complete ===");
  } finally {
    cleanupGrove(ctx);
  }
}
