/**
 * Integration tests for lifecycle state derivation and stop condition
 * evaluation using a real SQLite store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStores } from "../local/sqlite-store.js";
import type { GroveContract } from "./contract.js";
import {
  deriveLifecycleState,
  deriveLifecycleStates,
  evaluateStopConditions,
  LifecycleState,
} from "./lifecycle.js";
import { createContribution } from "./manifest.js";
import type { ContributionInput } from "./models.js";
import { ContributionKind, ContributionMode, RelationType, ScoreDirection } from "./models.js";
import { makeAgent } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dbCounter = 0;
const dbPaths: string[] = [];

function createTestDb() {
  dbCounter += 1;
  const dbPath = join(tmpdir(), `grove-lifecycle-test-${Date.now()}-${dbCounter}.db`);
  dbPaths.push(dbPath);
  return createSqliteStores(dbPath);
}

afterEach(() => {
  for (const path of dbPaths) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(`${path}-wal`);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(`${path}-shm`);
    } catch {
      /* ignore */
    }
  }
  dbPaths.length = 0;
});

let uniqueId = 0;

function makeInput(overrides?: Partial<ContributionInput>): ContributionInput {
  uniqueId += 1;
  return {
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: `Integration test contribution ${uniqueId}`,
    artifacts: {},
    relations: [],
    tags: [],
    agent: makeAgent({ agentId: `integration-agent-${uniqueId}` }),
    createdAt: `2026-01-01T00:${String(uniqueId).padStart(2, "0")}:00Z`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle state with real SQLite
// ---------------------------------------------------------------------------

describe("lifecycle state integration (SQLite)", () => {
  test("derives published state for standalone contribution", async () => {
    const { contributionStore, close } = createTestDb();
    try {
      const work = createContribution(makeInput());
      await contributionStore.put(work);
      const state = await deriveLifecycleState(work.cid, contributionStore);
      expect(state).toBe(LifecycleState.Published);
    } finally {
      close();
    }
  });

  test("derives under_review when reviewed", async () => {
    const { contributionStore, close } = createTestDb();
    try {
      const work = createContribution(makeInput({ summary: "Work to review" }));
      await contributionStore.put(work);

      const review = createContribution(
        makeInput({
          kind: ContributionKind.Review,
          summary: "Review",
          relations: [{ targetCid: work.cid, relationType: RelationType.Reviews }],
        }),
      );
      await contributionStore.put(review);

      const state = await deriveLifecycleState(work.cid, contributionStore);
      expect(state).toBe(LifecycleState.UnderReview);
    } finally {
      close();
    }
  });

  test("batch derivation matches individual derivation", async () => {
    const { contributionStore, close } = createTestDb();
    try {
      const work1 = createContribution(makeInput({ summary: "Work 1" }));
      const work2 = createContribution(makeInput({ summary: "Work 2" }));
      await contributionStore.putMany([work1, work2]);

      const adoption = createContribution(
        makeInput({
          kind: ContributionKind.Adoption,
          summary: "Adopt work1",
          relations: [{ targetCid: work1.cid, relationType: RelationType.Adopts }],
        }),
      );
      await contributionStore.put(adoption);

      // Individual
      const state1 = await deriveLifecycleState(work1.cid, contributionStore);
      const state2 = await deriveLifecycleState(work2.cid, contributionStore);

      // Batch
      const states = await deriveLifecycleStates([work1.cid, work2.cid], contributionStore);

      expect(state1).toBe(LifecycleState.Adopted);
      expect(state2).toBe(LifecycleState.Published);
      expect(states.get(work1.cid)).toBe(state1);
      expect(states.get(work2.cid)).toBe(state2);
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// Stop condition evaluation with real SQLite
// ---------------------------------------------------------------------------

describe("stop condition evaluation integration (SQLite)", () => {
  test("target_metric condition met with real store", async () => {
    const { contributionStore, close } = createTestDb();
    try {
      const work = createContribution(
        makeInput({
          scores: { val_bpb: { value: 0.8, direction: ScoreDirection.Minimize } },
        }),
      );
      await contributionStore.put(work);

      const contract: GroveContract = {
        contractVersion: 1,
        name: "integration-test",
        metrics: { val_bpb: { direction: "minimize" as const } },
        stopConditions: { targetMetric: { metric: "val_bpb", value: 0.85 } },
      };

      const result = await evaluateStopConditions(contract, contributionStore);
      expect(result.stopped).toBe(true);
      expect(result.conditions.target_metric?.met).toBe(true);
    } finally {
      close();
    }
  });

  test("budget condition tracks contribution count", async () => {
    const { contributionStore, close } = createTestDb();
    try {
      const contract: GroveContract = {
        contractVersion: 1,
        name: "integration-test",
        stopConditions: { budget: { maxContributions: 3 } },
      };

      // Add 2 — not met
      for (let i = 0; i < 2; i++) {
        await contributionStore.put(createContribution(makeInput({ summary: `Work ${i}` })));
      }
      let result = await evaluateStopConditions(contract, contributionStore);
      expect(result.conditions.budget?.met).toBe(false);

      // Add 1 more — now met (3 >= 3)
      await contributionStore.put(createContribution(makeInput({ summary: "Work 2" })));
      result = await evaluateStopConditions(contract, contributionStore);
      expect(result.conditions.budget?.met).toBe(true);
    } finally {
      close();
    }
  });

  test("quorum_review_score with multiple reviewers", async () => {
    const { contributionStore, close } = createTestDb();
    try {
      const work = createContribution(makeInput({ summary: "Work to be reviewed" }));
      await contributionStore.put(work);

      // Add 3 reviews with scores
      for (let i = 0; i < 3; i++) {
        const review = createContribution(
          makeInput({
            kind: ContributionKind.Review,
            summary: `Review ${i}`,
            relations: [
              {
                targetCid: work.cid,
                relationType: RelationType.Reviews,
                metadata: { score: 0.85 + i * 0.02, verdict: "approve" },
              },
            ],
          }),
        );
        await contributionStore.put(review);
      }

      const contract: GroveContract = {
        contractVersion: 1,
        name: "integration-test",
        stopConditions: { quorumReviewScore: { minReviews: 3, minScore: 0.8 } },
      };

      const result = await evaluateStopConditions(contract, contributionStore);
      expect(result.conditions.quorum_review_score?.met).toBe(true);
    } finally {
      close();
    }
  });

  test("deliberation_limit with nested thread", async () => {
    const { contributionStore, close } = createTestDb();
    try {
      // Build a 4-deep discussion thread
      const root = createContribution(makeInput({ summary: "Root topic" }));
      await contributionStore.put(root);

      let parentCid = root.cid;
      for (let i = 0; i < 4; i++) {
        const reply = createContribution(
          makeInput({
            kind: ContributionKind.Discussion,
            summary: `Reply depth ${i + 1}`,
            relations: [{ targetCid: parentCid, relationType: RelationType.RespondsTo }],
          }),
        );
        await contributionStore.put(reply);
        parentCid = reply.cid;
      }

      const contract: GroveContract = {
        contractVersion: 1,
        name: "integration-test",
        stopConditions: { deliberationLimit: { maxRounds: 3 } },
      };

      const result = await evaluateStopConditions(contract, contributionStore);
      expect(result.conditions.deliberation_limit?.met).toBe(true);
    } finally {
      close();
    }
  });
});
