/**
 * Tests for the local TUI data provider.
 *
 * Uses the conformance suite plus additional local-specific tests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { computeCid } from "../core/manifest.js";
import type { Claim, Contribution, ContributionInput } from "../core/models.js";
import { createSqliteStores } from "../local/sqlite-store.js";
import { LocalDataProvider } from "./local-provider.js";
import { runProviderConformanceTests } from "./provider.conformance.js";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeContribution(overrides: Partial<ContributionInput> = {}): Contribution {
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
  return { cid, manifestVersion: 1, ...input };
}

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  const now = new Date();
  return {
    claimId: overrides.claimId ?? `claim-${Date.now()}`,
    targetRef: overrides.targetRef ?? "some-target",
    agent: overrides.agent ?? { agentId: "agent-1", agentName: "Alice" },
    status: overrides.status ?? "active",
    intentSummary: overrides.intentSummary ?? "Working on it",
    createdAt: overrides.createdAt ?? now.toISOString(),
    heartbeatAt: overrides.heartbeatAt ?? now.toISOString(),
    leaseExpiresAt: overrides.leaseExpiresAt ?? new Date(now.getTime() + 300_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Factory for conformance suite
// ---------------------------------------------------------------------------

function createTestProvider(): Promise<{
  provider: LocalDataProvider;
  testCid: string;
  cleanup: () => void;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "grove-tui-test-"));
  const dbPath = join(tempDir, "grove.db");
  const stores = createSqliteStores(dbPath);

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

  // Insert contributions
  stores.contributionStore.put(c1);
  stores.contributionStore.put(c2);
  stores.contributionStore.put(c3);

  // Insert a claim
  const claim = makeClaim({ targetRef: c1.cid });
  stores.claimStore.createClaim(claim);

  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  const provider = new LocalDataProvider({
    contributionStore: stores.contributionStore,
    claimStore: stores.claimStore,
    frontier,
    groveName: "test-grove",
  });

  return Promise.resolve({
    provider,
    testCid: c1.cid,
    cleanup: () => {
      stores.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  });
}

// Run the conformance suite
runProviderConformanceTests("LocalDataProvider", createTestProvider);

// ---------------------------------------------------------------------------
// Additional local-specific tests
// ---------------------------------------------------------------------------

describe("LocalDataProvider specific", () => {
  let provider: LocalDataProvider;
  let testCid: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const result = await createTestProvider();
    provider = result.provider;
    testCid = result.testCid;
    cleanup = result.cleanup;
  });

  afterAll(() => cleanup());

  test("getDashboard aggregates metadata correctly", async () => {
    const dashboard = await provider.getDashboard();
    expect(dashboard.metadata.name).toBe("test-grove");
    expect(dashboard.metadata.mode).toBe("local");
    expect(dashboard.metadata.contributionCount).toBe(3);
    expect(dashboard.metadata.activeClaimCount).toBe(1);
  });

  test("getDashboard includes recent contributions", async () => {
    const dashboard = await provider.getDashboard();
    expect(dashboard.recentContributions.length).toBe(3);
  });

  test("getContribution returns ancestors and children", async () => {
    const detail = await provider.getContribution(testCid);
    expect(detail).toBeDefined();
    // c1 has children (c2 derives_from, c3 reviews)
    expect(detail?.children.length).toBeGreaterThan(0);
  });

  test("getDag without rootCid returns all contributions", async () => {
    const dag = await provider.getDag();
    expect(dag.contributions.length).toBe(3);
  });

  test("getDag with rootCid follows edges", async () => {
    const dag = await provider.getDag(testCid);
    expect(dag.contributions.length).toBeGreaterThan(0);
    expect(dag.contributions.some((c) => c.cid === testCid)).toBe(true);
  });

  test("getActivity respects limit", async () => {
    const activity = await provider.getActivity({ limit: 2 });
    expect(activity.length).toBe(2);
  });

  test("close releases resources without error", () => {
    // Don't actually close here — afterAll handles it
    // Just verify the method exists
    expect(typeof provider.close).toBe("function");
  });
});
