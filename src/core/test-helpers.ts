/**
 * Shared test fixture factories for Grove core tests.
 *
 * Provides sensible defaults so tests only override the fields they care about.
 * All contributions have valid computed CIDs.
 */

import type { Bounty, RewardRecord } from "./bounty.js";
import { BountyStatus, RewardType } from "./bounty.js";
import { createContribution } from "./manifest.js";
import type {
  AgentIdentity,
  Artifact,
  Claim,
  Contribution,
  ContributionInput,
  Relation,
  Score,
} from "./models.js";
import {
  ClaimStatus,
  ContributionKind,
  ContributionMode,
  RelationType,
  ScoreDirection,
} from "./models.js";

/** Create an AgentIdentity with sensible defaults. */
export function makeAgent(overrides?: Partial<AgentIdentity>): AgentIdentity {
  return {
    agentId: "test-agent",
    ...overrides,
  };
}

/** Create a Relation with sensible defaults. */
export function makeRelation(overrides?: Partial<Relation>): Relation {
  return {
    targetCid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    relationType: RelationType.DerivesFrom,
    ...overrides,
  };
}

/** Create a Score with sensible defaults. */
export function makeScore(overrides?: Partial<Score>): Score {
  return {
    value: 0.95,
    direction: ScoreDirection.Minimize,
    ...overrides,
  };
}

/** Create an Artifact with sensible defaults. */
export function makeArtifact(overrides?: Partial<Artifact>): Artifact {
  return {
    contentHash: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sizeBytes: 1024,
    ...overrides,
  };
}

/** Create a Claim with sensible defaults. */
export function makeClaim(overrides?: Partial<Claim>): Claim {
  const now = new Date().toISOString();
  const leaseExpires = new Date(Date.now() + 300_000).toISOString();
  return {
    claimId: "claim-1",
    targetRef: "target-1",
    agent: makeAgent(),
    status: ClaimStatus.Active,
    intentSummary: "Test claim",
    createdAt: now,
    heartbeatAt: now,
    leaseExpiresAt: leaseExpires,
    ...overrides,
  };
}

/**
 * Create a Contribution with sensible defaults and a valid computed CID.
 * Override any ContributionInput field. The CID is always recomputed.
 */
export function makeContribution(overrides?: Partial<ContributionInput>): Contribution {
  const input: ContributionInput = {
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "Test contribution",
    artifacts: {},
    relations: [],
    tags: [],
    agent: makeAgent(),
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  return createContribution(input);
}

/** Create a Bounty with sensible defaults. */
export function makeBounty(overrides?: Partial<Bounty>): Bounty {
  const now = new Date().toISOString();
  const deadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    bountyId: "bounty-1",
    title: "Improve val_bpb below 0.96",
    description: "Test bounty description",
    status: BountyStatus.Open,
    creator: makeAgent({ agentId: "bounty-creator" }),
    amount: 100,
    criteria: {
      description: "Improve val_bpb metric below 0.96 on H100",
    },
    deadline,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Create a RewardRecord with sensible defaults. */
export function makeReward(overrides?: Partial<RewardRecord>): RewardRecord {
  const now = new Date().toISOString();
  return {
    rewardId: "reward:frontier_advance:source-1:cid-1",
    rewardType: RewardType.FrontierAdvance,
    recipient: makeAgent({ agentId: "reward-recipient" }),
    amount: 10,
    contributionCid: "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    createdAt: now,
    ...overrides,
  };
}
