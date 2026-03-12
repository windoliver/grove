/**
 * Tests for outcome operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SqliteOutcomeStore } from "../../local/sqlite-outcome-store.js";
import { initSqliteDb } from "../../local/sqlite-store.js";
import type { OperationDeps } from "./deps.js";
import {
  getOutcomeOperation,
  listOutcomesOperation,
  outcomeStatsOperation,
  setOutcomeOperation,
} from "./outcome.js";
import type { TestOperationDeps } from "./test-helpers.js";
import { createTestOperationDeps } from "./test-helpers.js";

/** Extend test deps with an outcomeStore. */
interface TestOutcomeDeps {
  readonly testDeps: TestOperationDeps;
  readonly deps: OperationDeps;
  readonly cleanup: () => Promise<void>;
}

async function createTestOutcomeDeps(): Promise<TestOutcomeDeps> {
  const testDeps = await createTestOperationDeps();

  // Create outcomeStore from a new DB in the same temp dir
  const outcomeDbPath = join(testDeps.tempDir, "outcome.db");
  const outcomeDb = initSqliteDb(outcomeDbPath);
  const outcomeStore = new SqliteOutcomeStore(outcomeDb);

  const deps: OperationDeps = {
    ...testDeps.deps,
    outcomeStore,
  };

  return {
    testDeps,
    deps,
    cleanup: async () => {
      outcomeStore.close();
      outcomeDb.close();
      await testDeps.cleanup();
    },
  };
}

describe("setOutcomeOperation", () => {
  let ctx: TestOutcomeDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    ctx = await createTestOutcomeDeps();
    deps = ctx.deps;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("sets an outcome (happy path)", async () => {
    const result = await setOutcomeOperation(
      {
        cid: "blake3:abc123",
        status: "accepted",
        reason: "Looks good",
        agent: { agentId: "evaluator-1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cid).toBe("blake3:abc123");
    expect(result.value.status).toBe("accepted");
    expect(result.value.reason).toBe("Looks good");
    expect(result.value.evaluatedBy).toBe("evaluator-1");
    expect(result.value.evaluatedAt).toBeTruthy();
  });

  test("sets an outcome with baselineCid", async () => {
    const result = await setOutcomeOperation(
      {
        cid: "blake3:abc123",
        status: "rejected",
        reason: "Regression",
        baselineCid: "blake3:baseline000",
        agent: { agentId: "evaluator-1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("rejected");
    expect(result.value.baselineCid).toBe("blake3:baseline000");
  });

  test("returns VALIDATION_ERROR when outcomeStore not configured", async () => {
    const depsNoOutcome: OperationDeps = {
      contributionStore: deps.contributionStore,
      claimStore: deps.claimStore,
      cas: deps.cas,
      frontier: deps.frontier,
    };

    const result = await setOutcomeOperation(
      {
        cid: "blake3:abc123",
        status: "accepted",
        agent: { agentId: "evaluator-1" },
      },
      depsNoOutcome,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("Outcome store not configured");
    }
  });
});

describe("getOutcomeOperation", () => {
  let ctx: TestOutcomeDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    ctx = await createTestOutcomeDeps();
    deps = ctx.deps;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("gets an existing outcome", async () => {
    // Set an outcome first
    const setResult = await setOutcomeOperation(
      {
        cid: "blake3:getme",
        status: "accepted",
        reason: "All good",
        agent: { agentId: "evaluator-1" },
      },
      deps,
    );
    expect(setResult.ok).toBe(true);

    const result = await getOutcomeOperation({ cid: "blake3:getme" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cid).toBe("blake3:getme");
    expect(result.value.status).toBe("accepted");
    expect(result.value.reason).toBe("All good");
    expect(result.value.evaluatedBy).toBe("evaluator-1");
  });

  test("returns NOT_FOUND for missing outcome", async () => {
    const result = await getOutcomeOperation({ cid: "blake3:nonexistent" }, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns VALIDATION_ERROR when outcomeStore not configured", async () => {
    const depsNoOutcome: OperationDeps = {
      contributionStore: deps.contributionStore,
      claimStore: deps.claimStore,
      cas: deps.cas,
      frontier: deps.frontier,
    };

    const result = await getOutcomeOperation({ cid: "blake3:abc" }, depsNoOutcome);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("listOutcomesOperation", () => {
  let ctx: TestOutcomeDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    ctx = await createTestOutcomeDeps();
    deps = ctx.deps;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns empty list when no outcomes exist", async () => {
    const result = await listOutcomesOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  test("lists outcomes after creation", async () => {
    await setOutcomeOperation(
      { cid: "blake3:one", status: "accepted", agent: { agentId: "e1" } },
      deps,
    );
    await setOutcomeOperation(
      { cid: "blake3:two", status: "rejected", reason: "Bad", agent: { agentId: "e1" } },
      deps,
    );

    const result = await listOutcomesOperation({}, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
  });

  test("filters by status", async () => {
    await setOutcomeOperation(
      { cid: "blake3:acc1", status: "accepted", agent: { agentId: "e1" } },
      deps,
    );
    await setOutcomeOperation(
      { cid: "blake3:rej1", status: "rejected", agent: { agentId: "e1" } },
      deps,
    );

    const accepted = await listOutcomesOperation({ status: "accepted" }, deps);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value).toHaveLength(1);

    const rejected = await listOutcomesOperation({ status: "rejected" }, deps);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).toHaveLength(1);
  });

  test("returns VALIDATION_ERROR when outcomeStore not configured", async () => {
    const depsNoOutcome: OperationDeps = {
      contributionStore: deps.contributionStore,
      claimStore: deps.claimStore,
      cas: deps.cas,
      frontier: deps.frontier,
    };

    const result = await listOutcomesOperation({}, depsNoOutcome);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("outcomeStatsOperation", () => {
  let ctx: TestOutcomeDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    ctx = await createTestOutcomeDeps();
    deps = ctx.deps;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns stats for empty store", async () => {
    const result = await outcomeStatsOperation(deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
    expect(result.value.accepted).toBe(0);
    expect(result.value.rejected).toBe(0);
    expect(result.value.crashed).toBe(0);
    expect(result.value.invalidated).toBe(0);
    expect(result.value.acceptanceRate).toBe(0);
  });

  test("returns correct stats after setting outcomes", async () => {
    await setOutcomeOperation(
      { cid: "blake3:a1", status: "accepted", agent: { agentId: "e1" } },
      deps,
    );
    await setOutcomeOperation(
      { cid: "blake3:a2", status: "accepted", agent: { agentId: "e1" } },
      deps,
    );
    await setOutcomeOperation(
      { cid: "blake3:r1", status: "rejected", agent: { agentId: "e1" } },
      deps,
    );
    await setOutcomeOperation(
      { cid: "blake3:c1", status: "crashed", agent: { agentId: "e1" } },
      deps,
    );

    const result = await outcomeStatsOperation(deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(4);
    expect(result.value.accepted).toBe(2);
    expect(result.value.rejected).toBe(1);
    expect(result.value.crashed).toBe(1);
    expect(result.value.invalidated).toBe(0);
    expect(result.value.acceptanceRate).toBe(0.5);
  });

  test("returns VALIDATION_ERROR when outcomeStore not configured", async () => {
    const depsNoOutcome: OperationDeps = {
      contributionStore: deps.contributionStore,
      claimStore: deps.claimStore,
      cas: deps.cas,
      frontier: deps.frontier,
    };

    const result = await outcomeStatsOperation(depsNoOutcome);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});
