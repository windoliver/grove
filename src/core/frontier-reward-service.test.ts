import { afterEach, describe, expect, test } from "bun:test";

import { SqliteBountyStore } from "../local/sqlite-bounty-store.js";
import { SqliteCreditsService } from "../local/sqlite-credits-service.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";
import { RewardType } from "./bounty.js";
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

  function setup(options?: { readonly rewardTreasuryBalance?: number | undefined }): {
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
    });

    return { contributionStore, bountyStore, creditsService, service };
  }

  test("pays and records one reward when a contribution advances a minimized metric", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup();
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
    const { contributionStore, bountyStore, creditsService, service } = setup();
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
    const { contributionStore, bountyStore, creditsService, service } = setup();
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

  test("does not reward a first-ever metric with no previous frontier entry", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup();
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

  test("records reward intent before transfer and retries the deterministic transfer", async () => {
    const { contributionStore, bountyStore, creditsService, service } = setup({
      rewardTreasuryBalance: 0,
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
