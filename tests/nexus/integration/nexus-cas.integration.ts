/**
 * Integration tests for NexusCas against a real Nexus instance.
 *
 * These tests are SKIPPED unless NEXUS_URL is set in the environment.
 * They run the same conformance suite as the unit tests but against
 * a real Nexus backend to validate end-to-end behavior.
 *
 * Usage:
 *   docker compose up nexus -d
 *   NEXUS_URL=http://localhost:2026 bun test tests/nexus/integration/
 */

import { describe, test } from "bun:test";

import { runContentStoreTests } from "../../../src/core/cas.conformance.js";
import { NexusCas } from "../../../src/nexus/nexus-cas.js";
import { NexusHttpClient } from "../../../src/nexus/nexus-http-client.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;

describe.skipIf(!NEXUS_URL)("NexusCas integration", () => {
  runContentStoreTests(async () => {
    const client = new NexusHttpClient({
      url: NEXUS_URL as string,
      apiKey: NEXUS_API_KEY,
      timeoutMs: 10_000,
    });

    const zoneId = `integration-cas-${Date.now()}`;
    const store = new NexusCas({
      client,
      zoneId,
      retryMaxAttempts: 2,
      retryBaseDelayMs: 100,
    });

    return {
      store,
      cleanup: async () => {
        store.close();
        await client.close();
      },
    };
  });

  test("placeholder — skipped when NEXUS_URL not set", () => {
    // This test exists to prevent the describe block from being empty
    // when conformance tests are wired up above.
  });
});
