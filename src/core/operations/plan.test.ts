/**
 * Tests for createPlanOperation + updatePlanOperation.
 *
 * After Issue 1A in the #228 review, plan operations route through
 * contributeOperation, so this file covers:
 *
 *   - Validation (title, tasks)
 *   - Stats computation (computeStats helper)
 *   - derives_from chain (updatePlan)
 *   - Title fall-through from previous version
 *   - Wrong-kind previous CID (Issue 6A)
 *   - Plan-kind constraint enforcement via PolicyEnforcer (Issue 1A regression)
 *   - idempotencyKey passthrough (Issue 4A)
 *   - Routing rules: plans don't generate handoffs, do fire route events
 *   - Stop conditions skipped for plan kind (Issue 13A)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { GroveContract } from "../contract.js";
import { EnforcingContributionStore } from "../enforcing-store.js";
import { ContributionKind, ContributionMode } from "../models.js";
import type { ContributionStore } from "../store.js";
import type { PlanTask } from "./context-schemas.js";
import { _resetIdempotencyCacheForTests } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import { createPlanOperation, updatePlanOperation } from "./plan.js";
import type { FullOperationDeps, TestOperationDeps } from "./test-helpers.js";
import { createTestOperationDeps } from "./test-helpers.js";

const SAMPLE_TASKS: readonly PlanTask[] = [
  { id: "t1", title: "Design API", status: "todo" },
  { id: "t2", title: "Implement", status: "in_progress" },
  { id: "t3", title: "Tests", status: "done" },
  { id: "t4", title: "Deploy", status: "blocked" },
];

// ---------------------------------------------------------------------------
// createPlanOperation
// ---------------------------------------------------------------------------

describe("createPlanOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: FullOperationDeps;

  beforeEach(async () => {
    _resetIdempotencyCacheForTests();
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
    _resetIdempotencyCacheForTests();
  });

  test("creates a plan with stats", async () => {
    const result = await createPlanOperation(
      {
        title: "Phase 1",
        tasks: SAMPLE_TASKS,
        agent: { agentId: "planner" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("Phase 1");
    expect(result.value.taskCount).toBe(4);
    expect(result.value.todo).toBe(1);
    expect(result.value.inProgress).toBe(1);
    expect(result.value.done).toBe(1);
    expect(result.value.blocked).toBe(1);
    expect(result.value.cid).toMatch(/^blake3:/);
  });

  test("stores as kind=plan, mode=exploration with plan tag", async () => {
    const result = await createPlanOperation(
      { title: "P", tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await deps.contributionStore.get(result.value.cid);
    expect(stored?.kind).toBe(ContributionKind.Plan);
    expect(stored?.mode).toBe(ContributionMode.Exploration);
    expect(stored?.tags).toContain("plan");
  });

  test("stores typed PlanContext via buildPlanContext", async () => {
    const result = await createPlanOperation(
      { title: "Phase 1", tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await deps.contributionStore.get(result.value.cid);
    expect(stored?.context?.plan_title).toBe("Phase 1");
    expect(stored?.context?.tasks).toEqual(SAMPLE_TASKS as never);
  });

  test("preserves user-supplied tags alongside 'plan' tag", async () => {
    const result = await createPlanOperation(
      {
        title: "P",
        tasks: SAMPLE_TASKS,
        tags: ["sprint-1", "auth"],
        agent: { agentId: "a" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await deps.contributionStore.get(result.value.cid);
    expect(stored?.tags).toContain("plan");
    expect(stored?.tags).toContain("sprint-1");
    expect(stored?.tags).toContain("auth");
  });

  test("rejects empty title", async () => {
    const result = await createPlanOperation(
      { title: "  ", tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toMatch(/title/i);
  });

  test("rejects empty task list", async () => {
    const result = await createPlanOperation(
      { title: "P", tasks: [], agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toMatch(/task/i);
  });

  test("computeStats counts mixed statuses correctly", async () => {
    const tasks: readonly PlanTask[] = [
      { id: "1", title: "a", status: "done" },
      { id: "2", title: "b", status: "done" },
      { id: "3", title: "c", status: "in_progress" },
      { id: "4", title: "d", status: "todo" },
      { id: "5", title: "e", status: "todo" },
      { id: "6", title: "f", status: "todo" },
      { id: "7", title: "g", status: "blocked" },
    ];
    const result = await createPlanOperation(
      { title: "Mixed", tasks, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.taskCount).toBe(7);
    expect(result.value.done).toBe(2);
    expect(result.value.inProgress).toBe(1);
    expect(result.value.todo).toBe(3);
    expect(result.value.blocked).toBe(1);
  });

  // -------------------------------------------------------------------------
  // #228 regression: PolicyEnforcer must apply
  // -------------------------------------------------------------------------
  test("#228 regression: blocked when allowedKinds excludes 'plan'", async () => {
    const contract: GroveContract = {
      contractVersion: 1,
      name: "no-plans",
      mode: ContributionMode.Evaluation,
      agentConstraints: { allowedKinds: ["work"] },
    };
    const wrappedStore = new EnforcingContributionStore(deps.contributionStore, contract);
    const wrappedDeps: OperationDeps = {
      ...deps,
      contributionStore: wrappedStore,
      contract,
    };

    const result = await createPlanOperation(
      { title: "blocked plan", tasks: SAMPLE_TASKS, agent: { agentId: "coder" } },
      wrappedDeps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBeTruthy();
    // The plan should NOT be in the underlying store.
    const stored = await deps.contributionStore.list({ kind: ContributionKind.Plan });
    expect(stored).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Idempotency (Issue 4A)
  // -------------------------------------------------------------------------
  test("idempotencyKey: identical retry returns cached result", async () => {
    const input = {
      title: "Idempotent plan",
      tasks: SAMPLE_TASKS,
      agent: { agentId: "a" },
      idempotencyKey: "plan-key-1",
    };
    const first = await createPlanOperation(input, deps);
    const second = await createPlanOperation({ ...input }, deps);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.cid).toBe(first.value.cid);
  });

  test("idempotencyKey: same key + different title is rejected with STATE_CONFLICT", async () => {
    const first = await createPlanOperation(
      {
        title: "Original title",
        tasks: SAMPLE_TASKS,
        agent: { agentId: "a" },
        idempotencyKey: "plan-key-2",
      },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await createPlanOperation(
      {
        title: "Different title, same key",
        tasks: SAMPLE_TASKS,
        agent: { agentId: "a" },
        idempotencyKey: "plan-key-2",
      },
      deps,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("STATE_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// updatePlanOperation
// ---------------------------------------------------------------------------

describe("updatePlanOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: FullOperationDeps;

  beforeEach(async () => {
    _resetIdempotencyCacheForTests();
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
    _resetIdempotencyCacheForTests();
  });

  test("creates a v2 plan with derives_from relation to v1", async () => {
    const v1 = await createPlanOperation(
      { title: "Phase 1", tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    const updatedTasks: readonly PlanTask[] = [
      { id: "t1", title: "Design API", status: "done" },
      { id: "t2", title: "Implement", status: "done" },
      { id: "t3", title: "Tests", status: "done" },
      { id: "t4", title: "Deploy", status: "in_progress" },
    ];
    const v2 = await updatePlanOperation(
      {
        previousPlanCid: v1.value.cid,
        tasks: updatedTasks,
        agent: { agentId: "a" },
      },
      deps,
    );
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;

    expect(v2.value.title).toBe("Phase 1"); // falls through from previous
    expect(v2.value.done).toBe(3);
    expect(v2.value.inProgress).toBe(1);

    const stored = await deps.contributionStore.get(v2.value.cid);
    expect(stored?.relations).toHaveLength(1);
    expect(stored?.relations[0]?.relationType).toBe("derives_from");
    expect(stored?.relations[0]?.targetCid).toBe(v1.value.cid);
  });

  test("title falls through from previous plan when omitted", async () => {
    const v1 = await createPlanOperation(
      { title: "Inherited Title", tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    const v2 = await updatePlanOperation(
      { previousPlanCid: v1.value.cid, tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.value.title).toBe("Inherited Title");
  });

  test("explicit title override on update", async () => {
    const v1 = await createPlanOperation(
      { title: "v1 title", tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    const v2 = await updatePlanOperation(
      {
        previousPlanCid: v1.value.cid,
        title: "v2 title",
        tasks: SAMPLE_TASKS,
        agent: { agentId: "a" },
      },
      deps,
    );
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.value.title).toBe("v2 title");
  });

  test("returns NOT_FOUND when previous CID does not exist", async () => {
    const result = await updatePlanOperation(
      {
        previousPlanCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        tasks: SAMPLE_TASKS,
        agent: { agentId: "a" },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Issue 6A: kind-check on previous CID
  // -------------------------------------------------------------------------
  test("Issue 6A: rejects update when previous CID is not a plan kind", async () => {
    // Seed a non-plan contribution by creating a real work contribution
    // through contributeOperation, so the CID is valid blake3 hex.
    const { contributeOperation } = await import("./contribute.js");
    const work = await contributeOperation(
      {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "real work",
        agent: { agentId: "worker" },
      },
      deps,
    );
    expect(work.ok).toBe(true);
    if (!work.ok) return;

    const result = await updatePlanOperation(
      { previousPlanCid: work.value.cid, tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toMatch(/work.*not a plan|not a plan/i);
  });

  test("rejects empty task list", async () => {
    const v1 = await createPlanOperation(
      { title: "P", tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    const result = await updatePlanOperation(
      { previousPlanCid: v1.value.cid, tasks: [], agent: { agentId: "a" } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  test("derives_from chain across three versions", async () => {
    const v1 = await createPlanOperation(
      { title: "Multi-version", tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    const v2 = await updatePlanOperation(
      { previousPlanCid: v1.value.cid, tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;

    const v3 = await updatePlanOperation(
      { previousPlanCid: v2.value.cid, tasks: SAMPLE_TASKS, agent: { agentId: "a" } },
      deps,
    );
    expect(v3.ok).toBe(true);
    if (!v3.ok) return;

    expect(v3.value.title).toBe("Multi-version"); // inherited through both updates

    const v3Stored = await deps.contributionStore.get(v3.value.cid);
    expect(v3Stored?.relations[0]?.targetCid).toBe(v2.value.cid);

    const v2Stored = await deps.contributionStore.get(v2.value.cid);
    expect(v2Stored?.relations[0]?.targetCid).toBe(v1.value.cid);
  });
});

// ---------------------------------------------------------------------------
// Routing rules (Issues 1A + 13A)
// ---------------------------------------------------------------------------

describe("plan routing semantics (Issues 1A + 13A)", () => {
  let testDeps: TestOperationDeps;
  let deps: FullOperationDeps;

  beforeEach(async () => {
    _resetIdempotencyCacheForTests();
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
    _resetIdempotencyCacheForTests();
  });

  test("creating a plan does NOT create handoff records, even with topology", async () => {
    // Build a topology router that would route 'planner' -> 'coder' for any
    // contribution. Plans should still skip handoff creation.
    const topologyRouter = {
      targetsFor: (role: string) =>
        role === "planner" ? [{ target: "coder", edgeType: "delegates" as const }] : [],
      route: async () => {
        /* fire-and-forget event */
      },
      broadcastStop: async () => {
        /* stop broadcast */
      },
    } as unknown as NonNullable<OperationDeps["topologyRouter"]>;

    const depsWithRouting: OperationDeps = { ...deps, topologyRouter };

    const result = await createPlanOperation(
      {
        title: "Routed plan",
        tasks: SAMPLE_TASKS,
        agent: { agentId: "planner-1", role: "planner" },
      },
      depsWithRouting,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No handoff records should have been created.
    const handoffs = await deps.handoffStore.list({ sourceCid: result.value.cid });
    expect(handoffs).toHaveLength(0);
  });

  test("plan write succeeds with stop conditions configured (skipped per 13A)", async () => {
    // Configure stop conditions that would normally fire on every write.
    // maxRoundsWithoutImprovement: 0 means "stop immediately if no
    // improvement". Since plans skip stop-condition evaluation entirely
    // (Issue 13A), the plan write succeeds without paying the O(n) scan
    // and without triggering broadcastStop.
    const contract: GroveContract = {
      contractVersion: 1,
      name: "with-stop-conditions",
      mode: ContributionMode.Exploration,
      stopConditions: { maxRoundsWithoutImprovement: 0 },
    };

    const result = await createPlanOperation(
      {
        title: "Stop-bypass plan",
        tasks: SAMPLE_TASKS,
        agent: { agentId: "planner" },
      },
      { ...deps, contract } as OperationDeps,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Confirm contributionStore is required
// ---------------------------------------------------------------------------

describe("plan operation deps", () => {
  test("createPlan returns validation error when contributionStore is missing for updatePlan", async () => {
    // This case applies to updatePlanOperation which checks store explicitly.
    const emptyDeps = {} as ContributionStore as unknown as OperationDeps;
    const result = await updatePlanOperation(
      {
        previousPlanCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        tasks: SAMPLE_TASKS,
        agent: { agentId: "a" },
      },
      emptyDeps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
