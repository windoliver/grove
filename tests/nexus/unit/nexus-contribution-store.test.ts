/**
 * NexusContributionStore unit tests.
 *
 * Runs the full ContributionStore conformance suite against
 * NexusContributionStore + MockNexusClient, plus adapter-specific tests
 * for LRU cache behavior, retry on network error, and zone isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runContributionStoreTests } from "../../../src/core/store.conformance.js";
import { makeContribution } from "../../../src/core/test-helpers.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusContributionStore } from "../../../src/nexus/nexus-contribution-store.js";

// ---------------------------------------------------------------------------
// Conformance tests
// ---------------------------------------------------------------------------

runContributionStoreTests(async () => {
  const client = new MockNexusClient();
  const store = new NexusContributionStore({
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

  // -----------------------------------------------------------------------
  // Zone isolation
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // LRU cache behavior
  // -----------------------------------------------------------------------

  test("get returns cached contribution without hitting client on second read", async () => {
    const c = makeContribution({ summary: "cache hit" });
    await store.put(c);

    // First get populates cache
    const first = await store.get(c.cid);
    expect(first).toBeDefined();
    expect(first?.summary).toBe("cache hit");

    // Close the client to prove the second read comes from cache
    await client.close();

    // Second get should return from LRU cache (not hit the closed client)
    const second = await store.get(c.cid);
    expect(second).toBeDefined();
    expect(second?.cid).toBe(c.cid);
    expect(second?.summary).toBe("cache hit");
  });

  test("cache eviction: oldest entries are evicted when cache is full", async () => {
    // Create store with tiny cache
    const tinyStore = new NexusContributionStore({
      client,
      zoneId: "test-zone",
      cacheMaxEntries: 2,
      retryMaxAttempts: 1,
    });

    const c1 = makeContribution({ summary: "first" });
    const c2 = makeContribution({ summary: "second" });
    const c3 = makeContribution({ summary: "third" });

    await tinyStore.put(c1);
    await tinyStore.put(c2);
    await tinyStore.put(c3); // This should evict c1 from cache

    // c3 and c2 should be in cache, c1 evicted but still in VFS
    // All three should still be retrievable (c1 from VFS, c2/c3 from cache)
    expect(await tinyStore.get(c1.cid)).toBeDefined();
    expect(await tinyStore.get(c2.cid)).toBeDefined();
    expect(await tinyStore.get(c3.cid)).toBeDefined();

    tinyStore.close();
  });

  // -----------------------------------------------------------------------
  // Retry on network error
  // -----------------------------------------------------------------------

  test("put retries on transient connection error and succeeds", async () => {
    const retryClient = new MockNexusClient();
    const retryStore = new NexusContributionStore({
      client: retryClient,
      zoneId: "retry-zone",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const c = makeContribution({ summary: "retry me" });

    // First 2 calls fail, then succeeds
    retryClient.setFailureMode({ failNext: 2, failWith: "connection" });
    await retryStore.put(c);

    const retrieved = await retryStore.get(c.cid);
    expect(retrieved).toBeDefined();
    expect(retrieved?.summary).toBe("retry me");

    retryStore.close();
    await retryClient.close();
  });

  test("get retries on transient timeout error and succeeds", async () => {
    const retryClient = new MockNexusClient();
    const retryStore = new NexusContributionStore({
      client: retryClient,
      zoneId: "retry-zone",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const c = makeContribution({ summary: "timeout retry" });
    await retryStore.put(c);

    // Inject timeout for the next read
    retryClient.setFailureMode({ failNext: 1, failWith: "timeout" });

    // Clear the cache so get actually hits the client
    retryStore.close();
    const freshStore = new NexusContributionStore({
      client: retryClient,
      zoneId: "retry-zone",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const retrieved = await freshStore.get(c.cid);
    expect(retrieved).toBeDefined();
    expect(retrieved?.summary).toBe("timeout retry");

    freshStore.close();
    await retryClient.close();
  });

  // -----------------------------------------------------------------------
  // storeIdentity
  // -----------------------------------------------------------------------

  test("storeIdentity includes zone", () => {
    expect(store.storeIdentity).toBe("nexus:test-zone:contributions");
  });
});
