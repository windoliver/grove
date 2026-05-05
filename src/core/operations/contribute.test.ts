/**
 * Tests for contribution operations.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { LocalEventBus } from "../local-event-bus.js";
import { ROUTING_SIGNATURE_CONTEXT_KEY } from "../routing-provenance.js";
import type { AgentTopology } from "../topology.js";
import { TopologyRouter } from "../topology-router.js";
import type { EntityWriteEvent } from "../watch-events.js";
import {
  _resetIdempotencyCacheForTests,
  contributeOperation,
  discussOperation,
  reproduceOperation,
  reviewOperation,
} from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import type { FullOperationDeps, TestOperationDeps } from "./test-helpers.js";
import {
  createMockHandoffStore,
  createTestOperationDeps,
  makeInMemoryContributionStore,
  storeTestContent,
} from "./test-helpers.js";

/** Minimal topology: coder routes to reviewer. Used to populate routedTo in writeSerial. */
const twoRoleTopology: AgentTopology = {
  structure: "graph",
  roles: [
    { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" }] },
    { name: "reviewer", edges: [{ target: "coder", edgeType: "feedback" }] },
  ],
};

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

  test("stamps runtime routing signature into contribution context", async () => {
    const prevRoutingToken = process.env.GROVE_ROUTING_TOKEN;
    process.env.GROVE_ROUTING_TOKEN = "routing-token-1";
    try {
      const result = await contributeOperation(
        {
          kind: "work",
          summary: "runtime routing signature",
          context: { note: "hello" },
          agent: { agentId: "worker-a" },
        },
        deps,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = await deps.contributionStore.get(result.value.cid);
      const context = stored?.context as Record<string, unknown> | undefined;
      expect(context?.note).toBe("hello");
      expect(context?.[ROUTING_SIGNATURE_CONTEXT_KEY]).toMatch(/^[a-f0-9]{64}$/);
      expect(context?.[ROUTING_SIGNATURE_CONTEXT_KEY]).not.toBe("routing-token-1");
    } finally {
      if (prevRoutingToken === undefined) {
        delete process.env.GROVE_ROUTING_TOKEN;
      } else {
        process.env.GROVE_ROUTING_TOKEN = prevRoutingToken;
      }
    }
  });

  test("runtime routing signature overrides caller-supplied reserved context key", async () => {
    const prevRoutingToken = process.env.GROVE_ROUTING_TOKEN;
    process.env.GROVE_ROUTING_TOKEN = "runtime-token";
    try {
      const result = await contributeOperation(
        {
          kind: "work",
          summary: "reserved context override",
          context: { [ROUTING_SIGNATURE_CONTEXT_KEY]: "spoofed-token" },
          agent: { agentId: "worker-a" },
        },
        deps,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = await deps.contributionStore.get(result.value.cid);
      const context = stored?.context as Record<string, unknown> | undefined;
      expect(context?.[ROUTING_SIGNATURE_CONTEXT_KEY]).toMatch(/^[a-f0-9]{64}$/);
      expect(context?.[ROUTING_SIGNATURE_CONTEXT_KEY]).not.toBe("spoofed-token");
    } finally {
      if (prevRoutingToken === undefined) {
        delete process.env.GROVE_ROUTING_TOKEN;
      } else {
        process.env.GROVE_ROUTING_TOKEN = prevRoutingToken;
      }
    }
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

  test("fingerprint rejects same key + different context (plan tasks)", async () => {
    // Plans store their task list in context.tasks. Two calls with the
    // same key but different task lists must be rejected, not silently
    // return the first result.
    const first = await contributeOperation(
      {
        kind: "plan",
        mode: "exploration",
        summary: "Phase 1",
        context: {
          plan_title: "Phase 1",
          tasks: [{ id: "t1", title: "Design", status: "todo" }] as never,
        },
        agent: { agentId: "a1" },
        idempotencyKey: "plan-context-key",
      },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await contributeOperation(
      {
        kind: "plan",
        mode: "exploration",
        summary: "Phase 1",
        context: {
          plan_title: "Phase 1",
          // Same task id, DIFFERENT status — would leave the first call's
          // stored state behind if not rejected.
          tasks: [{ id: "t1", title: "Design", status: "done" }] as never,
        },
        agent: { agentId: "a1" },
        idempotencyKey: "plan-context-key",
      },
      deps,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("STATE_CONFLICT");
  });

  test("fingerprint rejects same key + different scores", async () => {
    const first = await contributeOperation(
      {
        kind: "work",
        summary: "metric submission",
        scores: { latency: { value: 42, direction: "minimize" } },
        agent: { agentId: "a1" },
        idempotencyKey: "score-key",
      },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await contributeOperation(
      {
        kind: "work",
        summary: "metric submission",
        scores: { latency: { value: 99, direction: "minimize" } },
        agent: { agentId: "a1" },
        idempotencyKey: "score-key",
      },
      deps,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("STATE_CONFLICT");
  });

  test("fingerprint rejects same key + different commitHash", async () => {
    const first = await contributeOperation(
      {
        kind: "work",
        summary: "commit submission",
        commitHash: "abc123",
        agent: { agentId: "a1" },
        idempotencyKey: "commit-hash-key",
      },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await contributeOperation(
      {
        kind: "work",
        summary: "commit submission",
        commitHash: "def456",
        agent: { agentId: "a1" },
        idempotencyKey: "commit-hash-key",
      },
      deps,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("STATE_CONFLICT");
  });

  test("fingerprint rejects same key + renamed artifact (same hash)", async () => {
    // Store a single blob in CAS, reference it under two different names.
    const hash = await storeTestContent(deps.cas, "hello world");

    const first = await contributeOperation(
      {
        kind: "work",
        summary: "artifact submission",
        artifacts: { "greeting.txt": hash },
        agent: { agentId: "a1" },
        idempotencyKey: "artifact-name-key",
      },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await contributeOperation(
      {
        kind: "work",
        summary: "artifact submission",
        // Same hash, different filename — must be rejected, not coalesced.
        artifacts: { "hello.txt": hash },
        agent: { agentId: "a1" },
        idempotencyKey: "artifact-name-key",
      },
      deps,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("STATE_CONFLICT");
  });

  test("fingerprint is insensitive to context key order", async () => {
    // { a: 1, b: 2 } and { b: 2, a: 1 } must produce the same fingerprint
    // so equivalent payloads don't spuriously conflict. This is why
    // canonicalizeForFingerprint deeply sorts object keys.
    const first = await contributeOperation(
      {
        kind: "work",
        summary: "key-order test",
        context: { alpha: 1, beta: 2, nested: { x: 1, y: 2 } } as never,
        agent: { agentId: "a1" },
        idempotencyKey: "key-order-key",
      },
      deps,
    );
    const second = await contributeOperation(
      {
        kind: "work",
        summary: "key-order test",
        // Different insertion order at both levels — should still match.
        context: { nested: { y: 2, x: 1 }, beta: 2, alpha: 1 } as never,
        agent: { agentId: "a1" },
        idempotencyKey: "key-order-key",
      },
      deps,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.cid).toBe(first.value.cid);
  });

  test("post-commit callback failure does NOT release the idempotency slot", async () => {
    // Simulates a scenario where a user-supplied onContributionWritten
    // callback throws AFTER the contribution was durably committed.
    // Previous behavior: catch handler released the slot, and a retry
    // with the same key produced a second contribution with a new cid.
    // Fix: slot is resolved immediately after commit — post-write
    // failures are logged but don't undo the cache.
    let throwOnce = true;
    const depsWithThrowingCallback: typeof deps = {
      ...deps,
      onContributionWritten: () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("simulated post-commit callback failure");
        }
      },
    };

    const input = {
      kind: "work" as const,
      summary: "post-commit-failure",
      agent: { agentId: "a1" },
      idempotencyKey: "post-commit-key",
    };
    const first = await contributeOperation(input, depsWithThrowingCallback);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Retry with the same key — must return the cached result, not
    // create a second contribution.
    const second = await contributeOperation(input, depsWithThrowingCallback);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.cid).toBe(first.value.cid);

    // Store-level check: exactly ONE contribution with that summary.
    const stored = await deps.contributionStore.list({ limit: 20 });
    const matching = stored.filter((c) => c.summary === "post-commit-failure");
    expect(matching).toHaveLength(1);
  });

  test("serial idempotency commit failure after put does not turn committed write into error", async () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: spy suppresses output intentionally
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let storeCalls = 0;
    const flakyIdempotencyStore: FullOperationDeps["idempotencyStore"] = {
      lookup: deps.idempotencyStore.lookup.bind(deps.idempotencyStore),
      reserve: deps.idempotencyStore.reserve.bind(deps.idempotencyStore),
      rollback: deps.idempotencyStore.rollback.bind(deps.idempotencyStore),
      store: (cacheKey, fingerprint, resultJson) => {
        storeCalls++;
        if (storeCalls === 1) {
          throw new Error("simulated idempotency commit failure");
        }
        deps.idempotencyStore.store(cacheKey, fingerprint, resultJson);
      },
      clear: deps.idempotencyStore.clear.bind(deps.idempotencyStore),
    };

    // Object spread copies the store's arrow-method implementation but not
    // the prototype putWithCowrite() capability, forcing writeSerial().
    const serialContributionStore = {
      ...deps.contributionStore,
    };

    const serialDeps: FullOperationDeps = {
      ...deps,
      contributionStore: serialContributionStore,
      idempotencyStore: flakyIdempotencyStore,
    };

    const input = {
      kind: "work" as const,
      summary: "serial-idempotency-store-failure",
      agent: { agentId: "a1" },
      idempotencyKey: "serial-idempotency-store-failure-key",
    };

    const first = await contributeOperation(input, serialDeps);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await contributeOperation(input, serialDeps);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.cid).toBe(first.value.cid);

    const stored = await deps.contributionStore.list({ limit: 20 });
    const matching = stored.filter((c) => c.summary === "serial-idempotency-store-failure");
    expect(matching).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
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

  test("durable idempotency reservation is released after ephemeral validation failure", async () => {
    const input = {
      kind: "work" as const,
      summary: "invalid ephemeral with idempotency",
      context: { ephemeral: true },
      agent: { agentId: "a1" },
      idempotencyKey: `invalid-ephemeral-${crypto.randomUUID()}`,
    };

    const first = await contributeOperation(input, deps);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe("VALIDATION_ERROR");

    const second = await contributeOperation(input, deps);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("VALIDATION_ERROR");
    expect(second.error.message).toMatch(/ephemeral.*only valid on kind=discussion/i);
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

  test("identical payloads without idempotencyKey dedup by content hash", async () => {
    const first = await contributeOperation(
      { kind: "work", summary: "duplicate", agent: { agentId: "a1" } },
      deps,
    );
    const second = await contributeOperation(
      { kind: "work", summary: "duplicate", agent: { agentId: "a1" } },
      deps,
    );
    const third = await contributeOperation(
      { kind: "work", summary: "duplicate", agent: { agentId: "a1" } },
      deps,
    );
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    expect(first.value.accepted).toBe(1);
    expect(first.value.duplicate).toBe(0);
    expect(second.value.accepted).toBe(0);
    expect(second.value.duplicate).toBe(1);
    expect(third.value.accepted).toBe(0);
    expect(third.value.duplicate).toBe(1);
    expect(second.value.cid).toBe(first.value.cid);
    expect(third.value.cid).toBe(first.value.cid);

    const stored = await deps.contributionStore.list({ limit: 20 });
    const matching = stored.filter((c) => c.summary === "duplicate");
    expect(matching).toHaveLength(1);
  });

  test("identical gated payloads dedup before metric gate rejection", async () => {
    const gatedDeps: OperationDeps = {
      ...deps,
      contract: {
        contractVersion: 3,
        name: "gated",
        mode: "evaluation",
        metrics: { val_bpb: { direction: "minimize" } },
        gates: [{ type: "metric_improves", metric: "val_bpb" }],
      },
    };
    const input = {
      kind: "work" as const,
      summary: "gated duplicate",
      scores: { val_bpb: { value: 0.99, direction: "minimize" as const } },
      agent: { agentId: "a1" },
    };

    const first = await contributeOperation(input, gatedDeps);
    const second = await contributeOperation(input, gatedDeps);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.accepted).toBe(1);
    expect(first.value.duplicate).toBe(0);
    expect(second.value.accepted).toBe(0);
    expect(second.value.duplicate).toBe(1);
    expect(second.value.cid).toBe(first.value.cid);
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

  test("fails when target is not a work contribution", async () => {
    // Create a discussion, then try to review it.
    const discussion = await discussOperation(
      { summary: "a topic", agent: { agentId: "a1" } },
      deps,
    );
    expect(discussion.ok).toBe(true);
    if (!discussion.ok) return;

    const result = await reviewOperation(
      {
        targetCid: discussion.value.cid,
        summary: "Trying to review a discussion",
        agent: { agentId: "reviewer" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("discussion");
    }
  });

  test("returns structured error when contributionStore.get throws", async () => {
    // Wrap the store so get() always throws — simulates a closed DB or
    // transient Nexus fault. The preflight kind lookup must convert that
    // into an OperationResult error, not let it escape as an exception.
    const throwingDeps: FullOperationDeps = {
      ...deps,
      contributionStore: {
        ...deps.contributionStore,
        get: async () => {
          throw new Error("simulated store failure");
        },
        getMany: async () => {
          throw new Error("simulated store failure");
        },
      },
    };

    const result = await reviewOperation(
      {
        targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "should not throw",
        agent: { agentId: "reviewer" },
      },
      throwingDeps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
  });

  test("two staggered same-key concurrent calls produce exactly one review", async () => {
    // Round 3 concern: without sync check-then-reserve, two same-key
    // callers could both miss the cache, both spend time in
    // validateRelations, and both proceed to write — duplicating the
    // review. Simulate that by delaying getMany; the second caller MUST
    // observe the first caller's pending slot synchronously.
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const slowDeps: FullOperationDeps = {
      ...deps,
      contributionStore: {
        ...deps.contributionStore,
        getMany: async (cids) => {
          await new Promise((r) => setTimeout(r, 50));
          return deps.contributionStore.getMany(cids);
        },
      },
    };

    const key = `review-concurrent-${crypto.randomUUID()}`;
    const makeCall = () =>
      reviewOperation(
        {
          targetCid: target.value.cid,
          summary: "concurrent",
          idempotencyKey: key,
          agent: { agentId: "reviewer" },
        },
        slowDeps,
      );

    const first = makeCall();
    // Stagger by 10ms so the second call enters after the first is past
    // its sync check-then-reserve but still awaiting getMany.
    await new Promise((r) => setTimeout(r, 10));
    const second = makeCall();

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r1.value.cid).toBe(r2.value.cid);
  });

  test("idempotent retry returns cached result even when store read fails", async () => {
    // First call: success. Cache stores the committed result.
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const key = `review-retry-${crypto.randomUUID()}`;
    const first = await reviewOperation(
      {
        targetCid: target.value.cid,
        summary: "looks good",
        idempotencyKey: key,
        agent: { agentId: "reviewer" },
      },
      deps,
    );
    expect(first.ok).toBe(true);

    // Second call: same key, but store reads now fail transiently. The
    // idempotency cache short-circuit must return the first result
    // without hitting validateRelations. Without the read-before-validate
    // ordering fix, this would return INTERNAL_ERROR.
    const flakyDeps: FullOperationDeps = {
      ...deps,
      contributionStore: {
        ...deps.contributionStore,
        getMany: async () => {
          throw new Error("transient read failure");
        },
      },
    };
    const second = await reviewOperation(
      {
        targetCid: target.value.cid,
        summary: "looks good",
        idempotencyKey: key,
        agent: { agentId: "reviewer" },
      },
      flakyDeps,
    );
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value.cid).toBe(first.value.cid);
  });

  test("staggered same-key caller does not hang when first caller throws pre-commit", async () => {
    // Round 5 regression: in-memory cache reserves the pending slot
    // BEFORE the durable lookup / validate / reserve. If those throw,
    // the catch path used to call release() — which deletes the cache
    // entry but never resolves the promise already handed to a second
    // waiter. The waiter would hang forever. Fix: resolve(errResult)
    // so concurrent callers observe the error and can retry.
    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    // First-caller deps: validateRelations throws mid-flight. The
    // second caller's in-memory cache lookup must still resolve.
    let getManyCalls = 0;
    const slowThrowingDeps: FullOperationDeps = {
      ...deps,
      contributionStore: {
        ...deps.contributionStore,
        getMany: async (cids) => {
          getManyCalls++;
          if (getManyCalls === 1) {
            // Stall so the second caller has time to attach to the
            // pending slot before we throw.
            await new Promise((r) => setTimeout(r, 40));
            throw new Error("simulated transient store fault");
          }
          return deps.contributionStore.getMany(cids);
        },
      },
    };

    const key = `hang-repro-${crypto.randomUUID()}`;
    const makeCall = (d: FullOperationDeps) =>
      reviewOperation(
        {
          targetCid: target.value.cid,
          summary: "r",
          idempotencyKey: key,
          agent: { agentId: "reviewer" },
        },
        d,
      );

    const first = makeCall(slowThrowingDeps);
    // Give first caller a chance to reserve the in-memory slot.
    await new Promise((r) => setTimeout(r, 10));
    const second = makeCall(slowThrowingDeps);

    // Must resolve within 500ms. Without the resolve-on-throw fix, the
    // second caller hangs forever because its pending promise is
    // orphaned when the first caller's catch path only called release().
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 500));
    const settled = await Promise.race([Promise.all([first, second]), timeout]);
    expect(settled).not.toBe("timeout");
    if (settled === "timeout") return;

    const [r1, r2] = settled;
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  test("pre-reserve throw does not roll back another caller's pending reservation", async () => {
    // Round 4 regression: the catch block used to unconditionally call
    // idempotencyStore.rollback(cacheKey), which would delete whatever
    // pending row existed for that key — even one placed by another
    // process. That defeated cross-process single-flight.
    //
    // Scenario: our call throws during validateRelations (before durable
    // reserve). ownsDurableReservation must still be false, so the
    // catch path must NOT call rollback.
    let rollbackCalls = 0;
    const peerReservationAlive = { value: true };
    const stubIdempotencyStore: FullOperationDeps["idempotencyStore"] = {
      lookup: () => undefined, // miss — our call will proceed into validate
      reserve: () => {
        throw new Error("should not be reached — we throw before reserve");
      },
      rollback: () => {
        rollbackCalls++;
        peerReservationAlive.value = false; // simulates deleting peer's row
      },
      store: () => {
        /* unused in this scenario */
      },
      clear: () => {
        /* unused in this scenario */
      },
    };

    const target = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const throwingDeps: FullOperationDeps = {
      ...deps,
      idempotencyStore: stubIdempotencyStore,
      contributionStore: {
        ...deps.contributionStore,
        // validateRelations calls getMany — make it throw mid-validation.
        getMany: async () => {
          throw new Error("simulated mid-validate fault");
        },
      },
    };

    const result = await reviewOperation(
      {
        targetCid: target.value.cid,
        summary: "r",
        idempotencyKey: `pre-reserve-throw-${crypto.randomUUID()}`,
        agent: { agentId: "reviewer" },
      },
      throwingDeps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(rollbackCalls).toBe(0);
    expect(peerReservationAlive.value).toBe(true);
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

  test("fails when target is not a work contribution", async () => {
    // Create a review, then try to reproduce it.
    const workTarget = await contributeOperation(
      { kind: "work", summary: "target", agent: { agentId: "a1" } },
      deps,
    );
    expect(workTarget.ok).toBe(true);
    if (!workTarget.ok) return;

    const review = await reviewOperation(
      {
        targetCid: workTarget.value.cid,
        summary: "looks good",
        agent: { agentId: "reviewer" },
      },
      deps,
    );
    expect(review.ok).toBe(true);
    if (!review.ok) return;

    const result = await reproduceOperation(
      {
        targetCid: review.value.cid,
        summary: "Trying to reproduce a review",
        agent: { agentId: "reproducer" },
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("review");
    }
  });

  test("returns structured error when contributionStore.get throws", async () => {
    const throwingDeps: FullOperationDeps = {
      ...deps,
      contributionStore: {
        ...deps.contributionStore,
        get: async () => {
          throw new Error("simulated store failure");
        },
        getMany: async () => {
          throw new Error("simulated store failure");
        },
      },
    };

    const result = await reproduceOperation(
      {
        targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "should not throw",
        agent: { agentId: "reproducer" },
      },
      throwingDeps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
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

describe("writeSerial: best-effort handoff failure paths", () => {
  // These tests use an in-memory contribution store (no putWithCowrite) so that
  // contributeOperation goes through writeSerial, not writeAtomic. A topology
  // router is needed to populate routedTo so handoff creation is actually attempted.

  function makeSerialDeps(handoffStore: OperationDeps["handoffStore"]): OperationDeps {
    const store = makeInMemoryContributionStore();
    const bus = new LocalEventBus();
    const router = new TopologyRouter(twoRoleTopology, bus);
    return { contributionStore: store, topologyRouter: router, eventBus: bus, handoffStore };
  }

  test("contribution is committed even when handoffStore.createMany throws", async () => {
    const faultyHandoffStore = createMockHandoffStore({
      create: async () => {
        throw new Error("should not be called");
      },
      createMany: async () => {
        throw new Error("simulated handoff store failure");
      },
    });

    const deps = makeSerialDeps(faultyHandoffStore);

    const result = await contributeOperation(
      { kind: "work", summary: "Handoff fault test", agent: { agentId: "worker", role: "coder" } },
      deps,
    );

    // Contribution must succeed despite handoff failure
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // handoffIds is empty because handoff creation failed (best-effort)
    expect(result.value.handoffIds ?? []).toHaveLength(0);

    // The contribution itself is durably stored
    const stored = await deps.contributionStore?.get(result.value.cid);
    expect(stored).toBeDefined();
    expect(stored!.cid).toBe(result.value.cid);
  });

  test("emits console.warn when handoffStore.createMany throws", async () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: spy suppresses output intentionally
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const faultyHandoffStore = createMockHandoffStore({
      create: async () => {
        throw new Error("should not be called");
      },
      createMany: async () => {
        throw new Error("handoff store down");
      },
    });

    const deps = makeSerialDeps(faultyHandoffStore);

    await contributeOperation(
      { kind: "work", summary: "Warning log test", agent: { agentId: "worker", role: "coder" } },
      deps,
    );

    expect(warnSpy).toHaveBeenCalled();
    const warnArg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(warnArg).toContain("[grove] handoff batch failed");

    warnSpy.mockRestore();
  });

  test("contribution survives synchronous throw from handoffStore.create() in parallel fallback", async () => {
    // Regression for codex review finding: when a HandoffStore exposes only
    // create() (no createMany), contribute falls back to a parallel fan-out via
    // Promise.allSettled. If create() throws synchronously *before* returning a
    // Promise, the throw must still be caught — otherwise the already-committed
    // contribution would bubble out as an operation error and the idempotency
    // slot would be released, allowing duplicate contributions on retry.
    // biome-ignore lint/suspicious/noEmptyBlockStatements: spy suppresses output intentionally
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    // Non-async function so the throw happens synchronously, before any
    // Promise is returned. Cast through `unknown` because the interface
    // declares an async return type.
    const syncThrowingCreate = (() => {
      throw new Error("simulated synchronous throw from create()");
    }) as unknown as NonNullable<OperationDeps["handoffStore"]>["create"];

    const syncThrowingHandoffStore = createMockHandoffStore({
      create: syncThrowingCreate,
      // No createMany — forces the fallback path.
    });

    const deps = makeSerialDeps(syncThrowingHandoffStore);

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Sync-throw fallback test",
        agent: { agentId: "worker", role: "coder" },
      },
      deps,
    );

    // Operation must succeed: the contribution is already committed, and
    // best-effort handoff failure should not surface as an error.
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No handoff IDs because every create() threw.
    expect(result.value.handoffIds ?? []).toHaveLength(0);

    // The contribution itself is durably stored.
    const stored = await deps.contributionStore?.get(result.value.cid);
    expect(stored).toBeDefined();
    expect(stored!.cid).toBe(result.value.cid);

    // We logged the per-item failure (not the batch failure path).
    const warnedAboutCreate = warnSpy.mock.calls.some((call) =>
      String(call[0] ?? "").includes("[grove] handoff create failed"),
    );
    expect(warnedAboutCreate).toBe(true);

    warnSpy.mockRestore();
  });
});

describe("contribute → onEntityWrite", () => {
  let testDeps: TestOperationDeps;

  beforeEach(async () => {
    testDeps = await createTestOperationDeps();
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("fires onEntityWrite with the projected ContributionEntity", async () => {
    const events: EntityWriteEvent[] = [];
    const deps: OperationDeps = {
      ...testDeps.deps,
      onEntityWrite: (e: EntityWriteEvent) => {
        events.push(e);
      },
      namespace: "ns/wt",
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "watch-fire test",
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.kind).toBe("Contribution");
    expect(ev?.op).toBe("ADDED");
    expect(ev?.namespace).toBe("ns/wt");
    expect(ev?.entity.namespace).toBe("ns/wt");
    expect(ev?.entity.id).toBe(result.value.cid);
    expect(ev?.entity.id).toMatch(/^blake3:/);
  });

  test("skips onEntityWrite when namespace is missing", async () => {
    const events: EntityWriteEvent[] = [];
    // Override the helper-supplied namespace with undefined so the gate trips.
    const deps: OperationDeps = {
      ...testDeps.deps,
      onEntityWrite: (e: EntityWriteEvent) => {
        events.push(e);
      },
      namespace: undefined,
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "no-namespace test",
        agent: { agentId: "a1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(0);
  });
});
