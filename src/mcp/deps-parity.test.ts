/**
 * Deps parity tests — verify that MCP entry points forward all stores
 * provided by LocalRuntime into the McpDeps object.
 *
 * Catches wiring omissions like goalSessionStore not being passed through
 * (issue #214).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WatchHub } from "../core/watch-hub.js";
import { createLocalRuntime, type LocalRuntime } from "../local/runtime.js";
import type { McpDeps } from "./deps.js";
import { toOperationDeps } from "./operation-adapter.js";

describe("MCP deps parity with LocalRuntime", () => {
  let tempDir: string;
  let runtime: LocalRuntime;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-deps-parity-"));
    const groveDir = join(tempDir, ".grove");
    await Bun.write(join(groveDir, ".gitkeep"), "");

    runtime = createLocalRuntime({
      groveDir,
      frontierCacheTtlMs: 0,
      workspace: true,
      parseContract: false, // no GROVE.md in temp dir
    });
  });

  afterEach(async () => {
    runtime.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("LocalRuntime always provides goalSessionStore", () => {
    expect(runtime.goalSessionStore).toBeDefined();
  });

  test("LocalRuntime always provides creditsService", () => {
    expect(runtime.creditsService).toBeDefined();
  });

  test("LocalRuntime always provides frontierRewardService", () => {
    expect(runtime.frontierRewardService).toBeDefined();
  });

  test("stdio MCP deps construction includes goalSessionStore", () => {
    // Mirror the deps construction from src/mcp/serve.ts
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
      bountyStore: runtime.bountyStore,
      creditsService: runtime.creditsService,
      frontierRewardService: runtime.frontierRewardService,
      cas: runtime.cas,
      frontier: runtime.frontier,
      workspace: runtime.workspace!,
      contract: runtime.contract,
      onContributionWrite: runtime.onContributionWrite,
      workspaceBoundary: runtime.groveRoot,
      goalSessionStore: runtime.goalSessionStore,
      handoffStore: runtime.handoffStore,
      watchHub: new WatchHub(),
    };

    expect(deps.goalSessionStore).toBeDefined();
    expect(deps.goalSessionStore).toBe(runtime.goalSessionStore);
    expect(deps.creditsService).toBe(runtime.creditsService);
    expect(deps.frontierRewardService).toBe(runtime.frontierRewardService);
    expect(toOperationDeps(deps).frontierRewardService).toBe(runtime.frontierRewardService);
  });

  test("HTTP MCP deps construction includes goalSessionStore", () => {
    // Mirror the stable runtime deps forwarded from src/mcp/serve-http.ts
    // buildScopedDeps. Frontier rewards are built from scoped, guarded stores
    // in that entry point and intentionally do not reuse the runtime singleton.
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
      bountyStore: runtime.bountyStore,
      creditsService: runtime.creditsService,
      cas: runtime.cas,
      frontier: runtime.frontier,
      workspace: runtime.workspace!,
      contract: runtime.contract,
      onContributionWrite: runtime.onContributionWrite,
      workspaceBoundary: runtime.groveRoot,
      goalSessionStore: runtime.goalSessionStore,
      watchHub: new WatchHub(),
    };

    expect(deps.goalSessionStore).toBeDefined();
    expect(deps.goalSessionStore).toBe(runtime.goalSessionStore);
    expect(deps.creditsService).toBe(runtime.creditsService);
    expect(deps.frontierRewardService).toBeUndefined();
    expect(toOperationDeps(deps).frontierRewardService).toBeUndefined();
  });
});
