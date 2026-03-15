/**
 * Shared test helpers for server tests.
 *
 * Creates real SQLite stores + FsCas in temp dirs, wires up createApp(),
 * and provides cleanup. Mirrors the pattern in cli/commands/*.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { ContentStore } from "../../src/core/cas.js";
import type { FrontierCalculator } from "../../src/core/frontier.js";
import { DefaultFrontierCalculator } from "../../src/core/frontier.js";
import type { OutcomeStore } from "../../src/core/outcome.js";
import type { ClaimStore, ContributionStore } from "../../src/core/store.js";
import { FsCas } from "../../src/local/fs-cas.js";
import { createSqliteStores } from "../../src/local/sqlite-store.js";
import { createApp } from "../../src/server/app.js";
import type { ServerDeps, ServerEnv } from "../../src/server/deps.js";

export interface TestContext {
  readonly app: Hono<ServerEnv>;
  readonly deps: ServerDeps;
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly outcomeStore: OutcomeStore;
  readonly cas: ContentStore;
  readonly frontier: FrontierCalculator;
  readonly tempDir: string;
  readonly cleanup: () => Promise<void>;
}

/** Create a fully wired test context with real stores in a temp directory. */
export async function createTestContext(): Promise<TestContext> {
  const tempDir = await mkdtemp(join(tmpdir(), "grove-server-test-"));
  const dbPath = join(tempDir, "test.db");
  const casDir = join(tempDir, "cas");

  const stores = createSqliteStores(dbPath);
  const cas = new FsCas(casDir);
  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  const deps: ServerDeps = {
    contributionStore: stores.contributionStore,
    claimStore: stores.claimStore,
    outcomeStore: stores.outcomeStore,
    cas,
    frontier,
  };

  const app = createApp(deps);

  return {
    app,
    deps,
    contributionStore: stores.contributionStore,
    claimStore: stores.claimStore,
    outcomeStore: stores.outcomeStore,
    cas,
    frontier,
    tempDir,
    cleanup: async () => {
      stores.close();
      cas.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/** Create a minimal valid contribution manifest body (JSON). */
export function validManifestBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "work",
    mode: "evaluation",
    summary: "Test contribution",
    relations: [],
    tags: ["test"],
    agent: { agentId: "test-agent" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a minimal valid claim body (JSON). */
export function claimBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    targetRef: "optimize-parser",
    agent: { agentId: "agent-1" },
    intentSummary: "Working on parser optimization",
    ...overrides,
  };
}

/** Create a minimal valid outcome body (JSON). */
export function outcomeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "accepted",
    reason: "Looks good",
    evaluatedBy: "reviewer-1",
    ...overrides,
  };
}

/** POST a JSON contribution and return the parsed response body. */
export async function postContribution(
  ctx: TestContext,
  overrides?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await ctx.app.request("/api/contributions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validManifestBody(overrides)),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** POST a claim and return the parsed response body. */
export async function postClaim(
  ctx: TestContext,
  overrides?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await ctx.app.request("/api/claims", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(claimBody(overrides)),
  });
  return (await res.json()) as Record<string, unknown>;
}
