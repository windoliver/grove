/**
 * Integration tests for NexusContributionStore and NexusClaimStore
 * against a real Nexus instance.
 *
 * These tests are SKIPPED unless NEXUS_URL is set in the environment.
 *
 * Usage:
 *   docker compose up nexus -d
 *   NEXUS_URL=http://localhost:2026 bun test tests/nexus/integration/
 */

import { describe, test } from "bun:test";

import { runClaimStoreTests } from "../../../src/core/claim-store.conformance.js";
import { runContributionStoreTests } from "../../../src/core/store.conformance.js";
import { NexusClaimStore } from "../../../src/nexus/nexus-claim-store.js";
import { NexusContributionStore } from "../../../src/nexus/nexus-contribution-store.js";
import { NexusHttpClient } from "../../../src/nexus/nexus-http-client.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;

function makeClient(): NexusHttpClient {
  return new NexusHttpClient({
    url: NEXUS_URL as string,
    apiKey: NEXUS_API_KEY,
    timeoutMs: 10_000,
  });
}

describe.skipIf(!NEXUS_URL)("NexusContributionStore integration", () => {
  runContributionStoreTests(async () => {
    const client = makeClient();
    const zoneId = `integration-contrib-${Date.now()}`;
    const store = new NexusContributionStore({
      client,
      zoneId,
      retryMaxAttempts: 4,
      retryBaseDelayMs: 500,
    });

    return {
      store,
      cleanup: async () => {
        store.close();
        await client.close();
      },
    };
  });

  test("placeholder — skipped when NEXUS_URL not set", () => {});
});

describe.skipIf(!NEXUS_URL)("NexusClaimStore integration", () => {
  runClaimStoreTests(async () => {
    const client = makeClient();
    const zoneId = `integration-claims-${Date.now()}`;
    const store = new NexusClaimStore({
      client,
      zoneId,
      retryMaxAttempts: 4,
      retryBaseDelayMs: 500,
    });

    return {
      store,
      cleanup: async () => {
        store.close();
        await client.close();
      },
    };
  });

  test("placeholder — skipped when NEXUS_URL not set", () => {});
});
