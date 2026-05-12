import type { RewardRecord } from "./bounty.js";
import { RewardType } from "./bounty.js";
import { computeRewardId } from "./bounty-logic.js";
import type { BountyStore } from "./bounty-store.js";
import type { CreditsService } from "./credits.js";
import { FRONTIER_REWARD_TREASURY_AGENT_ID } from "./credits-constants.js";
import type { FrontierCalculator, FrontierEntry } from "./frontier.js";
import type { Contribution, Score, ScoreDirection } from "./models.js";
import { ContributionMode } from "./models.js";

export interface FrontierRewardServiceOptions {
  readonly frontier: FrontierCalculator;
  readonly bountyStore: BountyStore;
  readonly creditsService: CreditsService;
  readonly treasuryAgentId?: string | undefined;
  readonly eligibleMetrics?: Readonly<Record<string, ScoreDirection>> | undefined;
  readonly maxRewardAmount?: number | undefined;
}

export class FrontierRewardService {
  private readonly frontier: FrontierCalculator;
  private readonly bountyStore: BountyStore;
  private readonly creditsService: CreditsService;
  private readonly treasuryAgentId: string;
  private readonly eligibleMetrics: ReadonlyMap<string, ScoreDirection>;
  private readonly maxRewardAmount: number;

  constructor(options: FrontierRewardServiceOptions) {
    const maxRewardAmount = options.maxRewardAmount ?? 1;
    if (!Number.isInteger(maxRewardAmount) || maxRewardAmount <= 0) {
      throw new Error("maxRewardAmount must be a positive integer");
    }

    this.frontier = options.frontier;
    this.bountyStore = options.bountyStore;
    this.creditsService = options.creditsService;
    this.treasuryAgentId = options.treasuryAgentId ?? FRONTIER_REWARD_TREASURY_AGENT_ID;
    this.eligibleMetrics = new Map(Object.entries(options.eligibleMetrics ?? {}));
    this.maxRewardAmount = maxRewardAmount;
  }

  async evaluateContribution(contribution: Contribution): Promise<void> {
    if (
      contribution.mode === ContributionMode.Exploration ||
      contribution.context?.ephemeral === true
    ) {
      return;
    }
    if (this.eligibleMetrics.size === 0) {
      return;
    }

    const scores = contribution.scores;
    if (scores === undefined || Object.keys(scores).length === 0) {
      return;
    }

    const existingReward = await this.existingFrontierReward(contribution);
    if (existingReward !== undefined) {
      if (existingReward.transferId !== undefined) {
        await this.creditsService.transfer({
          transferId: existingReward.transferId,
          fromAgentId: this.treasuryAgentId,
          toAgentId: contribution.agent.agentId,
          amount: existingReward.amount,
        });
      }
      return;
    }

    const frontier = await this.frontier.compute({ limit: 50 });
    const rewardId = computeRewardId(
      RewardType.FrontierAdvance,
      `frontier:${contribution.agent.agentId}`,
      contribution.cid,
    );
    if (await this.bountyStore.hasReward(rewardId)) {
      await this.transferExistingReward(contribution);
      return;
    }

    const candidates: RewardCandidate[] = [];
    for (const [metric, score] of Object.entries(scores)) {
      const expectedDirection = this.eligibleMetrics.get(metric);
      if (expectedDirection === undefined || score.direction !== expectedDirection) {
        continue;
      }

      const entries = frontier.byMetric[metric];
      if (entries === undefined) {
        continue;
      }

      const current = entries.find((entry) => entry.cid === contribution.cid);
      if (current === undefined) {
        continue;
      }

      const previous = entries.find((entry) => entry.cid !== contribution.cid);
      if (previous === undefined) {
        continue;
      }

      const improvement = this.improvement(score, previous, expectedDirection);
      if (improvement <= 0) {
        continue;
      }

      const amount = Math.min(this.maxRewardAmount, Math.max(1, Math.ceil(improvement)));
      const transferId = `reward:${rewardId}`;
      candidates.push({ metric, amount, transferId });
    }

    const selected = candidates.slice().sort((a, b) => {
      const amountDiff = b.amount - a.amount;
      if (amountDiff !== 0) return amountDiff;
      return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
    })[0];
    if (selected === undefined) {
      return;
    }

    await this.bountyStore.recordReward({
      rewardId,
      rewardType: RewardType.FrontierAdvance,
      recipient: contribution.agent,
      contributionCid: contribution.cid,
      amount: selected.amount,
      transferId: selected.transferId,
      createdAt: new Date().toISOString(),
    });
    await this.transferExistingReward(contribution);
  }

  private async transferExistingReward(contribution: Contribution): Promise<void> {
    const reward = await this.existingFrontierReward(contribution);
    if (reward?.transferId === undefined) {
      return;
    }
    await this.creditsService.transfer({
      transferId: reward.transferId,
      fromAgentId: this.treasuryAgentId,
      toAgentId: contribution.agent.agentId,
      amount: reward.amount,
    });
  }

  private async existingFrontierReward(
    contribution: Contribution,
  ): Promise<RewardRecord | undefined> {
    const rewards = await this.bountyStore.listRewards({
      rewardType: RewardType.FrontierAdvance,
      contributionCid: contribution.cid,
    });
    return rewards.find((reward) => reward.recipient.agentId === contribution.agent.agentId);
  }

  private improvement(score: Score, previous: FrontierEntry, direction: ScoreDirection): number {
    if (direction === "maximize") {
      return score.value - previous.value;
    }
    return previous.value - score.value;
  }
}

interface RewardCandidate {
  readonly metric: string;
  readonly amount: number;
  readonly transferId: string;
}
