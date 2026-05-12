import { RewardType } from "./bounty.js";
import { computeRewardId } from "./bounty-logic.js";
import type { BountyStore } from "./bounty-store.js";
import type { CreditsService } from "./credits.js";
import { FRONTIER_REWARD_TREASURY_AGENT_ID } from "./credits-constants.js";
import type { FrontierCalculator, FrontierEntry } from "./frontier.js";
import type { Contribution, Score } from "./models.js";
import { ContributionMode } from "./models.js";

export interface FrontierRewardServiceOptions {
  readonly frontier: FrontierCalculator;
  readonly bountyStore: BountyStore;
  readonly creditsService: CreditsService;
  readonly treasuryAgentId?: string | undefined;
}

export class FrontierRewardService {
  private readonly frontier: FrontierCalculator;
  private readonly bountyStore: BountyStore;
  private readonly creditsService: CreditsService;
  private readonly treasuryAgentId: string;

  constructor(options: FrontierRewardServiceOptions) {
    this.frontier = options.frontier;
    this.bountyStore = options.bountyStore;
    this.creditsService = options.creditsService;
    this.treasuryAgentId = options.treasuryAgentId ?? FRONTIER_REWARD_TREASURY_AGENT_ID;
  }

  async evaluateContribution(contribution: Contribution): Promise<void> {
    if (
      contribution.mode === ContributionMode.Exploration ||
      contribution.context?.ephemeral === true
    ) {
      return;
    }

    const scores = contribution.scores;
    if (scores === undefined || Object.keys(scores).length === 0) {
      return;
    }

    const frontier = await this.frontier.compute({ limit: 50 });
    for (const [metric, score] of Object.entries(scores)) {
      const entries = frontier.byMetric[metric];
      if (entries === undefined) {
        continue;
      }

      const current = entries.find((entry) => entry.cid === contribution.cid);
      if (current === undefined) {
        continue;
      }

      const previous = entries.find((entry) => entry.cid !== contribution.cid);
      const improvement = this.improvement(score, previous);
      if (improvement <= 0) {
        continue;
      }

      const rewardId = computeRewardId(
        RewardType.FrontierAdvance,
        `frontier:${metric}:${contribution.agent.agentId}`,
        contribution.cid,
      );
      if (await this.bountyStore.hasReward(rewardId)) {
        continue;
      }

      const amount = Math.max(1, Math.ceil(improvement));
      const transferId = `reward:${rewardId}`;
      await this.creditsService.transfer({
        transferId,
        fromAgentId: this.treasuryAgentId,
        toAgentId: contribution.agent.agentId,
        amount,
      });
      await this.bountyStore.recordReward({
        rewardId,
        rewardType: RewardType.FrontierAdvance,
        recipient: contribution.agent,
        contributionCid: contribution.cid,
        amount,
        transferId,
        createdAt: new Date().toISOString(),
      });
    }
  }

  private improvement(score: Score, previous: FrontierEntry | undefined): number {
    if (previous === undefined) {
      return 1;
    }
    if (score.direction === "maximize") {
      return score.value - previous.value;
    }
    return previous.value - score.value;
  }
}
