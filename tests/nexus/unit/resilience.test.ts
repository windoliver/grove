/**
 * Resilience tests for Nexus adapters.
 *
 * Tests retry behavior, error classification, and failure recovery
 * using MockNexusClient failure injection.
 */

import { describe, expect, test } from "bun:test";
import { makeContribution } from "../../../src/core/test-helpers.js";
import {
  isRetryable,
  NexusAuthError,
  NexusConnectionError,
  NexusTimeoutError,
} from "../../../src/nexus/errors.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusCas } from "../../../src/nexus/nexus-cas.js";
import { NexusContributionStore } from "../../../src/nexus/nexus-contribution-store.js";

describe("Retry behavior", () => {
  test("retries on transient connection error and succeeds", async () => {
    const client = new MockNexusClient();
    const cas = new NexusCas({
      client,
      zoneId: "retry-test",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    // First 2 calls fail, 3rd succeeds
    client.setFailureMode({ failNext: 2, failWith: "connection" });

    const data = new TextEncoder().encode("retry works");
    const hash = await cas.put(data);
    expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);

    cas.close();
    await client.close();
  });

  test("retries on timeout error and succeeds", async () => {
    const client = new MockNexusClient();
    const cas = new NexusCas({
      client,
      zoneId: "retry-test",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    client.setFailureMode({ failNext: 1, failWith: "timeout" });

    const data = new TextEncoder().encode("timeout retry");
    const hash = await cas.put(data);
    expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);

    cas.close();
    await client.close();
  });

  test("does not retry on auth error", async () => {
    const client = new MockNexusClient();
    const store = new NexusContributionStore({
      client,
      zoneId: "no-retry-test",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    client.setFailureMode({ failNext: 1, failWith: "auth" });

    const c = makeContribution({ summary: "auth fail" });
    await expect(store.put(c)).rejects.toThrow();

    store.close();
    await client.close();
  });

  test("exhausts retries and throws on persistent failure", async () => {
    const client = new MockNexusClient();
    const cas = new NexusCas({
      client,
      zoneId: "exhaust-test",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    client.setFailureMode({ failNext: 10, failWith: "connection" });

    const data = new TextEncoder().encode("will fail");
    await expect(cas.put(data)).rejects.toThrow(NexusConnectionError);

    cas.close();
    await client.close();
  });
});

describe("Error classification", () => {
  test("NexusConnectionError is retryable", () => {
    expect(isRetryable(new NexusConnectionError("test"))).toBe(true);
  });

  test("NexusTimeoutError is retryable", () => {
    expect(isRetryable(new NexusTimeoutError("test"))).toBe(true);
  });

  test("NexusAuthError is not retryable", () => {
    expect(isRetryable(new NexusAuthError("test"))).toBe(false);
  });

  test("ECONNREFUSED errors are retryable", () => {
    expect(isRetryable(new Error("ECONNREFUSED"))).toBe(true);
  });

  test("timeout errors are retryable", () => {
    expect(isRetryable(new Error("Request timeout"))).toBe(true);
  });

  test("generic errors are not retryable", () => {
    expect(isRetryable(new Error("Invalid argument"))).toBe(false);
  });
});

describe("Use-after-close", () => {
  test("CAS operations fail after close", async () => {
    const client = new MockNexusClient();
    const cas = new NexusCas({
      client,
      zoneId: "close-test",
      retryMaxAttempts: 1,
    });

    // First, store something
    const data = new TextEncoder().encode("before close");
    await cas.put(data);

    // Close the client
    await client.close();

    // Operations should now fail
    await expect(cas.put(new TextEncoder().encode("after close"))).rejects.toThrow();

    cas.close();
  });

  test("Store operations fail after client close", async () => {
    const client = new MockNexusClient();
    const store = new NexusContributionStore({
      client,
      zoneId: "close-test",
      retryMaxAttempts: 1,
    });

    await client.close();

    const c = makeContribution({ summary: "after close" });
    await expect(store.put(c)).rejects.toThrow();

    store.close();
  });
});
