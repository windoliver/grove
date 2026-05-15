/**
 * NexusClaimStore unit tests.
 *
 * Runs the full ClaimStore conformance suite against
 * NexusClaimStore + MockNexusClient, plus adapter-specific tests
 * for LRU cache behavior, retry on network error, and zone isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { expectOk } from "../../../src/core/cas.js";
import { runClaimStoreTests } from "../../../src/core/claim-store.conformance.js";
import { StateConflictError } from "../../../src/core/errors.js";
import { makeAgent, makeClaim } from "../../../src/core/test-helpers.js";
import type { ReadResult, WriteOptions, WriteResult } from "../../../src/nexus/client.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusClaimStore } from "../../../src/nexus/nexus-claim-store.js";
import { activeClaimIndexPath, claimPath, targetLockPath } from "../../../src/nexus/vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decodeJson(data: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(data)) as Record<string, unknown>;
}

async function readJson(client: MockNexusClient, path: string): Promise<Record<string, unknown>> {
  const data = await client.read(path);
  if (data === undefined) throw new Error(`Missing test fixture file: ${path}`);
  return decodeJson(data);
}

// ---------------------------------------------------------------------------
// Conformance tests
// ---------------------------------------------------------------------------

runClaimStoreTests(async () => {
  const client = new MockNexusClient();
  const store = new NexusClaimStore({
    client,
    zoneId: "test-zone",
    retryMaxAttempts: 1, // No retries in conformance tests
  });
  return {
    store,
    cleanup: async () => {
      await client.close();
    },
  };
});

// ---------------------------------------------------------------------------
// Adapter-specific tests
// ---------------------------------------------------------------------------

describe("NexusClaimStore adapter-specific", () => {
  let client: MockNexusClient;
  let store: NexusClaimStore;

  beforeEach(() => {
    client = new MockNexusClient();
    store = new NexusClaimStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
    });
  });

  afterEach(async () => {
    store.close();
    await client.close();
  });

  // -----------------------------------------------------------------------
  // Zone isolation
  // -----------------------------------------------------------------------

  test("zone isolation: different zones have separate claims", async () => {
    const storeB = new NexusClaimStore({
      client,
      zoneId: "other-zone",
      retryMaxAttempts: 1,
    });

    const claim = makeClaim();
    await store.createClaim(claim);

    expect(await store.getClaim(claim.claimId)).toBeDefined();
    expect(await storeB.getClaim(claim.claimId)).toBeUndefined();

    storeB.close();
  });

  // -----------------------------------------------------------------------
  // LRU cache behavior
  // -----------------------------------------------------------------------

  test("getClaim returns cached claim without hitting client on second read", async () => {
    const claim = makeClaim({ claimId: "cache-test" });
    await store.createClaim(claim);

    // First getClaim populates cache
    const first = await store.getClaim("cache-test");
    expect(first).toBeDefined();
    expect(first?.claimId).toBe("cache-test");

    // Close the client to prove the second read comes from cache
    await client.close();

    // Second getClaim should return from LRU cache (not hit the closed client)
    const second = await store.getClaim("cache-test");
    expect(second).toBeDefined();
    expect(second?.claimId).toBe("cache-test");
  });

  test("cache is invalidated on heartbeat (fresh state returned)", async () => {
    const claim = makeClaim({ claimId: "hb-cache" });
    const created = await store.createClaim(claim);
    const originalHeartbeat = created.heartbeatAt;

    const updated = await store.heartbeat("hb-cache");
    expect(new Date(updated.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
      new Date(originalHeartbeat).getTime(),
    );

    // getClaim should return the updated version (cache was refreshed)
    const retrieved = await store.getClaim("hb-cache");
    expect(retrieved?.heartbeatAt).toBe(updated.heartbeatAt);
    expect(retrieved?.revision).toBe(updated.revision);
  });

  // -----------------------------------------------------------------------
  // Retry on network error
  // -----------------------------------------------------------------------

  test("heartbeat retries on transient connection error and succeeds", async () => {
    const retryClient = new MockNexusClient();
    const retryStore = new NexusClaimStore({
      client: retryClient,
      zoneId: "retry-zone",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const claim = makeClaim({ claimId: "retry-hb" });
    await retryStore.createClaim(claim);

    // Next 2 calls fail, then succeeds
    retryClient.setFailureMode({ failNext: 2, failWith: "connection" });

    const updated = await retryStore.heartbeat("retry-hb");
    expect(updated.claimId).toBe("retry-hb");
    expect(updated.revision).toBe(2);

    retryStore.close();
    await retryClient.close();
  });

  // -----------------------------------------------------------------------
  // Revision tracking
  // -----------------------------------------------------------------------

  test("revision increments on each mutation", async () => {
    const claim = makeClaim({ claimId: "rev-track" });
    const created = await store.createClaim(claim);
    expect(created.revision).toBe(1);

    const heartbeated = await store.heartbeat("rev-track");
    expect(heartbeated.revision).toBe(2);

    const released = await store.release("rev-track");
    expect(released.revision).toBe(3);
  });

  test("patchClaimStatus preserves spec fields in Nexus compatibility storage", async () => {
    const created = expectOk(
      await store.putClaimSpec({
        id: "nexus-split",
        roleName: "coder",
        platform: "codex",
        targetRef: "target-nexus-split",
        agent: { agentId: "agent-nexus", role: "coder", platform: "codex" },
        intentSummary: "nexus split",
        createdAt: "2026-01-01T00:00:00.000Z",
        generation: 1,
      }),
    );

    const patched = expectOk(
      await store.patchClaimStatus("nexus-split", {
        phase: "completed",
        observedGeneration: created.spec.generation,
        lastHeartbeatAt: "2026-01-01T00:05:00.000Z",
      }),
    );

    expect(patched.spec.intentSummary).toBe("nexus split");
    expect(patched.spec.generation).toBe(created.spec.generation);
    expect(patched.status.phase).toBe("completed");
    expect(patched.status.revision).toBe(created.status.revision + 1);
  });

  test("patchClaimStatus maps active target conflicts to StateConflictError", async () => {
    const now = Date.now();
    const oldCreatedAt = new Date(now).toISOString();
    const oldReleasedAt = new Date(now + 1_000).toISOString();
    const newCreatedAt = new Date(now + 2_000).toISOString();
    const oldReactivatedAt = new Date(now + 3_000).toISOString();
    const activeLeaseExpiresAt = new Date(now + 600_000).toISOString();

    await store.putClaimSpec({
      id: "nexus-activation-old",
      targetRef: "target-nexus-activation",
      agent: makeAgent({ agentId: "agent-nexus-activation-old" }),
      intentSummary: "old activation candidate",
      createdAt: oldCreatedAt,
      generation: 1,
    });
    await store.patchClaimStatus("nexus-activation-old", {
      phase: "released",
      lastHeartbeatAt: oldReleasedAt,
      lastTransitionAt: oldReleasedAt,
    });

    await store.putClaimSpec({
      id: "nexus-activation-new",
      targetRef: "target-nexus-activation",
      agent: makeAgent({ agentId: "agent-nexus-activation-new" }),
      intentSummary: "new active holder",
      createdAt: newCreatedAt,
      generation: 1,
    });

    await expect(
      store.patchClaimStatus("nexus-activation-old", {
        phase: "active",
        lastHeartbeatAt: oldReactivatedAt,
        leaseExpiresAt: activeLeaseExpiresAt,
        lastTransitionAt: oldReactivatedAt,
      }),
    ).rejects.toThrow(StateConflictError);
  });

  test("legacy heartbeat and release preserve split-only status fields", async () => {
    const created = expectOk(
      await store.putClaimSpec({
        id: "split-status-preserve",
        targetRef: "target-split-status-preserve",
        agent: makeAgent({ agentId: "agent-split-status-preserve" }),
        intentSummary: "preserve split-only status fields",
        createdAt: new Date().toISOString(),
        generation: 1,
      }),
    );
    await store.patchClaimStatus("split-status-preserve", {
      observedGeneration: created.spec.generation,
      agentSessionId: "session-preserved",
      currentContributionCid:
        "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      conditions: [
        {
          type: "Accepted",
          status: "True",
          observedGeneration: created.spec.generation,
          lastTransitionTime: "2026-01-01T00:01:00.000Z",
          reason: "controller",
          message: "accepted",
        },
      ],
      lastTransitionAt: "2026-01-01T00:01:00.000Z",
    });

    await store.heartbeat("split-status-preserve");
    const afterHeartbeat = await store.getClaimView("split-status-preserve");
    expect(afterHeartbeat?.status.agentSessionId).toBe("session-preserved");
    expect(afterHeartbeat?.status.currentContributionCid).toBe(
      "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(afterHeartbeat?.status.conditions[0]?.type).toBe("Accepted");
    expect(afterHeartbeat?.status.lastTransitionAt).toBe("2026-01-01T00:01:00.000Z");
    expect(afterHeartbeat?.status.observedGeneration).toBe(created.spec.generation);

    await store.release("split-status-preserve");
    const afterRelease = await store.getClaimView("split-status-preserve");
    expect(afterRelease?.status.agentSessionId).toBe("session-preserved");
    expect(afterRelease?.status.currentContributionCid).toBe(
      "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(afterRelease?.status.conditions[0]?.type).toBe("Accepted");
    expect(afterRelease?.status.lastTransitionAt).toBe("2026-01-01T00:01:00.000Z");
    expect(afterRelease?.status.observedGeneration).toBe(created.spec.generation);
  });

  test("moved active claim leaves old target reusable and absent from old active scan", async () => {
    await store.putClaimSpec({
      id: "moved-active",
      targetRef: "target-before-move",
      agent: makeAgent({ agentId: "agent-moved-active" }),
      intentSummary: "before move",
      createdAt: new Date().toISOString(),
      generation: 1,
    });
    await store.getClaim("moved-active");

    const path = claimPath("test-zone", "moved-active");
    const document = await readJson(client, path);
    const spec = document.spec as Record<string, unknown>;
    await client.write(
      path,
      encodeJson({ ...document, spec: { ...spec, targetRef: "target-after-move" } }),
    );

    const oldTargetClaims = await store.activeClaims("target-before-move");
    expect(oldTargetClaims.map((claim) => claim.claimId)).not.toContain("moved-active");

    const replacement = expectOk(
      await store.putClaimSpec({
        id: "old-target-replacement",
        targetRef: "target-before-move",
        agent: makeAgent({ agentId: "agent-old-target-replacement" }),
        intentSummary: "replacement",
        createdAt: new Date().toISOString(),
        generation: 1,
      }),
    );
    expect(replacement.spec.id).toBe("old-target-replacement");
  });

  test("putClaimSpec active move releases the old target and reports only the new target", async () => {
    const created = expectOk(
      await store.putClaimSpec({
        id: "normal-active-move",
        targetRef: "target-normal-move-old",
        agent: makeAgent({ agentId: "agent-normal-active-move" }),
        intentSummary: "before normal move",
        createdAt: new Date().toISOString(),
        generation: 1,
      }),
    );

    const moved = expectOk(
      await store.putClaimSpec({
        ...created.spec,
        targetRef: "target-normal-move-new",
        intentSummary: "after normal move",
      }),
    );

    const oldTargetClaims = await store.activeClaims("target-normal-move-old");
    const newTargetClaims = await store.activeClaims("target-normal-move-new");
    expect(oldTargetClaims.map((claim) => claim.claimId)).not.toContain("normal-active-move");
    expect(newTargetClaims.map((claim) => claim.claimId)).toContain("normal-active-move");

    const oldReplacement = expectOk(
      await store.putClaimSpec({
        id: "normal-move-old-replacement",
        targetRef: "target-normal-move-old",
        agent: makeAgent({ agentId: "agent-normal-move-old-replacement" }),
        intentSummary: "old target replacement",
        createdAt: new Date().toISOString(),
        generation: 1,
      }),
    );
    expect(moved.spec.targetRef).toBe("target-normal-move-new");
    expect(oldReplacement.spec.id).toBe("normal-move-old-replacement");
  });

  test("claimOrRenew active conflict check bypasses stale flat cache entries", async () => {
    const cached = await store.createClaim(
      makeClaim({
        claimId: "cached-active",
        targetRef: "target-cache-bypass",
        agent: makeAgent({ agentId: "agent-cached-active" }),
      }),
    );
    await store.getClaim(cached.claimId);

    const path = claimPath("test-zone", "cached-active");
    const document = await readJson(client, path);
    const status = document.status as Record<string, unknown>;
    await client.write(path, encodeJson({ ...document, status: { ...status, phase: "released" } }));

    const created = await store.claimOrRenew(
      makeClaim({
        claimId: "fresh-after-cache",
        targetRef: "target-cache-bypass",
        agent: makeAgent({ agentId: "agent-fresh-after-cache" }),
      }),
    );

    expect(created.claimId).toBe("fresh-after-cache");
  });

  test("rollback after active-index conflict does not delete a claim file with a newer etag", async () => {
    class ConcurrentRollbackClient extends MockNexusClient {
      async write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteResult> {
        try {
          return await super.write(path, content, opts);
        } catch (err) {
          if (
            path === targetLockPath("rollback-zone", "rollback-target") &&
            opts?.ifNoneMatch === "*"
          ) {
            await super.write(
              claimPath("rollback-zone", "rollback-race"),
              encodeJson({
                spec: {
                  id: "rollback-race",
                  targetRef: "rollback-target",
                  agent: makeAgent({ agentId: "agent-concurrent" }),
                  intentSummary: "concurrent survivor",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  generation: 2,
                },
                status: {
                  id: "rollback-race",
                  phase: "active",
                  observedGeneration: 1,
                  lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
                  leaseExpiresAt: "2026-01-01T00:10:00.000Z",
                  conditions: [],
                  lastTransitionAt: "2026-01-01T00:00:00.000Z",
                  attemptCount: 0,
                  revision: 2,
                },
              }),
            );
          }
          throw err;
        }
      }
    }

    const rollbackClient = new ConcurrentRollbackClient();
    const rollbackStore = new NexusClaimStore({
      client: rollbackClient,
      zoneId: "rollback-zone",
      retryMaxAttempts: 1,
    });
    try {
      await rollbackStore.createClaim(
        makeClaim({
          claimId: "rollback-holder",
          targetRef: "rollback-target",
          agent: makeAgent({ agentId: "agent-rollback-holder" }),
        }),
      );

      await expect(
        rollbackStore.createClaim(
          makeClaim({
            claimId: "rollback-race",
            targetRef: "rollback-target",
            agent: makeAgent({ agentId: "agent-rollback-race" }),
          }),
        ),
      ).rejects.toThrow(/active claim/);

      const survivor = await rollbackStore.getClaimView("rollback-race");
      expect(survivor?.spec.intentSummary).toBe("concurrent survivor");
      expect(survivor?.spec.generation).toBe(2);
    } finally {
      rollbackStore.close();
      await rollbackClient.close();
    }
  });

  test("rollback ownership read failure preserves acquired active target state", async () => {
    class FailingRollbackReadClient extends MockNexusClient {
      private raceNextMoveCas = true;
      private failNextOwnershipRead = false;

      async write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteResult> {
        if (
          path === claimPath("rollback-read-fail-zone", "rollback-read-fail") &&
          opts?.ifMatch !== undefined &&
          this.raceNextMoveCas
        ) {
          this.raceNextMoveCas = false;
          this.failNextOwnershipRead = true;
          await super.write(path, content);
        }
        return super.write(path, content, opts);
      }

      async readWithMeta(path: string): Promise<ReadResult | undefined> {
        if (
          path === claimPath("rollback-read-fail-zone", "rollback-read-fail") &&
          this.failNextOwnershipRead
        ) {
          this.failNextOwnershipRead = false;
          throw new Error("forced ownership read failure");
        }
        return super.readWithMeta(path);
      }
    }

    const rollbackClient = new FailingRollbackReadClient();
    const rollbackStore = new NexusClaimStore({
      client: rollbackClient,
      zoneId: "rollback-read-fail-zone",
      retryMaxAttempts: 1,
    });
    try {
      const created = expectOk(
        await rollbackStore.putClaimSpec({
          id: "rollback-read-fail",
          targetRef: "rollback-read-fail-old",
          agent: makeAgent({ agentId: "agent-rollback-read-fail" }),
          intentSummary: "before rollback read failure",
          createdAt: new Date().toISOString(),
          generation: 1,
        }),
      );

      await expect(
        rollbackStore.putClaimSpec({
          ...created.spec,
          targetRef: "rollback-read-fail-new",
          intentSummary: "winning move before read failure",
        }),
      ).rejects.toThrow();

      const lock = await rollbackClient.read(
        targetLockPath("rollback-read-fail-zone", "rollback-read-fail-new"),
      );
      expect(lock === undefined ? undefined : decoder.decode(lock)).toBe("rollback-read-fail");
      await expect(
        rollbackClient.exists(
          activeClaimIndexPath(
            "rollback-read-fail-zone",
            "rollback-read-fail-new",
            "rollback-read-fail",
          ),
        ),
      ).resolves.toBe(true);
    } finally {
      rollbackStore.close();
      await rollbackClient.close();
    }
  });

  test("CAS-failed active move rollback preserves the winning same-claim activation", async () => {
    class ConcurrentMoveWinnerClient extends MockNexusClient {
      private raceNextMoveCas = true;

      async write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteResult> {
        if (
          path === claimPath("move-race-zone", "move-race") &&
          opts?.ifMatch !== undefined &&
          this.raceNextMoveCas
        ) {
          this.raceNextMoveCas = false;
          await super.write(path, content);
        }
        return super.write(path, content, opts);
      }
    }

    const moveClient = new ConcurrentMoveWinnerClient();
    const moveStore = new NexusClaimStore({
      client: moveClient,
      zoneId: "move-race-zone",
      retryMaxAttempts: 1,
    });
    try {
      const created = expectOk(
        await moveStore.putClaimSpec({
          id: "move-race",
          targetRef: "move-race-old",
          agent: makeAgent({ agentId: "agent-move-race" }),
          intentSummary: "before race",
          createdAt: new Date().toISOString(),
          generation: 1,
        }),
      );

      await expect(
        moveStore.putClaimSpec({
          ...created.spec,
          targetRef: "move-race-new",
          intentSummary: "winning move",
        }),
      ).rejects.toThrow();

      const moved = await moveStore.getClaimView("move-race");
      const newTargetClaims = await moveStore.activeClaims("move-race-new");
      expect(moved?.spec.targetRef).toBe("move-race-new");
      expect(newTargetClaims.map((claim) => claim.claimId)).toContain("move-race");
    } finally {
      moveStore.close();
      await moveClient.close();
    }
  });

  // -----------------------------------------------------------------------
  // storeIdentity
  // -----------------------------------------------------------------------

  test("storeIdentity includes zone", () => {
    expect(store.storeIdentity).toBe("nexus:test-zone:claims");
  });
});
