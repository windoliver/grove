/**
 * Tests for lifecycle operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { GroveContract } from "../contract.js";
import { contributeOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import { checkStopOperation } from "./lifecycle.js";
import type { TestOperationDeps } from "./test-helpers.js";
import { createTestOperationDeps } from "./test-helpers.js";

describe("checkStopOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: OperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("returns stopped:false when no contract is defined", async () => {
    // Default test deps have no contract
    const result = await checkStopOperation(deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopped).toBe(false);
    expect(result.value.reason).toContain("No GROVE.md contract defined");
    expect(result.value.conditions).toEqual({});
    expect(result.value.evaluatedAt).toBeTruthy();
  });

  test("returns stopped:false when contract has no stop conditions", async () => {
    const contract: GroveContract = {
      contractVersion: 2,
      name: "test-no-stop",
    };
    const depsWithContract: OperationDeps = { ...deps, contract };

    const result = await checkStopOperation(depsWithContract);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopped).toBe(false);
    expect(result.value.conditions).toEqual({});
  });

  test("returns stopped:false when budget not yet exhausted", async () => {
    const contract: GroveContract = {
      contractVersion: 2,
      name: "test-budget",
      stopConditions: {
        budget: { maxContributions: 5 },
      },
    };
    const depsWithContract: OperationDeps = { ...deps, contract };

    // Add one contribution (below budget of 5)
    const contrib = await contributeOperation(
      { kind: "work", summary: "first", agent: { agentId: "a1" } },
      depsWithContract,
    );
    expect(contrib.ok).toBe(true);

    const result = await checkStopOperation(depsWithContract);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopped).toBe(false);
    expect(result.value.conditions).toHaveProperty("budget");
  });

  test("returns stopped:true when budget maxContributions is met", async () => {
    const contract: GroveContract = {
      contractVersion: 2,
      name: "test-budget-met",
      stopConditions: {
        budget: { maxContributions: 2 },
      },
    };
    const depsWithContract: OperationDeps = { ...deps, contract };

    // Add exactly 2 contributions to meet the budget
    await contributeOperation(
      { kind: "work", summary: "first", agent: { agentId: "a1" } },
      depsWithContract,
    );
    await contributeOperation(
      { kind: "work", summary: "second", agent: { agentId: "a1" } },
      depsWithContract,
    );

    const result = await checkStopOperation(depsWithContract);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopped).toBe(true);
    expect(result.value.reason).toContain("budget");
    expect(result.value.conditions.budget).toBeDefined();
    expect(result.value.conditions.budget?.met).toBe(true);
  });

  test("returns stopped:false when grove is empty", async () => {
    const contract: GroveContract = {
      contractVersion: 2,
      name: "test-empty",
      stopConditions: {
        budget: { maxContributions: 2 },
      },
    };
    const depsWithContract: OperationDeps = { ...deps, contract };

    const result = await checkStopOperation(depsWithContract);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopped).toBe(false);
  });
});
