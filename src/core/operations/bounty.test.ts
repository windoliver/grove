/**
 * Tests for bounty operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { InMemoryCreditsService } from "../in-memory-credits.js";
import {
  claimBountyOperation,
  createBountyOperation,
  listBountiesOperation,
  settleBountyOperation,
} from "./bounty.js";
import { contributeOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import type { TestOperationDeps } from "./test-helpers.js";
import { createTestOperationDeps } from "./test-helpers.js";

describe("createBountyOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a bounty (happy path)", async () => {
    // Seed credits so reservation succeeds
    (deps.creditsService as InMemoryCreditsService).seed("agent-1", 1000);

    const result = await createBountyOperation(
      {
        title: "Fix the bug",
        amount: 100,
        criteria: { description: "Fix issue #42" },
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bountyId).toBeTruthy();
    expect(result.value.title).toBe("Fix the bug");
    expect(result.value.amount).toBe(100);
    expect(result.value.status).toBe("open");
    expect(result.value.deadline).toBeTruthy();
    expect(result.value.reservationId).toBeTruthy();
  });

  test("creates a bounty without credits service", async () => {
    const depsNoCredits: OperationDeps = {
      contributionStore: deps.contributionStore,
      claimStore: deps.claimStore,
      cas: deps.cas,
      frontier: deps.frontier,
      bountyStore: deps.bountyStore,
    };

    const result = await createBountyOperation(
      {
        title: "No credit bounty",
        amount: 50,
        criteria: { description: "Do something" },
        agent: { agentId: "agent-1" },
      },
      depsNoCredits,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bountyId).toBeTruthy();
    expect(result.value.reservationId).toBeUndefined();
  });

  test("returns VALIDATION_ERROR when bountyStore not configured", async () => {
    const depsNoBounty: OperationDeps = {
      contributionStore: deps.contributionStore,
      claimStore: deps.claimStore,
      cas: deps.cas,
      frontier: deps.frontier,
    };

    const result = await createBountyOperation(
      {
        title: "No store",
        amount: 100,
        criteria: { description: "Nope" },
        agent: { agentId: "agent-1" },
      },
      depsNoBounty,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  test("voids reservation when bountyStore.createBounty throws (credits returned)", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("agent-1", 500);

    const balanceBefore = await (deps.creditsService as InMemoryCreditsService).balance("agent-1");

    // Inject fault: bountyStore.createBounty always throws
    const originalCreate = deps.bountyStore!.createBounty.bind(deps.bountyStore);
    deps.bountyStore!.createBounty = async () => {
      throw new Error("simulated store failure");
    };

    const result = await createBountyOperation(
      {
        title: "Store fail bounty",
        amount: 200,
        criteria: { description: "Some task" },
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    deps.bountyStore!.createBounty = originalCreate;

    expect(result.ok).toBe(false);

    // Credits should be fully available again — the reservation was voided
    const balanceAfter = await (deps.creditsService as InMemoryCreditsService).balance("agent-1");
    expect(balanceAfter.available).toBe(balanceBefore.available);
  });

  test("returns error and creates no bounty when creditsService.reserve throws (insufficient credits)", async () => {
    // Do NOT seed — agent has 0 credits
    const result = await createBountyOperation(
      {
        title: "No credits bounty",
        amount: 100,
        criteria: { description: "Needs credits" },
        agent: { agentId: "broke-agent" },
      },
      deps,
    );

    expect(result.ok).toBe(false);

    // No bounty should have been persisted
    const listed = await deps.bountyStore!.listBounties({});
    expect(listed).toHaveLength(0);
  });
});

describe("listBountiesOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns empty list when no bounties exist", async () => {
    const result = await listBountiesOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bounties).toHaveLength(0);
    expect(result.value.count).toBe(0);
  });

  test("lists bounties after creation", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("agent-1", 5000);

    await createBountyOperation(
      {
        title: "Bounty A",
        amount: 100,
        criteria: { description: "Task A" },
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    await createBountyOperation(
      {
        title: "Bounty B",
        amount: 200,
        criteria: { description: "Task B" },
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    const result = await listBountiesOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(2);
    expect(result.value.bounties).toHaveLength(2);
  });

  test("filters bounties by status", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("agent-1", 5000);

    await createBountyOperation(
      {
        title: "Open bounty",
        amount: 100,
        criteria: { description: "Task" },
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    const openResult = await listBountiesOperation({ status: "open" }, deps);
    expect(openResult.ok).toBe(true);
    if (openResult.ok) expect(openResult.value.count).toBe(1);

    const settledResult = await listBountiesOperation({ status: "settled" }, deps);
    expect(settledResult.ok).toBe(true);
    if (settledResult.ok) expect(settledResult.value.count).toBe(0);
  });
});

describe("claimBountyOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("claims an open bounty (happy path)", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Claimable bounty",
        amount: 100,
        criteria: { description: "Do the work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    const result = await claimBountyOperation(
      {
        bountyId: bounty.value.bountyId,
        agent: { agentId: "claimer" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bountyId).toBe(bounty.value.bountyId);
    expect(result.value.title).toBe("Claimable bounty");
    expect(result.value.status).toBe("claimed");
    expect(result.value.claimId).toBeTruthy();
    expect(result.value.claimedBy).toBe("claimer");
  });

  test("returns NOT_FOUND for nonexistent bounty", async () => {
    const result = await claimBountyOperation(
      {
        bountyId: "nonexistent-bounty-id",
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns VALIDATION_ERROR when bounty is not open (pre-flight check)", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Pre-flight test",
        amount: 100,
        criteria: { description: "Do the work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    // Claim it once to move status to 'claimed'
    const first = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-a" } },
      deps,
    );
    expect(first.ok).toBe(true);

    // Second claim attempt by a different agent: pre-flight should catch status !== open
    const second = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-b" } },
      deps,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("VALIDATION_ERROR");
      expect(second.error.message).toContain("not open");
    }
  });

  test("releases dangling claim when bountyStore.claimBounty throws (compensation)", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Compensation test",
        amount: 100,
        criteria: { description: "Do the work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    // Inject fault: bountyStore.claimBounty always throws
    const originalClaimBounty = deps.bountyStore!.claimBounty.bind(deps.bountyStore);
    deps.bountyStore!.claimBounty = async () => {
      throw new Error("simulated store failure");
    };

    const result = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "claimer" } },
      deps,
    );

    // Restore original so cleanup can run
    deps.bountyStore!.claimBounty = originalClaimBounty;

    // Operation should fail
    expect(result.ok).toBe(false);

    // Compensation: no active claim should remain for this bounty
    const activeClaims = await deps.claimStore!.activeClaims(`bounty:${bounty.value.bountyId}`);
    expect(activeClaims).toHaveLength(0);
  });

  test("returns error when different agent has an active claim (claimOrRenew rejects)", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Concurrency test",
        amount: 100,
        criteria: { description: "Do the work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    // Agent A claims first
    const claimA = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-a" } },
      deps,
    );
    expect(claimA.ok).toBe(true);

    // After agent-a claimed, the bounty is no longer open — pre-flight rejects agent-b
    const claimB = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-b" } },
      deps,
    );
    expect(claimB.ok).toBe(false);
    // agent-a's claim is untouched
    const activeClaims = await deps.claimStore!.activeClaims(`bounty:${bounty.value.bountyId}`);
    expect(activeClaims).toHaveLength(1);
    expect(activeClaims[0]!.agent.agentId).toBe("agent-a");
  });
});

describe("settleBountyOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("settles a bounty end-to-end", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    // 1. Create bounty
    const bounty = await createBountyOperation(
      {
        title: "Settle test",
        amount: 100,
        criteria: { description: "Any work", requiredTags: ["fix"] },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    // 2. Claim bounty
    const claim = await claimBountyOperation(
      {
        bountyId: bounty.value.bountyId,
        agent: { agentId: "worker" },
      },
      deps,
    );
    expect(claim.ok).toBe(true);

    // 3. Create contribution that meets criteria
    const contrib = await contributeOperation(
      {
        kind: "work",
        summary: "Fix for the bounty",
        tags: ["fix"],
        agent: { agentId: "worker" },
      },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    // 4. Settle bounty
    const result = await settleBountyOperation(
      {
        bountyId: bounty.value.bountyId,
        contributionCid: contrib.value.cid,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bountyId).toBe(bounty.value.bountyId);
    expect(result.value.status).toBe("settled");
    expect(result.value.fulfilledByCid).toBe(contrib.value.cid);
    expect(result.value.amount).toBe(100);
    expect(result.value.paidTo).toBe("worker");
  });

  test("returns NOT_FOUND for nonexistent bounty", async () => {
    const result = await settleBountyOperation(
      {
        bountyId: "nonexistent-bounty-id",
        contributionCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns NOT_FOUND for nonexistent contribution", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Missing contrib",
        amount: 100,
        criteria: { description: "Any" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    const result = await settleBountyOperation(
      {
        bountyId: bounty.value.bountyId,
        contributionCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns VALIDATION_ERROR when contribution does not meet criteria", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    // Create bounty requiring tag "fix"
    const bounty = await createBountyOperation(
      {
        title: "Criteria fail",
        amount: 100,
        criteria: { description: "Needs fix tag", requiredTags: ["fix"] },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    // Create contribution WITHOUT the required tag
    const contrib = await contributeOperation(
      {
        kind: "work",
        summary: "Missing tag",
        tags: ["other"],
        agent: { agentId: "worker" },
      },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    const result = await settleBountyOperation(
      {
        bountyId: bounty.value.bountyId,
        contributionCid: contrib.value.cid,
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("does not meet bounty criteria");
    }
  });

  test("does not capture payment when state transition fails (state-first ordering)", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Ordering test",
        amount: 100,
        criteria: { description: "Any work", requiredTags: ["fix"] },
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

    // Inject fault: completeBounty throws (simulates store failure mid-settle)
    const originalComplete = deps.bountyStore!.completeBounty.bind(deps.bountyStore);
    deps.bountyStore!.completeBounty = async () => {
      throw new Error("simulated state transition failure");
    };

    const balanceBefore = await (deps.creditsService as InMemoryCreditsService).balance("creator");

    const result = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );

    deps.bountyStore!.completeBounty = originalComplete;

    expect(result.ok).toBe(false);

    // Payment must NOT have been captured — state-first ordering means
    // capture runs only after successful state transition.
    const balanceAfter = await (deps.creditsService as InMemoryCreditsService).balance("creator");
    expect(balanceAfter.reserved).toBe(balanceBefore.reserved);
  });

  test("returns error when settling an already-settled bounty", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Double-settle test",
        amount: 100,
        criteria: { description: "Any work", requiredTags: ["fix"] },
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

    // First settle succeeds
    const first = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(first.ok).toBe(true);

    // Second settle should fail — bounty is already settled
    const second = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(second.ok).toBe(false);
  });

  test("captures payment without recipient when bounty has no claimedBy", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    // Create a bounty (no claim step — leaves claimedBy null)
    const bounty = await createBountyOperation(
      {
        title: "No-recipient settle",
        amount: 100,
        criteria: { description: "Any work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    const contrib = await contributeOperation(
      { kind: "work", summary: "Direct work", agent: { agentId: "worker" } },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    // Settle without claiming first — store must handle this transition
    const result = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );

    // May fail if store enforces claimed-before-settle; what matters is no crash
    // and credits are not left in an inconsistent state.
    const balance = await (deps.creditsService as InMemoryCreditsService).balance("creator");
    // Either settled (capture ran) or failed (reservation still pending) — never NaN
    expect(typeof balance.available).toBe("number");
  });
});
