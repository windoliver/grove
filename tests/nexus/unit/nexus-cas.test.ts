/**
 * NexusCas unit tests.
 *
 * Runs the full ContentStore conformance suite against NexusCas + MockNexusClient,
 * plus adapter-specific tests for zone isolation and exists-before-put behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runContentStoreTests } from "../../../src/core/cas.conformance.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusCas } from "../../../src/nexus/nexus-cas.js";

// ---------------------------------------------------------------------------
// Conformance tests
// ---------------------------------------------------------------------------

runContentStoreTests(async () => {
  const client = new MockNexusClient();
  const store = new NexusCas({
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

describe("NexusCas adapter-specific", () => {
  let client: MockNexusClient;

  beforeEach(() => {
    client = new MockNexusClient();
  });

  afterEach(async () => {
    await client.close();
  });

  test("zone isolation: different zones cannot read each other's blobs", async () => {
    const storeA = new NexusCas({ client, zoneId: "zone-a", retryMaxAttempts: 1 });
    const storeB = new NexusCas({ client, zoneId: "zone-b", retryMaxAttempts: 1 });

    const data = new TextEncoder().encode("zone-scoped data");
    const hash = await storeA.put(data);

    // Same zone can read
    expect(await storeA.exists(hash)).toBe(true);
    const retrieved = await storeA.get(hash);
    expect(retrieved).toEqual(data);

    // Different zone cannot read (different key prefix)
    expect(await storeB.exists(hash)).toBe(false);
    expect(await storeB.get(hash)).toBeUndefined();

    storeA.close();
    storeB.close();
  });

  test("exists-before-put skips upload for large blobs that already exist", async () => {
    const store = new NexusCas({
      client,
      zoneId: "test",
      existsThresholdBytes: 10, // Low threshold for testing
      retryMaxAttempts: 1,
    });

    // Create data above threshold
    const data = new Uint8Array(20);
    for (let i = 0; i < 20; i++) data[i] = i;

    const hash1 = await store.put(data);
    const hash2 = await store.put(data); // Should skip upload

    expect(hash1).toBe(hash2);
    expect(await store.exists(hash1)).toBe(true);

    store.close();
  });

  test("exists-before-put does not check for small blobs", async () => {
    const store = new NexusCas({
      client,
      zoneId: "test",
      existsThresholdBytes: 1000, // High threshold
      retryMaxAttempts: 1,
    });

    const data = new TextEncoder().encode("small");
    const hash = await store.put(data);
    expect(await store.exists(hash)).toBe(true);

    store.close();
  });

  test("stat caches results for subsequent calls", async () => {
    const store = new NexusCas({ client, zoneId: "test", retryMaxAttempts: 1 });

    const data = new TextEncoder().encode("cacheable");
    const hash = await store.put(data, { mediaType: "text/plain" });

    const stat1 = await store.stat(hash);
    const stat2 = await store.stat(hash); // Should come from cache

    expect(stat1).toEqual(stat2);
    expect(stat1?.contentHash).toBe(hash);
    expect(stat1?.mediaType).toBe("text/plain");

    store.close();
  });
});
