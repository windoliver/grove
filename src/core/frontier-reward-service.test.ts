import { afterEach, describe, expect, test } from "bun:test";

import { SqliteBountyStore } from "../local/sqlite-bounty-store.js";
import { SqliteCreditsService } from "../local/sqlite-credits-service.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";
import { RewardType } from "./bounty.js";
import type { Frontier, FrontierCalculator } from "./frontier.js";
import { DefaultFrontierCalculator } from "./frontier.js";
import { FrontierRewardService } from "./frontier-reward-service.js";
import { ContributionMode, ScoreDirection } from "./models.js";
import { makeAgent, makeContribution } from "./test-helpers.js";

describe("FrontierRewardService", () => {
  let db: ReturnType<typeof initSqliteDb> | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setup(options?: {
    readonly rewardTreasuryBalance?: number | undefined;
    readonly eligibleMetrics?: readonly string[] | undefined;
    readonly maxRewardAmount?: number | undefined;
  }): {
    readonly contributionStore: SqliteContributionStore;
    readonly bountyStore: SqliteBountyStore;
    readonly creditsService: SqliteCreditsService;
    readonly service: FrontierRewardService;
  } {
    db = initSqliteDb(":memory:");
    const contributionStore = new SqliteContributionStore(db);
    const bountyStore = new SqliteBountyStore(db);
    const creditsService = new SqliteCreditsService(db, {
      initialBalance: 0,
      rewardTreasuryBalance: options?.rewardTreasuryBalance ?? 100,
    });
    const service = new FrontierRewardService({
      frontier: new DefaultFrontierCalculator(contributionStore),
      bountyStore,
      creditsService,
      eligibleMetrics: options?.eligibleMetrics,
      maxRewardAmount: options?.maxRewardAmount,
    });

    return { contributionStore, bountyStore, creditsService, service };
  }

  test("pays and records one reward when a contribution advances a minimized metric", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup({
      eligibleMetrics: ["val_bpb"],
    });
    const previous = makeContribution({
      summary: "previous val_bpb",
      agent: makeAgent({ agentId: "agent-old" }),
      scores: { val_bpb: { value: 0.95, direction: ScoreDirection.Minimize } },
    });
    const improved = makeContribution({
      summary: "improved val_bpb",
      agent: makeAgent({ agentId: "agent-new" }),
      scores: { val_bpb: { value: 0.9, direction: ScoreDirection.Minimize } },
    });
    await contributionStore.put(previous);
    await contributionStore.put(improved);

    await service.evaluateContribution(improved);

    expect(await creditsService.balance("agent-new")).toEqual({
      available: 1,
      reserved: 0,
      total: 1,
    });
    const rewards = await bountyStore.listRewards({ contributionCid: improved.cid });
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({
      rewardType: RewardType.FrontierAdvance,
      contributionCid: improved.cid,
      amount: 1,
      recipient: { agentId: "agent-new" },
    });

    await service.evaluateContribution(improved);

    expect(await creditsService.balance("agent-new")).toEqual({
      available: 1,
      reserved: 0,
      total: 1,
    });
    expect(await bountyStore.listRewards({ contributionCid: improved.cid })).toHaveLength(1);
  });

  test("does not reward exploration or non-improving contributions", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup({
      eligibleMetrics: ["accuracy"],
    });
    const strong = makeContribution({
      summary: "strong accuracy",
      agent: makeAgent({ agentId: "agent-strong" }),
      scores: { accuracy: { value: 0.95, direction: ScoreDirection.Maximize } },
    });
    const weak = makeContribution({
      summary: "weak accuracy",
      agent: makeAgent({ agentId: "agent-weak" }),
      scores: { accuracy: { value: 0.9, direction: ScoreDirection.Maximize } },
    });
    const exploration = makeContribution({
      summary: "exploration accuracy",
      mode: ContributionMode.Exploration,
      agent: makeAgent({ agentId: "agent-explorer" }),
      scores: { accuracy: { value: 1, direction: ScoreDirection.Maximize } },
    });
    await contributionStore.put(strong);
    await contributionStore.put(weak);
    await contributionStore.put(exploration);

    await service.evaluateContribution(weak);
    await service.evaluateContribution(exploration);

    expect(await bountyStore.listRewards()).toHaveLength(0);
    expect(await creditsService.balance("agent-weak")).toEqual({
      available: 0,
      reserved: 0,
      total: 0,
    });
    expect(await creditsService.balance("agent-explorer")).toEqual({
      available: 0,
      reserved: 0,
      total: 0,
    });
  });

  test("pays one reward for the best eligible metric when multiple metrics improve", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup({
      eligibleMetrics: ["accuracy", "throughput"],
      maxRewardAmount: 3,
    });
    const previous = makeContribution({
      summary: "previous metrics",
      agent: makeAgent({ agentId: "agent-old" }),
      scores: {
        accuracy: { value: 0.5, direction: ScoreDirection.Maximize },
        throughput: { value: 5, direction: ScoreDirection.Maximize },
      },
    });
    const improved = makeContribution({
      summary: "improved metrics",
      agent: makeAgent({ agentId: "agent-new" }),
      scores: {
        accuracy: { value: 0.6, direction: ScoreDirection.Maximize },
        throughput: { value: 8, direction: ScoreDirection.Maximize },
      },
    });
    await contributionStore.put(previous);
    await contributionStore.put(improved);

    await service.evaluateContribution(improved);

    expect(await creditsService.balance("agent-new")).toEqual({
      available: 3,
      reserved: 0,
      total: 3,
    });
    const rewards = await bountyStore.listRewards({ contributionCid: improved.cid });
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({
      rewardType: RewardType.FrontierAdvance,
      contributionCid: improved.cid,
      amount: 3,
      recipient: { agentId: "agent-new" },
    });
  });

  test("caps eligible metric rewards to one credit by default", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup({
      eligibleMetrics: ["throughput"],
    });
    const previous = makeContribution({
      summary: "previous throughput",
      agent: makeAgent({ agentId: "agent-old" }),
      scores: { throughput: { value: 1, direction: ScoreDirection.Maximize } },
    });
    const improved = makeContribution({
      summary: "improved throughput",
      agent: makeAgent({ agentId: "agent-new" }),
      scores: { throughput: { value: 100, direction: ScoreDirection.Maximize } },
    });
    await contributionStore.put(previous);
    await contributionStore.put(improved);

    await service.evaluateContribution(improved);

    const rewards = await bountyStore.listRewards({ contributionCid: improved.cid });
    expect(rewards).toHaveLength(1);
    expect(rewards[0]?.amount).toBe(1);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: 1,
      reserved: 0,
      total: 1,
    });
  });

  test("rejects non-positive max reward amounts", () => {
    const { contributionStore, bountyStore, creditsService } = setup();

    expect(
      () =>
        new FrontierRewardService({
          frontier: new DefaultFrontierCalculator(contributionStore),
          bountyStore,
          creditsService,
          eligibleMetrics: ["accuracy"],
          maxRewardAmount: 0,
        }),
    ).toThrow(/maxRewardAmount/);
  });

  test("concurrent metric-specific evaluators share one contribution-level reward", async () => {
    const { contributionStore, bountyStore, creditsService } = setup();
    const previous = makeContribution({
      summary: "previous metrics",
      agent: makeAgent({ agentId: "agent-old" }),
      scores: {
        accuracy: { value: 0.5, direction: ScoreDirection.Maximize },
        throughput: { value: 5, direction: ScoreDirection.Maximize },
      },
    });
    const improved = makeContribution({
      summary: "improved metrics",
      agent: makeAgent({ agentId: "agent-new" }),
      scores: {
        accuracy: { value: 1.5, direction: ScoreDirection.Maximize },
        throughput: { value: 8, direction: ScoreDirection.Maximize },
      },
    });
    await contributionStore.put(previous);
    await contributionStore.put(improved);

    const accuracyService = new FrontierRewardService({
      frontier: new StaticFrontierCalculator({
        byMetric: {
          accuracy: [
            { cid: improved.cid, summary: improved.summary, value: 1.5, contribution: improved },
            { cid: previous.cid, summary: previous.summary, value: 0.5, contribution: previous },
          ],
        },
        byAdoption: [],
        byRecency: [],
        byReviewScore: [],
        byReproduction: [],
      }),
      bountyStore,
      creditsService,
      eligibleMetrics: ["accuracy"],
    });
    const throughputService = new FrontierRewardService({
      frontier: new StaticFrontierCalculator({
        byMetric: {
          throughput: [
            { cid: improved.cid, summary: improved.summary, value: 8, contribution: improved },
            { cid: previous.cid, summary: previous.summary, value: 5, contribution: previous },
          ],
        },
        byAdoption: [],
        byRecency: [],
        byReviewScore: [],
        byReproduction: [],
      }),
      bountyStore,
      creditsService,
      eligibleMetrics: ["throughput"],
      maxRewardAmount: 3,
    });

    await Promise.all([
      accuracyService.evaluateContribution(improved),
      throughputService.evaluateContribution(improved),
    ]);

    const rewards = await bountyStore.listRewards({ contributionCid: improved.cid });
    expect(rewards).toHaveLength(1);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: rewards[0]?.amount,
      reserved: 0,
      total: rewards[0]?.amount,
    });
  });

  test("does not reward a first-ever metric with no previous frontier entry", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup({
      eligibleMetrics: ["attacker_controlled_metric"],
    });
    const contribution = makeContribution({
      summary: "new metric",
      agent: makeAgent({ agentId: "agent-new" }),
      scores: {
        attacker_controlled_metric: { value: 1, direction: ScoreDirection.Maximize },
      },
    });
    await contributionStore.put(contribution);

    await service.evaluateContribution(contribution);

    expect(await bountyStore.listRewards({ contributionCid: contribution.cid })).toHaveLength(0);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: 0,
      reserved: 0,
      total: 0,
    });
  });

  test("does not reward when eligible metrics are absent", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup();
    const previous = makeContribution({
      summary: "previous accuracy",
      agent: makeAgent({ agentId: "agent-old" }),
      scores: { accuracy: { value: 0.5, direction: ScoreDirection.Maximize } },
    });
    const improved = makeContribution({
      summary: "improved accuracy",
      agent: makeAgent({ agentId: "agent-new" }),
      scores: { accuracy: { value: 0.9, direction: ScoreDirection.Maximize } },
    });
    await contributionStore.put(previous);
    await contributionStore.put(improved);

    await service.evaluateContribution(improved);

    expect(await bountyStore.listRewards({ contributionCid: improved.cid })).toHaveLength(0);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: 0,
      reserved: 0,
      total: 0,
    });
  });

  test("does not reward an ineligible self-reported metric with a huge improvement", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup({
      eligibleMetrics: ["accuracy"],
      maxRewardAmount: 10,
    });
    const previous = makeContribution({
      summary: "previous fake metric",
      agent: makeAgent({ agentId: "agent-old" }),
      scores: {
        fake_metric: { value: 1, direction: ScoreDirection.Maximize },
      },
    });
    const improved = makeContribution({
      summary: "improved fake metric",
      agent: makeAgent({ agentId: "agent-new" }),
      scores: {
        fake_metric: { value: 1_000_000, direction: ScoreDirection.Maximize },
      },
    });
    await contributionStore.put(previous);
    await contributionStore.put(improved);

    await service.evaluateContribution(improved);

    expect(await bountyStore.listRewards({ contributionCid: improved.cid })).toHaveLength(0);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: 0,
      reserved: 0,
      total: 0,
    });
  });

  test("records reward intent before transfer and retries the deterministic transfer", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup({
      rewardTreasuryBalance: 0,
      eligibleMetrics: ["accuracy"],
    });
    const previous = makeContribution({
      summary: "previous accuracy",
      agent: makeAgent({ agentId: "agent-old" }),
      scores: { accuracy: { value: 0.9, direction: ScoreDirection.Maximize } },
    });
    const improved = makeContribution({
      summary: "improved accuracy",
      agent: makeAgent({ agentId: "agent-new" }),
      scores: { accuracy: { value: 0.95, direction: ScoreDirection.Maximize } },
    });
    await contributionStore.put(previous);
    await contributionStore.put(improved);

    await expect(service.evaluateContribution(improved)).rejects.toThrow(/insufficient/i);

    const rewardsAfterFailure = await bountyStore.listRewards({ contributionCid: improved.cid });
    expect(rewardsAfterFailure).toHaveLength(1);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: 0,
      reserved: 0,
      total: 0,
    });

    creditsService.seed("system:frontier-rewards", 100);
    await service.evaluateContribution(improved);

    expect(await bountyStore.listRewards({ contributionCid: improved.cid })).toHaveLength(1);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: 1,
      reserved: 0,
      total: 1,
    });
  });
});

class StaticFrontierCalculator implements FrontierCalculator {
  constructor(private readonly frontier: Frontier) {}

  async compute(): Promise<Frontier> {
    return this.frontier;
  }
}
