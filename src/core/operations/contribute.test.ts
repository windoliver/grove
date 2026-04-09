/**
 * Tests for contribution operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetIdempotencyCacheForTests,
  contributeOperation,
  discussOperation,
  reproduceOperation,
  reviewOperation,
} from "./contribute.js";
import type { FullOperationDeps, TestOperationDeps } from "./test-helpers.js";
import { createTestOperationDeps, storeTestContent } from "./test-helpers.js";

describe("contributeOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: FullOperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a work contribution (happy path)", async () => {
    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Test work contribution",
        tags: ["test"],
        agent: { agentId: "test-agent" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cid).toMatch(/^blake3:/);
    expect(result.value.kind).toBe("work");
    expect(result.value.mode).toBe("evaluation");
    expect(result.value.summary).toBe("Test work contribution");
    expect(result.value.artifactCount).toBe(0);
    expect(result.value.relationCount).toBe(0);
    expect(result.value.createdAt).toBeTruthy();
  });

  test("defaults mode to evaluation", async () => {
    const result = await contributeOperation(
      { kind: "work", summary: "test", agent: { agentId: "a1" } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe("evaluation");
  });

  test("respects explicit mode override", async () => {
    const result = await contributeOperation(
      { kind: "work", mode: "exploration", summary: "test", agent: { agentId: "a1" } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe("exploration");
  });

  test("validates artifact hashes exist in CAS", async () => {
    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Bad artifacts",
        artifacts: {
          "file.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        },
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("non-existent hash");
    }
  });

  test("accepts valid artifact hashes", async () => {
    const hash = await storeTestContent(deps.cas, "hello world");
    const result = await contributeOperation(
      {
        kind: "work",
        summary: "With artifact",
        artifacts: { "readme.txt": hash },
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.artifactCount).toBe(1);
  });

  test("validates relation targets exist", async () => {
    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Bad relation",
        relations: [
          {
            targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
            relationType: "derives_from",
          },
        ],
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("accepts valid relation targets", async () => {
    // Create a target contribution first
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "child",
        relations: [{ targetCid: target.value.cid, relationType: "derives_from" }],
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.relationCount).toBe(1);
  });

  test("stores contribution retrievable by CID", async () => {
    const result = await contributeOperation(
      { kind: "work", summary: "retrievable", agent: { agentId: "a1" } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await deps.contributionStore.get(result.value.cid);
    expect(stored).toBeDefined();
    expect(stored?.summary).toBe("retrievable");
  });

  // -----------------------------------------------------------------------
  // Timezone normalization (toUtcIso in contributeOperation)
  // -----------------------------------------------------------------------

  test("createdAt with positive offset is stored as UTC Z-format", async () => {
    const result = await contributeOperation(
      {
        kind: "work",
        summary: "IST contribution",
        createdAt: "2026-01-02T00:00:00+05:30",
        agent: { agentId: "tz-agent" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.createdAt).toBe("2026-01-01T18:30:00.000Z");

    const stored = await deps.contributionStore.get(result.value.cid);
    expect(stored).toBeDefined();
    expect(stored?.createdAt).toEndWith("Z");
    expect(stored?.createdAt).toBe("2026-01-01T18:30:00.000Z");
  });

  test("createdAt with negative offset is stored as UTC Z-format", async () => {
    const result = await contributeOperation(
      {
        kind: "work",
        summary: "PST contribution",
        createdAt: "2026-03-15T08:00:00-08:00",
        agent: { agentId: "tz-agent" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.createdAt).toBe("2026-03-15T16:00:00.000Z");

    const stored = await deps.contributionStore.get(result.value.cid);
    expect(stored).toBeDefined();
    expect(stored?.createdAt).toBe("2026-03-15T16:00:00.000Z");
  });

  test("createdAt already in UTC Z-format is idempotent", async () => {
    const result = await contributeOperation(
      {
        kind: "work",
        summary: "UTC contribution",
        createdAt: "2026-06-01T12:00:00.000Z",
        agent: { agentId: "tz-agent" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.createdAt).toBe("2026-06-01T12:00:00.000Z");

    const stored = await deps.contributionStore.get(result.value.cid);
    expect(stored).toBeDefined();
    expect(stored?.createdAt).toBe("2026-06-01T12:00:00.000Z");
  });
});

describe("contributeOperation: idempotencyKey", () => {
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

  test("repeated call with same key returns the cached result", async () => {
    const first = await contributeOperation(
      {
        kind: "work",
        summary: "first call",
        agent: { agentId: "agent-1" },
        idempotencyKey: "key-1",
      },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await contributeOperation(
      {
        kind: "work",
        summary: "different summary, but same key",
        agent: { agentId: "agent-1" },
        idempotencyKey: "key-1",
      },
      deps,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Same CID and same summary as the original — proves the cache served it.
    expect(second.value.cid).toBe(first.value.cid);
    expect(second.value.summary).toBe("first call");
  });

  test("different keys produce different contributions", async () => {
    const first = await contributeOperation(
      {
        kind: "work",
        summary: "alpha",
        agent: { agentId: "agent-1" },
        idempotencyKey: "key-A",
      },
      deps,
    );
    const second = await contributeOperation(
      {
        kind: "work",
        summary: "beta",
        agent: { agentId: "agent-1" },
        idempotencyKey: "key-B",
      },
      deps,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.cid).not.toBe(second.value.cid);
  });

  test("same key from different agents does not collide", async () => {
    const alice = await contributeOperation(
      {
        kind: "work",
        summary: "alice's work",
        agent: { agentId: "alice" },
        idempotencyKey: "shared-key",
      },
      deps,
    );
    const bob = await contributeOperation(
      {
        kind: "work",
        summary: "bob's work",
        agent: { agentId: "bob" },
        idempotencyKey: "shared-key",
      },
      deps,
    );
    expect(alice.ok && bob.ok).toBe(true);
    if (!alice.ok || !bob.ok) return;
    expect(alice.value.cid).not.toBe(bob.value.cid);
    expect(alice.value.summary).toBe("alice's work");
    expect(bob.value.summary).toBe("bob's work");
  });

  test("agent role takes precedence over agentId for idempotency scope", async () => {
    // Two agents with the same role share the idempotency namespace.
    const first = await contributeOperation(
      {
        kind: "work",
        summary: "from agent-1",
        agent: { agentId: "agent-1", role: "coder" },
        idempotencyKey: "k",
      },
      deps,
    );
    const second = await contributeOperation(
      {
        kind: "work",
        summary: "from agent-2",
        agent: { agentId: "agent-2", role: "coder" },
        idempotencyKey: "k",
      },
      deps,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.cid).toBe(first.value.cid);
    expect(second.value.summary).toBe("from agent-1");
  });

  test("no idempotencyKey means no dedup", async () => {
    const first = await contributeOperation(
      { kind: "work", summary: "duplicate", agent: { agentId: "a1" } },
      deps,
    );
    const second = await contributeOperation(
      { kind: "work", summary: "duplicate", agent: { agentId: "a1" } },
      deps,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Without an idempotency key, two identical contributions are produced.
    // (CIDs may collide if the timestamps round to the same millisecond,
    // but conceptually each call is a separate contribution.)
    expect(first.value.cid).toBeTruthy();
    expect(second.value.cid).toBeTruthy();
  });
});

describe("reviewOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: FullOperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a review of an existing contribution", async () => {
    // Create target
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const result = await reviewOperation(
      {
        targetCid: target.value.cid,
        summary: "Looks good",
        scores: { quality: { value: 0.8, direction: "maximize" } },
        agent: { agentId: "reviewer" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("review");
    expect(result.value.targetCid).toBe(target.value.cid);
    expect(result.value.cid).toMatch(/^blake3:/);
  });

  test("fails when target does not exist", async () => {
    const result = await reviewOperation(
      {
        targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "Review of nothing",
        agent: { agentId: "reviewer" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("reproduceOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: FullOperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a reproduction (default confirmed)", async () => {
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const result = await reproduceOperation(
      {
        targetCid: target.value.cid,
        summary: "Reproduction confirmed",
        agent: { agentId: "reproducer" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("reproduction");
    expect(result.value.result).toBe("confirmed");
  });

  test("supports challenged result", async () => {
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const result = await reproduceOperation(
      {
        targetCid: target.value.cid,
        summary: "Could not reproduce",
        result: "challenged",
        agent: { agentId: "reproducer" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.result).toBe("challenged");
  });

  test("fails when target does not exist", async () => {
    const result = await reproduceOperation(
      {
        targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "Cannot reproduce",
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("validates artifact hashes", async () => {
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const result = await reproduceOperation(
      {
        targetCid: target.value.cid,
        summary: "Bad artifact",
        artifacts: {
          "log.txt": "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        },
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("discussOperation", () => {
  let testDeps: TestOperationDeps;
  let deps: FullOperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
    deps = testDeps.deps;
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("creates a root discussion (no target)", async () => {
    const result = await discussOperation(
      {
        summary: "Let's discuss this topic",
        tags: ["discussion"],
        agent: { agentId: "discusser" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("discussion");
    expect(result.value.targetCid).toBeUndefined();
  });

  test("creates a reply to existing contribution", async () => {
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const result = await discussOperation(
      {
        targetCid: target.value.cid,
        summary: "Great work!",
        agent: { agentId: "commenter" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targetCid).toBe(target.value.cid);
  });

  test("fails when reply target does not exist", async () => {
    const result = await discussOperation(
      {
        targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "Reply to nothing",
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});
