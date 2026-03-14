/**
 * Tests for checkout operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkoutOperation } from "./checkout.js";
import { contributeOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import type { FullOperationDeps, TestOperationDeps } from "./test-helpers.js";
import { createTestOperationDeps, storeTestContent } from "./test-helpers.js";

describe("checkoutOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: FullOperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("checks out a contribution with artifacts (happy path)", async () => {
    const hash = await storeTestContent(deps.cas, "file content");
    const contrib = await contributeOperation(
      {
        kind: "work",
        summary: "Work with artifact",
        artifacts: { "readme.txt": hash },
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    const result = await checkoutOperation(
      { cid: contrib.value.cid, agent: { agentId: "agent-1" } },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cid).toBe(contrib.value.cid);
    expect(result.value.workspacePath).toBeTruthy();
    expect(result.value.artifactCount).toBe(1);
    expect(result.value.agentId).toBe("agent-1");
    expect(result.value.status).toBeTruthy();
    expect(result.value.createdAt).toBeTruthy();
  });

  test("returns NOT_FOUND when CID does not exist", async () => {
    const result = await checkoutOperation(
      {
        cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns VALIDATION_ERROR when workspace manager not configured", async () => {
    const depsWithoutWorkspace: OperationDeps = {
      contributionStore: deps.contributionStore,
      claimStore: deps.claimStore,
      cas: deps.cas,
      frontier: deps.frontier,
    };

    const result = await checkoutOperation(
      {
        cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        agent: { agentId: "agent-1" },
      },
      depsWithoutWorkspace,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("Workspace manager not configured");
    }
  });

  test("checks out a contribution without artifacts", async () => {
    const contrib = await contributeOperation(
      {
        kind: "work",
        summary: "Work without artifacts",
        agent: { agentId: "agent-1" },
      },
      deps,
    );
    expect(contrib.ok).toBe(true);
    if (!contrib.ok) return;

    const result = await checkoutOperation(
      { cid: contrib.value.cid, agent: { agentId: "agent-1" } },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.artifactCount).toBe(0);
    expect(result.value.workspacePath).toBeTruthy();
  });
});
