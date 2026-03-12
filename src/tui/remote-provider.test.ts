/**
 * Tests for the remote TUI data provider.
 *
 * Spins up an in-process Hono server via Bun.serve and runs
 * the conformance suite against RemoteDataProvider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { computeCid } from "../core/manifest.js";
import type { ContributionInput } from "../core/models.js";
import { createTestApp } from "../server/test-helpers.js";
import { runProviderConformanceTests } from "./provider.conformance.js";
import { RemoteDataProvider } from "./remote-provider.js";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeContribution(
  overrides: Partial<ContributionInput> = {},
): ContributionInput & { cid: string } {
  const input: ContributionInput = {
    kind: "work",
    mode: "evaluation",
    summary: overrides.summary ?? "Test contribution",
    artifacts: {},
    relations: overrides.relations ?? [],
    tags: overrides.tags ?? ["test"],
    agent: overrides.agent ?? { agentId: "agent-1", agentName: "Alice" },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    scores: overrides.scores,
    context: overrides.context,
    ...overrides,
  };
  const cid = computeCid(input);
  return { cid, ...input };
}

// ---------------------------------------------------------------------------
// Factory for conformance suite
// ---------------------------------------------------------------------------

async function createTestProvider(): Promise<{
  provider: RemoteDataProvider;
  testCid: string;
  cleanup: () => void;
}> {
  const ctx = createTestApp();

  const c1 = makeContribution({ summary: "Initial work" });
  const c2 = makeContribution({
    summary: "Follow-up work",
    relations: [{ targetCid: c1.cid, relationType: "derives_from" }],
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  const c3 = makeContribution({
    kind: "review",
    summary: "Review of initial work",
    relations: [{ targetCid: c1.cid, relationType: "reviews" }],
    createdAt: new Date(Date.now() + 2000).toISOString(),
  });

  // Seed contributions via the store directly
  ctx.contributionStore.put({ manifestVersion: 1, ...c1 });
  ctx.contributionStore.put({ manifestVersion: 1, ...c2 });
  ctx.contributionStore.put({ manifestVersion: 1, ...c3 });

  // Seed a claim
  await ctx.claimStore.createClaim({
    claimId: `claim-${Date.now()}`,
    targetRef: c1.cid,
    agent: { agentId: "agent-1", agentName: "Alice" },
    status: "active",
    intentSummary: "Working on it",
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  });

  // Start an ephemeral server
  const server = Bun.serve({
    port: 0,
    fetch: ctx.app.fetch,
  });

  const provider = new RemoteDataProvider(`http://localhost:${server.port}`);

  return {
    provider,
    testCid: c1.cid,
    cleanup: () => {
      server.stop(true);
    },
  };
}

// Run the conformance suite
runProviderConformanceTests("RemoteDataProvider", createTestProvider);

// ---------------------------------------------------------------------------
// Additional remote-specific tests
// ---------------------------------------------------------------------------

describe("RemoteDataProvider specific", () => {
  let provider: RemoteDataProvider;
  let cleanup: () => void;

  beforeAll(async () => {
    const result = await createTestProvider();
    provider = result.provider;
    cleanup = result.cleanup;
  });

  afterAll(() => cleanup());

  test("getDashboard includes backendLabel", async () => {
    const dashboard = await provider.getDashboard();
    expect(dashboard.metadata.backendLabel).toBeDefined();
    expect(typeof dashboard.metadata.backendLabel).toBe("string");
  });

  test("getContribution returns undefined for non-existent CID", async () => {
    const detail = await provider.getContribution(
      "blake3:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(detail).toBeUndefined();
  });
});
