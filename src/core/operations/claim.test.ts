/**
 * Tests for claim operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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
