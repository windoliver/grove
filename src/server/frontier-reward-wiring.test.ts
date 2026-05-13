import { describe, expect, test } from "bun:test";

import type { GroveContract } from "../core/contract.js";
import type { FrontierRewardService } from "../core/frontier-reward-service.js";
import { type Contribution, ScoreDirection } from "../core/models.js";
import type { Session } from "../core/session.js";
import { makeContribution } from "../core/test-helpers.js";
import { InMemoryContributionStore } from "../core/testing.js";
import { SqliteBountyStore } from "../local/sqlite-bounty-store.js";
import { SqliteCreditsService } from "../local/sqlite-credits-service.js";
import { initSqliteDb } from "../local/sqlite-store.js";
import type { GoalData } from "../tui/provider.js";
import type { ServerDeps } from "./deps.js";
import { operationDepsForSession } from "./routes/shared.js";
import { createTestApp, makeManifestBody, TEST_AUTH_HEADERS } from "./test-helpers.js";

const SESSION_ID = "session-frontier-reward";
const SESSION_CONFIG: GroveContract = {
  contractVersion: 1,
  name: "frontier-reward-session-test",
  metrics: {
    accuracy: { direction: ScoreDirection.Maximize },
  },
};

describe("frontier reward wiring", () => {
  test("operationDepsForSession does not inherit the root frontier reward service", () => {
    const { deps } = createTestApp();
    const rootRewardService = rewardProbe();
    const rootDeps = Object.assign(deps, { frontierRewardService: rootRewardService });

    expect(operationDepsForSession(rootDeps, undefined).frontierRewardService).toBe(
      rootRewardService,
    );
    expect(operationDepsForSession(rootDeps, SESSION_ID).frontierRewardService).toBeUndefined();
  });

  test("session-scoped contribution writes use scoped frontier rewards, not root rewards", async () => {
    const { app, deps } = createTestApp();
    const scopedContributionStore = new InMemoryContributionStore();
    const db = initSqliteDb(":memory:");
    const bountyStore = new SqliteBountyStore(db);
    const creditsService = new SqliteCreditsService(db, {
      initialBalance: 0,
      rewardTreasuryBalance: 100,
    });
    const rewardCalls: string[] = [];
    const rootRewardService = rewardProbe((contribution) => {
      rewardCalls.push(contribution.cid);
    });

    try {
      await scopedContributionStore.put(
        makeContribution({
          summary: "session baseline",
          scores: { accuracy: { value: 0.5, direction: ScoreDirection.Maximize } },
        }),
      );

      Object.assign(deps, {
        contributionStoreForSession: () => scopedContributionStore,
        frontierRewardService: rootRewardService,
        bountyStore,
        creditsService,
        goalSessionStore: new StubGoalSessionStore(),
      } satisfies Partial<ServerDeps>);

      const res = await app.request("/api/contributions", {
        method: "POST",
        headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify(
          makeManifestBody({
            sessionId: SESSION_ID,
            summary: "session-scoped frontier reward probe",
            scores: { accuracy: { value: 0.9, direction: ScoreDirection.Maximize } },
          }),
        ),
      });

      expect(res.status).toBe(201);
      expect(rewardCalls).toEqual([]);
      expect(await bountyStore.listRewards({ rewardType: "frontier_advance" })).toHaveLength(1);
      expect(await creditsService.balance("test-agent-001")).toEqual({
        available: 1,
        reserved: 0,
        total: 1,
      });
    } finally {
      db.close();
    }
  });
});

function rewardProbe(onEvaluate?: (contribution: Contribution) => void): FrontierRewardService {
  return {
    evaluateContribution: async (contribution: Contribution) => {
      onEvaluate?.(contribution);
    },
  } as FrontierRewardService;
}

class StubGoalSessionStore {
  private readonly session: Session = {
    id: SESSION_ID,
    uid: SESSION_ID,
    status: "active",
    createdAt: new Date().toISOString(),
    finalizers: [],
    contributionCount: 0,
    config: SESSION_CONFIG,
  };

  async getGoal(): Promise<GoalData | undefined> {
    return undefined;
  }

  async setGoal(): Promise<GoalData> {
    throw new Error("setGoal is not used by this test");
  }

  async listSessions(): Promise<readonly Session[]> {
    return [this.session];
  }

  async createSession(): Promise<Session> {
    throw new Error("createSession is not used by this test");
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return sessionId === SESSION_ID ? this.session : undefined;
  }

  async updateSession(): Promise<void> {
    throw new Error("updateSession is not used by this test");
  }

  async archiveSession(): Promise<void> {
    throw new Error("archiveSession is not used by this test");
  }

  async deleteSession(): Promise<never> {
    throw new Error("deleteSession is not used by this test");
  }

  async listSessionDeleteBlockers(): Promise<readonly []> {
    return [];
  }

  async addContributionToSession(): Promise<void> {
    return undefined;
  }

  async getSessionContributions(): Promise<readonly string[]> {
    return [];
  }

  async getSessionConfig(sessionId: string): Promise<GroveContract | undefined> {
    return sessionId === SESSION_ID ? SESSION_CONFIG : undefined;
  }

  getSessionConfigSync(sessionId: string): GroveContract | undefined {
    return sessionId === SESSION_ID ? SESSION_CONFIG : undefined;
  }

  gcStaleSessions(): number {
    return 0;
  }

  close(): void {
    // No resources are owned by this test stub.
  }
}
