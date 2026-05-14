/**
 * Tests for bounty operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CasMutationResult } from "../cas.js";
import type { InMemoryCreditsService } from "../in-memory-credits.js";
import {
  type Claim,
  type ClaimSpecRecord,
  type ClaimView,
  claimToSpecRecord,
  claimToStatusRecord,
  claimViewToClaim,
} from "../models.js";
import type {
  ActiveClaimFilter,
  ClaimQuery,
  ClaimStatusPatch,
  ClaimStore,
  ExpiredClaim,
} from "../store.js";
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

class OwnerAwareClaimStore implements ClaimStore {
  private readonly claims = new Map<string, Claim>();

  private viewFromClaim(claim: Claim): ClaimView {
    return {
      spec: claimToSpecRecord(claim),
      status: claimToStatusRecord(claim),
    };
  }

  private putView(view: ClaimView): void {
    this.claims.set(view.spec.id, claimViewToClaim(view));
  }

  async putClaimSpec(spec: ClaimSpecRecord): Promise<CasMutationResult<ClaimView>> {
    const existing = await this.getClaimView(spec.id);
    const now = new Date().toISOString();
    const createdAtMs = Date.parse(spec.createdAt);
    const leaseBaseMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
    const view: ClaimView =
      existing === undefined
        ? {
            spec: {
              ...spec,
              generation: 1,
            },
            status: {
              id: spec.id,
              phase: "active",
              observedGeneration: 0,
              lastHeartbeatAt: now,
              leaseExpiresAt: new Date(
                leaseBaseMs + (spec.leaseDeadlineSec ?? 300) * 1000,
              ).toISOString(),
              conditions: [],
              lastTransitionAt: now,
              attemptCount: 0,
              revision: 1,
            },
          }
        : {
            spec: {
              ...spec,
              createdAt: existing.spec.createdAt,
              generation: existing.spec.generation + 1,
            },
            status: existing.status,
          };
    this.putView(view);
    return { kind: "ok", view };
  }

  async getClaimView(claimId: string): Promise<ClaimView | undefined> {
    const claim = this.claims.get(claimId);
    return claim === undefined ? undefined : this.viewFromClaim(claim);
  }

  async patchClaimStatus(claimId: string, patch: ClaimStatusPatch): Promise<ClaimView> {
    const view = await this.getClaimView(claimId);
    if (view === undefined) throw new Error(`Claim ${claimId} does not exist`);
    const updated: ClaimView = {
      spec: view.spec,
      status: {
        ...view.status,
        phase: patch.phase ?? view.status.phase,
        observedGeneration: patch.observedGeneration ?? view.status.observedGeneration,
        agentSessionId: patch.agentSessionId ?? view.status.agentSessionId,
        lastHeartbeatAt: patch.lastHeartbeatAt ?? view.status.lastHeartbeatAt,
        leaseExpiresAt: patch.leaseExpiresAt ?? view.status.leaseExpiresAt,
        currentContributionCid: patch.currentContributionCid ?? view.status.currentContributionCid,
        conditions: patch.conditions ?? view.status.conditions,
        lastTransitionAt: patch.lastTransitionAt ?? view.status.lastTransitionAt,
        revision: view.status.revision + 1,
      },
    };
    this.putView(updated);
    return updated;
  }

  async createClaim(claim: Claim): Promise<Claim> {
    this.claims.set(claim.claimId, claim);
    return claim;
  }

  async claimOrRenew(claim: Claim): Promise<Claim> {
    for (const existing of this.claims.values()) {
      if (existing.targetRef === claim.targetRef && existing.status === "active") {
        if (existing.agent.agentId !== claim.agent.agentId) {
          throw new Error("target already has an active claim");
        }
        const renewed: Claim = {
          ...existing,
          heartbeatAt: claim.heartbeatAt,
          leaseExpiresAt: claim.leaseExpiresAt,
          intentSummary: claim.intentSummary,
          revision: (existing.revision ?? 1) + 1,
          ...(claim.ownerRef !== undefined ? { ownerRef: claim.ownerRef } : {}),
        };
        this.claims.set(existing.claimId, renewed);
        return renewed;
      }
    }

    const created: Claim = { ...claim, revision: 1 };
    this.claims.set(claim.claimId, created);
    return created;
  }

  async getClaim(claimId: string): Promise<Claim | undefined> {
    return this.claims.get(claimId);
  }

  async heartbeat(claimId: string): Promise<Claim> {
    const claim = this.claims.get(claimId);
    if (claim === undefined) throw new Error(`Claim ${claimId} does not exist`);
    return claim;
  }

  async release(claimId: string): Promise<Claim> {
    const claim = this.claims.get(claimId);
    if (claim === undefined) throw new Error(`Claim ${claimId} does not exist`);
    const released: Claim = { ...claim, status: "released" };
    this.claims.set(claimId, released);
    return released;
  }

  async releaseOwnedBy(): Promise<number> {
    return 0;
  }

  async complete(claimId: string): Promise<Claim> {
    const claim = this.claims.get(claimId);
    if (claim === undefined) throw new Error(`Claim ${claimId} does not exist`);
    const completed: Claim = { ...claim, status: "completed" };
    this.claims.set(claimId, completed);
    return completed;
  }

  async deleteTerminalOwnedBy(): Promise<number> {
    return 0;
  }

  async expireStale(): Promise<readonly ExpiredClaim[]> {
    return [];
  }

  async activeClaims(targetRef?: string): Promise<readonly Claim[]> {
    const active = [...this.claims.values()].filter((claim) => claim.status === "active");
    return targetRef !== undefined
      ? active.filter((claim) => claim.targetRef === targetRef)
      : active;
  }

  async listClaims(_query?: ClaimQuery): Promise<readonly Claim[]> {
    return [...this.claims.values()];
  }

  async cleanCompleted(): Promise<number> {
    return 0;
  }

  async countActiveClaims(filter?: ActiveClaimFilter): Promise<number> {
    const active = await this.activeClaims(filter?.targetRef);
    return filter?.agentId !== undefined
      ? active.filter((claim) => claim.agent.agentId === filter.agentId).length
      : active.length;
  }

  async detectStalled(): Promise<readonly Claim[]> {
    return [];
  }

  async listEntities(): Promise<readonly []> {
    return [];
  }

  close(): void {
    /* no-op */
  }
}

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

  test("dedups repeated identical bounty creates by content hash", async () => {
    const depsNoCredits: OperationDeps = {
      contributionStore: deps.contributionStore,
      claimStore: deps.claimStore,
      cas: deps.cas,
      frontier: deps.frontier,
      bountyStore: deps.bountyStore,
    };

    const input = {
      title: "Retry-safe bounty",
      amount: 50,
      criteria: { description: "Do one specific task" },
      agent: { agentId: "agent-1" },
    };

    const first = await createBountyOperation(input, depsNoCredits);
    const second = await createBountyOperation(input, depsNoCredits);
    const third = await createBountyOperation(input, depsNoCredits);

    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;
    expect(first.value.accepted).toBe(1);
    expect(first.value.duplicate).toBe(0);
    expect(second.value.accepted).toBe(0);
    expect(second.value.duplicate).toBe(1);
    expect(third.value.accepted).toBe(0);
    expect(third.value.duplicate).toBe(1);
    expect(second.value.bountyId).toBe(first.value.bountyId);
    expect(third.value.bountyId).toBe(first.value.bountyId);

    const listed = await listBountiesOperation({}, depsNoCredits);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.count).toBe(1);
  });

  test("voids fresh credit reservations for duplicate bounty creates", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("agent-1", 1000);

    const input = {
      title: "Retry-safe funded bounty",
      amount: 100,
      criteria: { description: "Do one funded task" },
      agent: { agentId: "agent-1" },
    };

    const first = await createBountyOperation(input, deps);
    const second = await createBountyOperation(input, deps);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.accepted).toBe(0);
    expect(second.value.duplicate).toBe(1);
    expect(second.value.bountyId).toBe(first.value.bountyId);

    const balance = await (deps.creditsService as InMemoryCreditsService).balance("agent-1");
    expect(balance.available).toBe(900);
    expect(balance.reserved).toBe(100);
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

  test("claims an open bounty with session ownerRef", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);
    const claimStore = new OwnerAwareClaimStore();
    const ownerRef = { kind: "session" as const, id: "s1", uid: "u1" };

    const bounty = await createBountyOperation(
      {
        title: "Owned bounty claim",
        amount: 100,
        criteria: { description: "Do owned work" },
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
      { ...deps, claimStore, sessionOwnerRef: ownerRef },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await claimStore.getClaim(result.value.claimId);
    expect(stored?.ownerRef).toEqual(ownerRef);
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

    // Must claim before settle (pre-flight check requires "claimed" status)
    const claim = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "worker" } },
      deps,
    );
    expect(claim.ok).toBe(true);

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

    // Must claim before settle (pre-flight check requires "claimed" status)
    await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "worker" } },
      deps,
    );

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
});

// ---------------------------------------------------------------------------
// Input validation edge cases (Issue 7A + 11A)
// ---------------------------------------------------------------------------

describe("createBountyOperation input validation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("rejects zero amount", async () => {
    const result = await createBountyOperation(
      { title: "Zero", amount: 0, criteria: { description: "x" }, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("positive");
    }
  });

  test("rejects negative amount", async () => {
    const result = await createBountyOperation(
      { title: "Neg", amount: -50, criteria: { description: "x" }, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("positive");
    }
  });

  test("rejects empty title", async () => {
    const result = await createBountyOperation(
      { title: "", amount: 100, criteria: { description: "x" }, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("title");
    }
  });

  test("rejects whitespace-only title", async () => {
    const result = await createBountyOperation(
      { title: "   ", amount: 100, criteria: { description: "x" }, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("title");
    }
  });
});

// ---------------------------------------------------------------------------
// Pre-flight status validation (Issue 6A)
// ---------------------------------------------------------------------------

describe("claimBountyOperation status checks", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("rejects claim on already-claimed bounty", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Double claim",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    // First claim succeeds
    const firstClaim = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-a" } },
      deps,
    );
    expect(firstClaim.ok).toBe(true);

    // Second claim should fail with pre-flight check
    const secondClaim = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-b" } },
      deps,
    );
    expect(secondClaim.ok).toBe(false);
    if (!secondClaim.ok) {
      expect(secondClaim.error.code).toBe("VALIDATION_ERROR");
      expect(secondClaim.error.message).toContain("not open");
    }
  });

  test("same agent can renew claim on already-claimed bounty", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Renewable claim",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    // First claim
    const firstClaim = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "worker" } },
      deps,
    );
    expect(firstClaim.ok).toBe(true);
    if (!firstClaim.ok) return;

    // Same agent renews — should succeed
    const renewal = await claimBountyOperation(
      {
        bountyId: bounty.value.bountyId,
        agent: { agentId: "worker" },
        leaseDurationMs: 3_600_000,
      },
      deps,
    );
    expect(renewal.ok).toBe(true);
    if (!renewal.ok) return;
    expect(renewal.value.status).toBe("claimed");
    expect(renewal.value.claimedBy).toBe("worker");
    expect(renewal.value.claimId).toBe(firstClaim.value.claimId);
  });

  test("same agent renewal stamps session ownerRef", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);
    const claimStore = new OwnerAwareClaimStore();
    const ownerRef = { kind: "session" as const, id: "s1", uid: "u1" };

    const bounty = await createBountyOperation(
      {
        title: "Owned renewal",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    const firstClaim = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "worker" } },
      { ...deps, claimStore },
    );
    expect(firstClaim.ok).toBe(true);
    if (!firstClaim.ok) return;

    const renewal = await claimBountyOperation(
      {
        bountyId: bounty.value.bountyId,
        agent: { agentId: "worker" },
        leaseDurationMs: 3_600_000,
      },
      { ...deps, claimStore, sessionOwnerRef: ownerRef },
    );

    expect(renewal.ok).toBe(true);
    if (!renewal.ok) return;
    expect(renewal.value.claimId).toBe(firstClaim.value.claimId);
    const stored = await claimStore.getClaim(renewal.value.claimId);
    expect(stored?.ownerRef).toEqual(ownerRef);
  });

  test("different agent cannot renew another agent's claim", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "No steal",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-a" } },
      deps,
    );

    // Different agent tries to claim — rejected
    const steal = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-b" } },
      deps,
    );
    expect(steal.ok).toBe(false);
    if (!steal.ok) {
      expect(steal.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("settleBountyOperation status checks", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("rejects settle on unclaimed (open) bounty", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Not claimed",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    const contrib = await contributeOperation(
      { kind: "work", summary: "Some work", agent: { agentId: "worker" } },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    const result = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("cannot be settled");
    }
  });

  test("rejects settle on already-settled bounty", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    // Create → claim → contribute → settle (success)
    const bounty = await createBountyOperation(
      {
        title: "Already settled",
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

    const firstSettle = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(firstSettle.ok).toBe(true);

    // Second settle should fail with pre-flight check
    const secondSettle = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(secondSettle.ok).toBe(false);
    if (!secondSettle.ok) {
      expect(secondSettle.error.code).toBe("VALIDATION_ERROR");
      expect(secondSettle.error.message).toContain("cannot be settled");
    }
  });

  test("rejects settle when creditsService missing but bounty has reservationId", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Escrow test",
        amount: 100,
        criteria: { description: "work" },
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
      { kind: "work", summary: "Done", agent: { agentId: "worker" } },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    // Remove credits service to simulate missing provider
    const depsNoCredits: OperationDeps = { ...deps, creditsService: undefined };

    const result = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      depsNoCredits,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("creditsService");
    }
  });
});

// ---------------------------------------------------------------------------
// Non-escrowed bounty lifecycle (Issue 12A)
// ---------------------------------------------------------------------------

describe("non-escrowed bounty lifecycle", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("settles a bounty end-to-end without credits service", async () => {
    const depsNoCredits: OperationDeps = { ...deps, creditsService: undefined };

    // 1. Create bounty without escrow
    const bounty = await createBountyOperation(
      {
        title: "Reputation only",
        amount: 100,
        criteria: { description: "Any work", requiredTags: ["fix"] },
        agent: { agentId: "creator" },
      },
      depsNoCredits,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;
    expect(bounty.value.reservationId).toBeUndefined();

    // 2. Claim
    const claim = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "worker" } },
      depsNoCredits,
    );
    expect(claim.ok).toBe(true);

    // 3. Contribute
    const contrib = await contributeOperation(
      {
        kind: "work",
        summary: "Reputation fix",
        tags: ["fix"],
        agent: { agentId: "worker" },
      },
      depsNoCredits,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    // 4. Settle (no capture since no reservation)
    const result = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      depsNoCredits,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("settled");
    expect(result.value.amount).toBe(100);
    expect(result.value.paidTo).toBe("worker");
  });
});

// ---------------------------------------------------------------------------
// Sequential conflict tests (Issue 10B)
// ---------------------------------------------------------------------------

describe("sequential conflict scenarios", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("second claim on same bounty fails", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Conflict claim",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    // First claim succeeds
    const first = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-a" } },
      deps,
    );
    expect(first.ok).toBe(true);

    // Second claim fails — pre-flight rejects non-open bounty
    const second = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "agent-b" } },
      deps,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("VALIDATION_ERROR");
    }
  });

  test("settle after settle fails (idempotent capture but state rejects)", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    // Full lifecycle to settled
    const bounty = await createBountyOperation(
      {
        title: "Double settle",
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

    const firstSettle = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(firstSettle.ok).toBe(true);

    // Second settle blocked by pre-flight (status is "settled")
    const secondSettle = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(secondSettle.ok).toBe(false);
    if (!secondSettle.ok) {
      expect(secondSettle.error.code).toBe("VALIDATION_ERROR");
    }
  });

  test("claim after settle fails", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    // Full lifecycle to settled
    const bounty = await createBountyOperation(
      {
        title: "Claim after settle",
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

    await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );

    // Claim on settled bounty — pre-flight rejects
    const claim = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "latecomer" } },
      deps,
    );
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.error.code).toBe("VALIDATION_ERROR");
      expect(claim.error.message).toContain("not open");
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria tests (Issue #240) — FailingBountyStore partial failures
// ---------------------------------------------------------------------------

import { FailingBountyStore } from "./failing-bounty-store.js";

describe("partial failure acceptance criteria (#240)", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("AC1: capture throws after state transitions — bounty retryable via pending_settlement", async () => {
    // Simulate: settle starts, pivot to pending_settlement succeeds,
    // but capture() fails. The bounty should be in pending_settlement
    // and retryable.
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Capture fail test",
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

    // Configure credits service to fail on capture
    (deps.creditsService as InMemoryCreditsService).setFailures({
      capture: new Error("Simulated capture failure"),
    });

    // First settle attempt — fails during capture
    const failedSettle = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(failedSettle.ok).toBe(false);

    // Bounty should be in pending_settlement (pivot committed)
    const stuck = await deps.bountyStore!.getBounty(bounty.value.bountyId);
    expect(stuck?.status).toBe("pending_settlement");

    // Clear the failure — capture will now succeed (idempotent)
    (deps.creditsService as InMemoryCreditsService).setFailures({});

    // Retry settle — should resume from pending_settlement
    const retrySettle = await settleBountyOperation(
      { bountyId: bounty.value.bountyId, contributionCid: contrib.value.cid },
      deps,
    );
    expect(retrySettle.ok).toBe(true);
    if (!retrySettle.ok) return;
    expect(retrySettle.value.status).toBe("settled");
    expect(retrySettle.value.paidTo).toBe("worker");
  });

  test("AC2: createBounty throws post-commit — reservation must NOT be voided", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const failingStore = new FailingBountyStore(deps.bountyStore!);
    failingStore.failOnNext("createBounty");
    const failDeps: OperationDeps = { ...deps, bountyStore: failingStore };

    // createBountyOperation fails — but the bounty IS committed in the delegate
    const result = await createBountyOperation(
      {
        title: "Post-commit fail",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "creator" },
      },
      failDeps,
    );

    // Operation reports failure
    expect(result.ok).toBe(false);

    // The bounty exists in the store (post-commit failure)
    const bounties = await deps.bountyStore!.listBounties();
    expect(bounties.length).toBe(1);
    expect(bounties[0]?.status).toBe("open");

    // The reservation was NOT voided — it's still active.
    // The operation does NOT compensate on failure (by design — no try/catch
    // compensation, which was the bug in the WIP that #240 identified).
    // The reservation will auto-expire via its timeout.
    const balanceInfo = await (deps.creditsService as InMemoryCreditsService).balance("creator");
    // 1000 - 100 reserved = 900 available (reservation still active)
    expect(balanceInfo.available).toBe(900);
    expect(balanceInfo.reserved).toBe(100);
  });

  test("AC3: claimBounty throws post-commit — claim must NOT be released", async () => {
    (deps.creditsService as InMemoryCreditsService).seed("creator", 1000);

    const bounty = await createBountyOperation(
      {
        title: "Claim fail test",
        amount: 100,
        criteria: { description: "work" },
        agent: { agentId: "creator" },
      },
      deps,
    );
    expect(bounty.ok).toBe(true);
    if (!bounty.ok) return;

    const failingStore = new FailingBountyStore(deps.bountyStore!);
    failingStore.failOnNext("claimBounty");
    const failDeps: OperationDeps = { ...deps, bountyStore: failingStore };

    // claimBountyOperation fails — but the bounty IS transitioned in the delegate
    const result = await claimBountyOperation(
      { bountyId: bounty.value.bountyId, agent: { agentId: "worker" } },
      failDeps,
    );

    // Operation reports failure
    expect(result.ok).toBe(false);

    // The bounty is in "claimed" state in the store (post-commit)
    const stored = await deps.bountyStore!.getBounty(bounty.value.bountyId);
    expect(stored?.status).toBe("claimed");
    expect(stored?.claimedBy?.agentId).toBe("worker");

    // The claim was NOT released — it's still active in the claim store.
    // The operation does NOT compensate on failure (by design).
    // The claim will expire via its lease timeout (30min default).
    const claims = await deps.claimStore!.activeClaims();
    const bountyClaimExists = claims.some((c) => c.targetRef === `bounty:${bounty.value.bountyId}`);
    expect(bountyClaimExists).toBe(true);
  });
});
