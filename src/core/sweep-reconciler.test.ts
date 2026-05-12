/**
 * Tests for the SweepReconciler framework and sweep strategies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalRuntime } from "../local/runtime.js";
import { BountyStatus } from "./bounty.js";
import { BountyIndexSweep } from "./bounty-index-sweep.js";
import { HandoffSweep } from "./handoff-sweep.js";
import type { InMemoryCreditsService } from "./in-memory-credits.js";
import {
  claimBountyOperation,
  createBountyOperation,
  settleBountyOperation,
} from "./operations/bounty.js";
import { contributeOperation } from "./operations/contribute.js";
import type { OperationDeps } from "./operations/deps.js";
import type { TestOperationDeps } from "./operations/test-helpers.js";
import { createTestOperationDeps } from "./operations/test-helpers.js";
import { SettlementSweep } from "./settlement-sweep.js";
import type { SweepResult, SweepStrategy } from "./sweep-reconciler.js";
import { SweepReconciler } from "./sweep-reconciler.js";
import { makeBounty, makeContribution } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// SweepReconciler framework tests
// ---------------------------------------------------------------------------

describe("SweepReconciler", () => {
  test("starts and stops without strategies", () => {
    const sr = new SweepReconciler({ intervalMs: 10_000 });
    expect(sr.isRunning).toBe(false);
    expect(sr.strategyCount).toBe(0);
    sr.start();
    expect(sr.isRunning).toBe(true);
    sr.stop();
    expect(sr.isRunning).toBe(false);
  });

  test("start is idempotent", () => {
    const sr = new SweepReconciler({ intervalMs: 10_000 });
    sr.start();
    sr.start(); // should not create a second timer
    expect(sr.isRunning).toBe(true);
    sr.stop();
  });

  test("registers and runs strategies", async () => {
    const results: SweepResult[] = [];
    const strategy: SweepStrategy = {
      name: "TestSweep",
      async sweep() {
        return { strategy: "TestSweep", found: 3, repaired: 2, errors: [] };
      },
    };

    const sr = new SweepReconciler({
      onCycle: (r) => results.push(...r),
    });
    sr.register(strategy);
    expect(sr.strategyCount).toBe(1);

    await sr.runCycle();

    expect(results).toHaveLength(1);
    expect(results[0]?.strategy).toBe("TestSweep");
    expect(results[0]?.found).toBe(3);
    expect(results[0]?.repaired).toBe(2);
  });

  test("catches strategy throws and reports via onError", async () => {
    const errors: unknown[] = [];
    const strategy: SweepStrategy = {
      name: "ThrowingSweep",
      async sweep() {
        throw new Error("boom");
      },
    };

    const sr = new SweepReconciler({
      onError: (e) => errors.push(e),
    });
    sr.register(strategy);

    const results = await sr.runCycle();

    expect(results).toHaveLength(1);
    expect(results[0]?.errors).toHaveLength(1);
    expect(results[0]?.errors[0]?.message).toBe("boom");
    expect(errors).toHaveLength(1);
  });

  test("runs multiple strategies sequentially", async () => {
    const order: string[] = [];

    const sr = new SweepReconciler();
    sr.register({
      name: "First",
      async sweep() {
        order.push("first");
        return { strategy: "First", found: 0, repaired: 0, errors: [] };
      },
    });
    sr.register({
      name: "Second",
      async sweep() {
        order.push("second");
        return { strategy: "Second", found: 0, repaired: 0, errors: [] };
      },
    });

    await sr.runCycle();
    expect(order).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// BountyIndexSweep tests
// ---------------------------------------------------------------------------

describe("BountyIndexSweep", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("reports zero issues on empty store", async () => {
    const sweep = new BountyIndexSweep(deps.bountyStore!);
    const result = await sweep.sweep();

    expect(result.strategy).toBe("BountyIndexSweep");
    expect(result.found).toBe(0);
    expect(result.repaired).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("reports zero issues when bounties are consistent", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("agent-1", 5000);

    await createBountyOperation(
      {
        title: "Bounty A",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    await createBountyOperation(
      {
        title: "Bounty B",
        amount: 200,
        criteria: { description: "work" },
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    const sweep = new BountyIndexSweep(deps.bountyStore!);
    const result = await sweep.sweep();

    expect(result.found).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SettlementSweep tests
// ---------------------------------------------------------------------------

describe("SettlementSweep", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("reports zero issues when no pending_settlement bounties exist", async () => {
    const sweep = new SettlementSweep(deps.bountyStore!, deps.creditsService);
    const result = await sweep.sweep();

    expect(result.strategy).toBe("SettlementSweep");
    expect(result.found).toBe(0);
    expect(result.repaired).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("recovers escrowed pending_settlement bounties after runtime restart", async () => {
    const previousInitialBalance = process.env.GROVE_CREDITS_INITIAL_BALANCE;
    const previousTreasuryBalance = process.env.GROVE_CREDITS_REWARD_TREASURY_BALANCE;
    const rootDir = await mkdtemp(join(tmpdir(), "grove-settlement-restart-"));
    const groveDir = join(rootDir, ".grove");

    try {
      delete process.env.GROVE_CREDITS_INITIAL_BALANCE;
      delete process.env.GROVE_CREDITS_REWARD_TREASURY_BALANCE;

      await mkdir(groveDir, { recursive: true });
      const first = createLocalRuntime({
        groveDir,
        frontierCacheTtlMs: 0,
        workspace: false,
        parseContract: false,
      });
      let bountyId = "";
      try {
        const contribution = makeContribution({
          summary: "Restart-settlement fulfillment",
          agent: { agentId: "worker" },
        });
        await first.contributionStore.put(contribution);
        const created = await createBountyOperation(
          {
            title: "Restart settlement bounty",
            amount: 100,
            criteria: { description: "any work" },
            agent: { agentId: "creator" },
          },
          {
            contributionStore: first.contributionStore,
            claimStore: first.claimStore,
            bountyStore: first.bountyStore,
            creditsService: first.creditsService,
          },
        );
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        bountyId = created.value.bountyId;
        const claimed = await claimBountyOperation(
          { bountyId, agent: { agentId: "worker" } },
          {
            claimStore: first.claimStore,
            bountyStore: first.bountyStore,
          },
        );
        expect(claimed.ok).toBe(true);
        await first.bountyStore.beginSettlement(bountyId, contribution.cid);
      } finally {
        first.close();
      }

      const second = createLocalRuntime({
        groveDir,
        frontierCacheTtlMs: 0,
        workspace: false,
        parseContract: false,
      });
      try {
        const sweep = new SettlementSweep(second.bountyStore, second.creditsService);
        const result = await sweep.sweep();
        expect(result.found).toBe(1);
        expect(result.repaired).toBe(1);
        expect(result.errors).toEqual([]);
        expect((await second.bountyStore.getBounty(bountyId))?.status).toBe("settled");
        expect(await second.creditsService.balance("creator")).toEqual({
          available: 9900,
          reserved: 0,
          total: 9900,
        });
        expect(await second.creditsService.balance("worker")).toEqual({
          available: 10100,
          reserved: 0,
          total: 10100,
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

  test("resumes a pending_settlement bounty to settled", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    // Create → claim → contribute
    const bounty = await createBountyOperation(
      {
        title: "Stalled settle",
        amount: 100,
        criteria: { description: "Any", requiredTags: ["fix"] },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "worker" } },
      deps,
    );
    const contrib = await contributeOperation(
      { kind: "work", summary: "Fix", tags: ["fix"], agent: { agentId: "worker" } },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    // Simulate: settle starts, pivot succeeds, but capture fails
    (deps.creditsService as InMemoryCreditsService).setFailures({
      capture: new Error("Simulated"),
    });
    const failedSettle = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(failedSettle.ok).toBe(false);

    // Verify stuck in pending_settlement
    const stuck = await deps.bountyStore!.getBounty(bounty.value.bountyId);
    expect(stuck?.status).toBe("pending_settlement");

    // Clear failure and run the sweep
    (deps.creditsService as InMemoryCreditsService).setFailures({});
    const sweep = new SettlementSweep(deps.bountyStore!, deps.creditsService);
    const result = await sweep.sweep();

    expect(result.found).toBe(1);
    expect(result.repaired).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify bounty is now settled
    const settled = await deps.bountyStore!.getBounty(bounty.value.bountyId);
    expect(settled?.status).toBe("settled");
  });

  test("does not complete pending_settlement bounty without fulfilledByCid", async () => {
    await deps.bountyStore!.createBounty(
      makeBounty({
        bountyId: "pending-without-fulfillment",
        status: BountyStatus.PendingSettlement,
        claimedBy: { agentId: "worker" },
        fulfilledByCid: undefined,
      }),
    );

    const sweep = new SettlementSweep(deps.bountyStore!, deps.creditsService);
    const result = await sweep.sweep();

    expect(result.found).toBe(1);
    expect(result.repaired).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("fulfilledByCid");

    const after = await deps.bountyStore!.getBounty("pending-without-fulfillment");
    expect(after?.status).toBe("pending_settlement");
    expect(after?.fulfilledByCid).toBeUndefined();
  });

  test("reports error when resume fails", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Permanent fail",
        amount: 100,
        criteria: { description: "Any", requiredTags: ["fix"] },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "worker" } },
      deps,
    );
    const contrib = await contributeOperation(
      { kind: "work", summary: "Fix", tags: ["fix"], agent: { agentId: "worker" } },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    // Get into pending_settlement
    (deps.creditsService as InMemoryCreditsService).setFailures({
      capture: new Error("Simulated"),
    });
    await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );

    // Run sweep with capture STILL failing
    const sweep = new SettlementSweep(deps.bountyStore!, deps.creditsService);
    const result = await sweep.sweep();

    expect(result.found).toBe(1);
    expect(result.repaired).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Simulated");
  });
});

// ---------------------------------------------------------------------------
// HandoffSweep tests
// ---------------------------------------------------------------------------

describe("HandoffSweep", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("reports zero issues on empty store", async () => {
    const sweep = new HandoffSweep(deps.contributionStore!, deps.handoffStore!);
    const result = await sweep.sweep();

    expect(result.strategy).toBe("HandoffSweep");
    expect(result.found).toBe(0);
    expect(result.repaired).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("detects contributions without handoffs", async () => {
    // Create a "work" contribution directly (no handoff fan-out since no topology)
    await contributeOperation(
      { kind: "work", summary: "Orphaned work", agent: { agentId: "worker" } },
      deps,
    );

    const sweep = new HandoffSweep(deps.contributionStore!, deps.handoffStore!);
    const result = await sweep.sweep();

    // The contribution has kind "work" (handoff-eligible) but no handoffs
    expect(result.found).toBe(1);
    // Detection-only — no repair
    expect(result.repaired).toBe(0);
  });
});
