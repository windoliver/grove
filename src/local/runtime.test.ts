import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RewardType } from "../core/bounty.js";
import { ScoreDirection } from "../core/models.js";
import { makeClaim, makeContribution } from "../core/test-helpers.js";
import type { WorkBlock } from "../core/timeline.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../core/timeline.js";
import { WatchHub } from "../core/watch-hub.js";
import { createLocalRuntime } from "./runtime.js";

describe("createLocalRuntime", () => {
  test("provides frontierRewardService from the local runtime", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-frontier-reward-"));
    const groveDir = join(rootDir, ".grove");

    try {
      await mkdir(groveDir, { recursive: true });
      const runtime = createLocalRuntime({
        groveDir,
        parseContract: false,
      });
      try {
        expect(runtime.frontierRewardService).toBeDefined();
      } finally {
        runtime.close();
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("frontierRewardService does not pay rewards without eligible contract metrics", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-frontier-reward-empty-"));
    const groveDir = join(rootDir, ".grove");

    try {
      await mkdir(groveDir, { recursive: true });
      const runtime = createLocalRuntime({
        groveDir,
        parseContract: false,
        frontierCacheTtlMs: 0,
      });
      try {
        const previous = makeContribution({
          summary: "previous accuracy",
          scores: { accuracy: { value: 0.5, direction: ScoreDirection.Maximize } },
        });
        const improved = makeContribution({
          summary: "improved accuracy",
          scores: { accuracy: { value: 0.9, direction: ScoreDirection.Maximize } },
        });
        await runtime.contributionStore.put(previous);
        await runtime.contributionStore.put(improved);

        await runtime.frontierRewardService.evaluateContribution(improved);

        expect(
          await runtime.bountyStore.listRewards({ rewardType: RewardType.FrontierAdvance }),
        ).toEqual([]);
      } finally {
        runtime.close();
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("frontierRewardService uses GROVE.md metric directions as eligible metrics", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-frontier-reward-metric-"));
    const groveDir = join(rootDir, ".grove");

    try {
      await mkdir(groveDir, { recursive: true });
      await Bun.write(
        join(rootDir, "GROVE.md"),
        `---
contract_version: 1
name: runtime-reward-test
metrics:
  accuracy:
    direction: maximize
---
# Runtime reward test
`,
      );
      const runtime = createLocalRuntime({
        groveDir,
        frontierCacheTtlMs: 0,
      });
      try {
        const previous = makeContribution({
          summary: "previous eligible accuracy",
          scores: { accuracy: { value: 0.5, direction: ScoreDirection.Maximize } },
        });
        const improved = makeContribution({
          summary: "improved eligible accuracy",
          scores: { accuracy: { value: 0.9, direction: ScoreDirection.Maximize } },
        });
        await runtime.contributionStore.put(previous);
        await runtime.contributionStore.put(improved);

        await runtime.frontierRewardService.evaluateContribution(improved);

        const rewards = await runtime.bountyStore.listRewards({
          rewardType: RewardType.FrontierAdvance,
          contributionCid: improved.cid,
        });
        expect(rewards).toHaveLength(1);
        expect(rewards[0]?.recipient.agentId).toBe(improved.agent.agentId);
      } finally {
        runtime.close();
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("provides durable creditsService from the local runtime", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-credits-"));
    const groveDir = join(rootDir, ".grove");
    const previousInitialBalance = process.env.GROVE_CREDITS_INITIAL_BALANCE;
    const previousTreasuryBalance = process.env.GROVE_CREDITS_REWARD_TREASURY_BALANCE;

    try {
      delete process.env.GROVE_CREDITS_INITIAL_BALANCE;
      delete process.env.GROVE_CREDITS_REWARD_TREASURY_BALANCE;

      await mkdir(groveDir, { recursive: true });
      const first = createLocalRuntime({
        groveDir,
        parseContract: false,
      });
      try {
        await first.creditsService.transfer({
          transferId: "runtime-xfer",
          fromAgentId: "agent-a",
          toAgentId: "agent-b",
          amount: 50,
        });
      } finally {
        first.close();
      }

      const second = createLocalRuntime({
        groveDir,
        parseContract: false,
      });
      try {
        expect(await second.creditsService.balance("agent-a")).toEqual({
          available: 9950,
          reserved: 0,
          total: 9950,
        });
        expect(await second.creditsService.balance("agent-b")).toEqual({
          available: 10050,
          reserved: 0,
          total: 10050,
        });
      } finally {
        second.close();
      }
    } finally {
      if (previousInitialBalance === undefined) {
        delete process.env.GROVE_CREDITS_INITIAL_BALANCE;
      } else {
        process.env.GROVE_CREDITS_INITIAL_BALANCE = previousInitialBalance;
      }
      if (previousTreasuryBalance === undefined) {
        delete process.env.GROVE_CREDITS_REWARD_TREASURY_BALANCE;
      } else {
        process.env.GROVE_CREDITS_REWARD_TREASURY_BALANCE = previousTreasuryBalance;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("falls back to GROVE.md for configless sessions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-"));
    const groveDir = join(rootDir, ".grove");
    const previousSessionId = process.env.GROVE_SESSION_ID;

    try {
      await mkdir(groveDir, { recursive: true });
      await Bun.write(
        join(rootDir, "GROVE.md"),
        `---
contract_version: 1
name: runtime-fallback-test
---
# Runtime fallback test
`,
      );

      const seedRuntime = createLocalRuntime({
        groveDir,
        parseContract: false,
      });
      const session = await seedRuntime.goalSessionStore.createSession({
        goal: "configless session",
      });
      seedRuntime.close();

      process.env.GROVE_SESSION_ID = session.id;

      const runtime = createLocalRuntime({ groveDir });
      try {
        expect(runtime.contract?.contractVersion).toBe(1);
        expect(runtime.contract?.name).toBe("runtime-fallback-test");
      } finally {
        runtime.close();
      }
    } finally {
      if (previousSessionId === undefined) {
        delete process.env.GROVE_SESSION_ID;
      } else {
        process.env.GROVE_SESSION_ID = previousSessionId;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("watchHub republishes contribution, claim, and timeline writes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-watch-"));
    const groveDir = join(rootDir, ".grove");
    const NS = "test-ns";

    try {
      await mkdir(groveDir, { recursive: true });
      const hub = new WatchHub();
      const runtime = createLocalRuntime({
        groveDir,
        parseContract: false,
        watchHub: hub,
        watchNamespace: NS,
      });
      try {
        const c = makeContribution({ summary: "watch-c-1" });
        await runtime.contributionStore.put(c);
        expect(hub.currentRv(NS, "Contribution")).toBe(1n);

        const claim = makeClaim({ targetRef: "watch-c-target" });
        await runtime.claimStore.createClaim(claim);
        expect(hub.currentRv(NS, "Claim")).toBe(1n);

        await runtime.claimStore.complete(claim.claimId);
        expect(hub.currentRv(NS, "Claim")).toBe(2n);

        const block: WorkBlock = {
          workBlockId: "wb-runtime-watch",
          sessionId: "session-runtime-watch",
          goal: "Publish timeline writes",
          actor: { agentId: "runtime-agent", role: "tester", platform: "codex" },
          origin: WorkBlockOrigin.Agent,
          status: WorkBlockStatus.Running,
          updatedAt: "2026-05-13T12:00:00.000Z",
          inputRefs: [],
          outputRefs: [],
          evidenceRefs: [],
          approvalRefs: [],
          contributionCids: [],
          artifactHashes: [],
          claimIds: [],
          revision: 1,
          createdAt: "2026-05-13T12:00:00.000Z",
        };
        await runtime.timelineStore.putWorkBlock(block);
        expect(hub.currentRv(NS, "WorkBlock")).toBe(1n);

        const eventInput = {
          eventId: "te-runtime-watch",
          sessionId: "session-runtime-watch",
          type: TimelineEventType.WorkBlockStarted,
          occurredAt: "2026-05-13T12:00:00.000Z",
          actor: { agentId: "runtime-agent", role: "tester", platform: "codex" },
          workBlockId: "wb-runtime-watch",
          targetRefs: [{ kind: "WorkBlock", id: "wb-runtime-watch" }],
          payload: {},
        } as const;
        await runtime.timelineStore.appendTimelineEvent(eventInput);
        await runtime.timelineStore.appendTimelineEvent(eventInput);
        expect(hub.currentRv(NS, "TimelineEvent")).toBe(1n);
      } finally {
        runtime.close();
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("watchHub without watchNamespace throws", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-watch-bad-"));
    const groveDir = join(rootDir, ".grove");
    try {
      await mkdir(groveDir, { recursive: true });
      const hub = new WatchHub();
      expect(() =>
        createLocalRuntime({
          groveDir,
          parseContract: false,
          watchHub: hub,
        }),
      ).toThrow(/watchNamespace is required/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
