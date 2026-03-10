/**
 * NexusContributionStore and NexusClaimStore unit tests.
 *
 * Runs the full conformance suites against the Nexus adapters + MockNexusClient,
 * plus adapter-specific tests for batch operations and zone isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runClaimStoreTests } from "../../../src/core/claim-store.conformance.js";
import { runContributionStoreTests } from "../../../src/core/store.conformance.js";
import { makeClaim, makeContribution } from "../../../src/core/test-helpers.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusClaimStore } from "../../../src/nexus/nexus-claim-store.js";
import { NexusContributionStore } from "../../../src/nexus/nexus-contribution-store.js";

// ---------------------------------------------------------------------------
// ContributionStore conformance
// ---------------------------------------------------------------------------

runContributionStoreTests(async () => {
  const client = new MockNexusClient();
  const store = new NexusContributionStore({
    client,
    zoneId: "test-zone",
    retryMaxAttempts: 1,
  });
  return {
    store,
    cleanup: async () => {
      await client.close();
    },
  };
});

// ---------------------------------------------------------------------------
// ClaimStore conformance
// ---------------------------------------------------------------------------

runClaimStoreTests(async () => {
  const client = new MockNexusClient();
  const store = new NexusClaimStore({
    client,
    zoneId: "test-zone",
    retryMaxAttempts: 1,
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

describe("NexusContributionStore adapter-specific", () => {
  let client: MockNexusClient;
  let store: NexusContributionStore;

  beforeEach(() => {
    client = new MockNexusClient();
    store = new NexusContributionStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
    });
  });

  afterEach(async () => {
    store.close();
    await client.close();
  });

  test("zone isolation: different zones have separate contributions", async () => {
    const storeB = new NexusContributionStore({
      client,
      zoneId: "other-zone",
      retryMaxAttempts: 1,
    });

    const c = makeContribution({ summary: "zone test" });
    await store.put(c);

    expect(await store.get(c.cid)).toBeDefined();
    expect(await storeB.get(c.cid)).toBeUndefined();

    storeB.close();
  });

  test("revision field is set on claims", async () => {
    const claimStore = new NexusClaimStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
    });

    const claim = makeClaim();
    const created = await claimStore.createClaim(claim);
    expect(created.revision).toBe(1);

    const heartbeated = await claimStore.heartbeat(claim.claimId);
    expect(heartbeated.revision).toBe(2);

    const released = await claimStore.release(claim.claimId);
    expect(released.revision).toBe(3);

    claimStore.close();
  });

  test("putMany stores all contributions", async () => {
    const c1 = makeContribution({ summary: "batch-1" });
    const c2 = makeContribution({ summary: "batch-2" });
    const c3 = makeContribution({ summary: "batch-3" });

    await store.putMany([c1, c2, c3]);

    expect(await store.get(c1.cid)).toBeDefined();
    expect(await store.get(c2.cid)).toBeDefined();
    expect(await store.get(c3.cid)).toBeDefined();
  });

  test("storeIdentity includes zone", () => {
    expect(store.storeIdentity).toBe("nexus:test-zone:contributions");
  });
});

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

  test("storeIdentity includes zone", () => {
    expect(store.storeIdentity).toBe("nexus:test-zone:claims");
  });
});
