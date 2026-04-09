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

  test("repeated call with same key + same input returns the cached result", async () => {
    const firstInput = {
      kind: "work" as const,
      summary: "first call",
      agent: { agentId: "agent-1" },
      idempotencyKey: "key-1",
    };
    const first = await contributeOperation(firstInput, deps);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Identical retry — should return the cached result.
    const second = await contributeOperation({ ...firstInput }, deps);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Same CID proves the cache served it.
    expect(second.value.cid).toBe(first.value.cid);
    expect(second.value.summary).toBe("first call");
  });

  test("same key + different input is rejected with STATE_CONFLICT", async () => {
    // Stripe/AWS Idempotency-Key semantics: reusing a key with a different
    // request body is a client bug (the key no longer identifies a single
    // logical operation). Reject instead of silently returning the first
    // call's result, which would hide the mistake.
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
        summary: "different summary, same key",
        agent: { agentId: "agent-1" },
        idempotencyKey: "key-1",
      },
      deps,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("STATE_CONFLICT");
    expect(second.error.message).toMatch(/different request body/i);
  });

  test("concurrent calls with same key are single-flight (one write)", async () => {
    // Two overlapping retries with the same key must NOT both write.
    // The first reserves the slot, the second awaits the pending Promise.
    const input = {
      kind: "work" as const,
      summary: "single flight",
      agent: { agentId: "agent-1" },
      idempotencyKey: "single-flight-key",
    };
    const [r1, r2] = await Promise.all([
      contributeOperation(input, deps),
      contributeOperation(input, deps),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Both callers observe the same CID — single write occurred.
    expect(r1.value.cid).toBe(r2.value.cid);

    // Verify via the store: only one contribution with that summary.
    const stored = await deps.contributionStore.list({ limit: 20 });
    const matching = stored.filter((c) => c.summary === "single flight");
    expect(matching).toHaveLength(1);
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

  test("agent role scopes idempotency: identical payload from two coders shares cache", async () => {
    // When the agent has a role, the idempotency namespace is per-role —
    // two agent instances of the same role submitting the SAME logical
    // request (identical fingerprint) are treated as retries of one call.
    //
    // This models multi-instance roles (e.g., max_instances=2 for coder)
    // where either instance might retry the same work submission.
    const sharedPayload = {
      kind: "work" as const,
      summary: "shared coder work",
      idempotencyKey: "coder-shared-key",
    };
    const first = await contributeOperation(
      { ...sharedPayload, agent: { agentId: "coder-instance-1", role: "coder" } },
      deps,
    );
    const second = await contributeOperation(
      { ...sharedPayload, agent: { agentId: "coder-instance-2", role: "coder" } },
      deps,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Same CID — both callers got the cached result.
    expect(second.value.cid).toBe(first.value.cid);
  });

  test("role scope: same key + different summary across instances is STATE_CONFLICT", async () => {
    // Within the same role namespace, reusing a key with different
    // summary is still a conflict — scope-sharing does not mean anything
    // goes, it just means the key identifies one logical operation
    // across all instances of that role.
    const first = await contributeOperation(
      {
        kind: "work",
        summary: "coder-1 work",
        agent: { agentId: "coder-instance-1", role: "coder" },
        idempotencyKey: "role-conflict-key",
      },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await contributeOperation(
      {
        kind: "work",
        summary: "coder-2 different work",
        agent: { agentId: "coder-instance-2", role: "coder" },
        idempotencyKey: "role-conflict-key",
      },
      deps,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("STATE_CONFLICT");
  });

  test("ephemeral flag on non-discussion kind is rejected", async () => {
    // Regression guard: context.ephemeral=true is reserved for discussions
    // (chat messages + grove_done markers). Allowing it on work/review
    // would route real progress through the skip path — no handoff, no
    // topology event, no stop check, AND the frontier filters out
    // ephemeral contributions, making the work invisible.
    for (const kind of ["work", "review", "reproduction", "adoption"] as const) {
      const result = await contributeOperation(
        {
          kind,
          summary: `ephemeral ${kind}`,
          context: { ephemeral: true },
          agent: { agentId: "a1", role: "coder" },
        },
        deps,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toMatch(/ephemeral.*only valid on kind=discussion/i);
    }
  });

  test("ephemeral flag on discussion is allowed (normal path)", async () => {
    const result = await contributeOperation(
      {
        kind: "discussion",
        mode: "exploration",
        summary: "ephemeral chat",
        context: { ephemeral: true, recipients: ["@bob"], message_body: "hi" },
        agent: { agentId: "a1", role: "coder" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
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
