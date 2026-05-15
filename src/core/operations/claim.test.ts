/**
 * Tests for claim operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { InMemoryClaimStore } from "../../server/test-helpers.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../timeline.js";
import { claimOperation, listClaimsOperation, releaseOperation } from "./claim.js";
import type { OperationDeps } from "./deps.js";
import type { TestOperationDeps } from "./test-helpers.js";
import { createTestOperationDeps } from "./test-helpers.js";

describe("claimOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a new claim (happy path)", async () => {
    const result = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "Working on task 1",
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claimId).toBeTruthy();
    expect(result.value.targetRef).toBe("task-1");
    expect(result.value.status).toBe("active");
    expect(result.value.agentId).toBe("agent-1");
    expect(result.value.renewed).toBe(false);
  });

  test("stores claimOperation output as split claim spec and active status", async () => {
    const result = await claimOperation(
      {
        targetRef: "target-operation-split",
        agent: { agentId: "agent-operation-split", role: "coder", platform: "codex" },
        intentSummary: "operation split",
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const claimId = result.value.claimId;
    const view = await deps.claimStore?.getClaimView(claimId);

    expect(view?.spec.targetRef).toBe("target-operation-split");
    expect(view?.spec.roleName).toBe("coder");
    expect(view?.status.phase).toBe("active");
  });

  test("renews an existing claim by the same agent", async () => {
    // First claim
    const first = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "First attempt",
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    expect(first.ok).toBe(true);

    // Renew
    const second = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "Renewed",
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.renewed).toBe(true);
    expect(second.value.status).toBe("active");
  });

  test("fails when a different agent holds the claim", async () => {
    // Agent 1 claims
    const first = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "Agent 1 working",
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    expect(first.ok).toBe(true);

    // Agent 2 tries to claim same target
    const second = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "Agent 2 wants it",
        agent: { agentId: "agent-2" },
      },
      deps,
    );

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CLAIM_CONFLICT");
  });

  test("uses default lease duration of 5 minutes", async () => {
    const result = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "Working",
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lease = new Date(result.value.leaseExpiresAt).getTime();
    // Should be roughly 5 minutes from now (allow 10 sec tolerance)
    const expected = Date.now() + 300_000;
    expect(Math.abs(lease - expected)).toBeLessThan(10_000);
  });

  test("respects custom lease duration", async () => {
    const result = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "Working",
        leaseDurationMs: 60_000,
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lease = new Date(result.value.leaseExpiresAt).getTime();
    const expected = Date.now() + 60_000;
    expect(Math.abs(lease - expected)).toBeLessThan(10_000);
  });

  test("claimOperation stamps session ownerRef when deps provide one", async () => {
    const claimStore = new InMemoryClaimStore();
    const ownerRef = { kind: "session" as const, id: "s1", uid: "u1" };

    const result = await claimOperation(
      {
        targetRef: "owned-target",
        intentSummary: "owned work",
        agent: { agentId: "agent-a" },
      },
      { claimStore, sessionOwnerRef: ownerRef },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await claimStore.getClaim(result.value.claimId);
    expect(stored?.ownerRef).toEqual(ownerRef);
  });

  test("appends claim-created and lease-refreshed timeline events", async () => {
    const first = await claimOperation(
      {
        targetRef: "timeline-target",
        intentSummary: "timeline claim",
        context: { session_id: "session-claim", work_block_id: "wb_claim" },
        agent: { agentId: "agent-timeline" },
      },
      deps,
    );
    const renewed = await claimOperation(
      {
        targetRef: "timeline-target",
        intentSummary: "timeline claim renewed",
        context: { session_id: "session-claim", work_block_id: "wb_claim" },
        agent: { agentId: "agent-timeline" },
      },
      deps,
    );

    expect(first.ok).toBe(true);
    expect(renewed.ok).toBe(true);
    const events = await deps.timelineStore?.listTimelineEvents({ sessionId: "session-claim" });
    expect(events?.map((event) => event.type)).toEqual([
      TimelineEventType.ClaimCreated,
      TimelineEventType.ClaimLeaseRefreshed,
    ]);
  });
});

describe("releaseOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("releases an active claim", async () => {
    const claim = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "Working",
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const result = await releaseOperation(
      { claimId: claim.value.claimId, action: "release" },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("released");
    expect(result.value.action).toBe("release");
  });

  test("completes an active claim", async () => {
    const claim = await claimOperation(
      {
        targetRef: "task-1",
        intentSummary: "Working",
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const result = await releaseOperation(
      { claimId: claim.value.claimId, action: "complete" },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("completed");
    expect(result.value.action).toBe("complete");
  });

  test("returns NOT_FOUND for unknown claim ID", async () => {
    const result = await releaseOperation({ claimId: "nonexistent-id", action: "release" }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("appends completion timeline event and completes linked work block", async () => {
    await deps.timelineStore?.putWorkBlock(makeWorkBlock("wb_claim_complete", "session-claim"));
    const claim = await claimOperation(
      {
        targetRef: "task-complete",
        intentSummary: "complete task",
        context: { session_id: "session-claim", work_block_id: "wb_claim_complete" },
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const result = await releaseOperation(
      { claimId: claim.value.claimId, action: "complete" },
      deps,
    );

    expect(result.ok).toBe(true);
    const events = await deps.timelineStore?.listTimelineEvents({ sessionId: "session-claim" });
    expect(events?.map((event) => event.type)).toContain(TimelineEventType.ClaimCompleted);
    expect(events?.map((event) => event.type)).toContain(TimelineEventType.WorkBlockCompleted);
    const block = await deps.timelineStore?.getWorkBlock("wb_claim_complete");
    expect(block?.status).toBe(WorkBlockStatus.Completed);
  });
});

describe("listClaimsOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns empty list when no claims exist", async () => {
    const result = await listClaimsOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claims).toHaveLength(0);
    expect(result.value.count).toBe(0);
  });

  test("lists all claims", async () => {
    await claimOperation(
      { targetRef: "task-1", intentSummary: "A", agent: { agentId: "a1" } },
      deps,
    );
    await claimOperation(
      { targetRef: "task-2", intentSummary: "B", agent: { agentId: "a2" } },
      deps,
    );

    const result = await listClaimsOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(2);
  });

  test("filters by agent ID", async () => {
    await claimOperation(
      { targetRef: "task-1", intentSummary: "A", agent: { agentId: "a1" } },
      deps,
    );
    await claimOperation(
      { targetRef: "task-2", intentSummary: "B", agent: { agentId: "a2" } },
      deps,
    );

    const result = await listClaimsOperation({ agentId: "a1" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(1);
    expect(result.value.claims[0]?.agentId).toBe("a1");
  });

  test("filters by status", async () => {
    const claim = await claimOperation(
      { targetRef: "task-1", intentSummary: "A", agent: { agentId: "a1" } },
      deps,
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await releaseOperation({ claimId: claim.value.claimId, action: "release" }, deps);

    const activeResult = await listClaimsOperation({ status: "active" }, deps);
    expect(activeResult.ok).toBe(true);
    if (activeResult.ok) expect(activeResult.value.count).toBe(0);

    const releasedResult = await listClaimsOperation({ status: "released" }, deps);
    expect(releasedResult.ok).toBe(true);
    if (releasedResult.ok) expect(releasedResult.value.count).toBe(1);
  });
});

function makeWorkBlock(workBlockId: string, sessionId: string) {
  return {
    workBlockId,
    sessionId,
    goal: "Complete claimed work",
    actor: { agentId: "agent-1" },
    origin: WorkBlockOrigin.Agent,
    status: WorkBlockStatus.Running,
    startedAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    inputRefs: [],
    outputRefs: [],
    evidenceRefs: [],
    approvalRefs: [],
    contributionCids: [],
    artifactHashes: [],
    claimIds: [],
    revision: 1,
    createdAt: "2026-05-13T10:00:00.000Z",
  };
}

describe("claim → onEntityWrite", () => {
  let testDeps: TestOperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("claimOperation fires ADDED on first claim", async () => {
    const events: Array<{
      kind: string;
      op: string;
      phase: string;
      namespace: string;
    }> = [];
    const deps: OperationDeps = {
      ...testDeps.deps,
      onEntityWrite: (e) =>
        events.push({
          kind: e.kind,
          op: e.op,
          phase: (e.entity as { status: { phase: string } }).status.phase,
          namespace: e.namespace,
        }),
      namespace: "ns/wt",
    };

    const result = await claimOperation(
      { targetRef: "t1", agent: { agentId: "a-1" }, intentSummary: "first" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "Claim",
      op: "ADDED",
      namespace: "ns/wt",
    });
    expect(events[0]?.phase).toBe("active");
  });

  test("claimOperation suppresses event on heartbeat-like renewal (no phase change)", async () => {
    const events: Array<{ op: string }> = [];
    const deps: OperationDeps = {
      ...testDeps.deps,
      onEntityWrite: (e) => events.push({ op: e.op }),
      namespace: "ns/wt",
    };

    const first = await claimOperation(
      { targetRef: "t1", agent: { agentId: "a-1" }, intentSummary: "first" },
      deps,
    );
    expect(first.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.op).toBe("ADDED");

    // Renew — same agent, same target, still active. No phase transition,
    // so no event should fire.
    const renewed = await claimOperation(
      { targetRef: "t1", agent: { agentId: "a-1" }, intentSummary: "renewed" },
      deps,
    );
    expect(renewed.ok).toBe(true);
    expect(events).toHaveLength(1);
  });

  test("releaseOperation fires MODIFIED with the released phase", async () => {
    const events: Array<{ op: string; phase: string }> = [];
    const deps: OperationDeps = {
      ...testDeps.deps,
      onEntityWrite: (e) =>
        events.push({
          op: e.op,
          phase: (e.entity as { status: { phase: string } }).status.phase,
        }),
      namespace: "ns/wt",
    };

    const created = await claimOperation(
      { targetRef: "t1", agent: { agentId: "a-1" }, intentSummary: "first" },
      deps,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    events.length = 0; // reset to focus on the release event
    const released = await releaseOperation(
      { claimId: created.value.claimId, action: "release" },
      deps,
    );
    expect(released.ok).toBe(true);
    expect(events.some((e) => e.op === "MODIFIED")).toBe(true);
    expect(events.some((e) => e.phase === "released")).toBe(true);
  });

  test("skips onEntityWrite when namespace is missing", async () => {
    const events: unknown[] = [];
    const deps: OperationDeps = {
      ...testDeps.deps,
      onEntityWrite: (e: unknown) => events.push(e),
      namespace: undefined, // explicit override of helper's default
    };
    const result = await claimOperation(
      { targetRef: "t1", agent: { agentId: "a-1" }, intentSummary: "first" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(events).toHaveLength(0);
  });
});
