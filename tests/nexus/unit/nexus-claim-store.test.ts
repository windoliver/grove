/**
 * NexusClaimStore unit tests.
 *
 * Runs the full ClaimStore conformance suite against
 * NexusClaimStore + MockNexusClient, plus adapter-specific tests
 * for LRU cache behavior, retry on network error, and zone isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runClaimStoreTests } from "../../../src/core/claim-store.conformance.js";
import { makeClaim } from "../../../src/core/test-helpers.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusClaimStore } from "../../../src/nexus/nexus-claim-store.js";

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

  // -----------------------------------------------------------------------
  // storeIdentity
  // -----------------------------------------------------------------------

  test("storeIdentity includes zone", () => {
    expect(store.storeIdentity).toBe("nexus:test-zone:claims");
  });
});
