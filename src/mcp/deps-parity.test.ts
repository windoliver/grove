/**
 * Deps parity tests — verify that MCP entry points forward all stores
 * provided by LocalRuntime into the McpDeps object.
 *
 * Catches wiring omissions like goalSessionStore not being passed through
 * (issue #214).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DefaultRuntimeSkillAcquisitionService } from "../core/runtime-skill-acquisition.js";
import { WatchHub } from "../core/watch-hub.js";
import { createLocalRuntime, type LocalRuntime } from "../local/runtime.js";
import { type McpDeps, sessionToOwnerRef } from "./deps.js";
import { toOperationDeps } from "./operation-adapter.js";
import { GOAL_SESSION_MUTATION_METHODS } from "./scope-mutation-methods.js";

function requireWorkspace(runtime: LocalRuntime): McpDeps["workspace"] {
  if (runtime.workspace === undefined) {
    throw new Error("Expected test runtime to provide a workspace");
  }
  return runtime.workspace;
}

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
    const runtimeSkillService = new DefaultRuntimeSkillAcquisitionService({
      readRuntimeSkillsConfig: async () => undefined,
      bundledSkillsRoot: join(tempDir, "skills"),
      workspaceOverrideRoot: join(tempDir, ".grove", "skills"),
      sessionStore: runtime.goalSessionStore,
    });
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
      timelineStore: runtime.timelineStore,
      bountyStore: runtime.bountyStore,
      creditsService: runtime.creditsService,
      frontierRewardService: runtime.frontierRewardService,
      cas: runtime.cas,
      frontier: runtime.frontier,
      workspace: requireWorkspace(runtime),
      contract: runtime.contract,
      onContributionWrite: runtime.onContributionWrite,
      hookRunner: runtime.hookRunner,
      hookCwd: runtime.hookCwd,
      workspaceBoundary: runtime.groveRoot,
      goalSessionStore: runtime.goalSessionStore,
      runtimeSkillService,
      handoffStore: runtime.handoffStore,
      watchHub: new WatchHub(),
    };

    expect(deps.goalSessionStore).toBeDefined();
    expect(deps.goalSessionStore).toBe(runtime.goalSessionStore);
    expect(deps.timelineStore).toBe(runtime.timelineStore);
    expect(deps.creditsService).toBe(runtime.creditsService);
    expect(deps.frontierRewardService).toBe(runtime.frontierRewardService);
    expect(toOperationDeps(deps).timelineStore).toBe(runtime.timelineStore);
    expect(deps.runtimeSkillService).toBeDefined();
    expect(toOperationDeps(deps).frontierRewardService).toBe(runtime.frontierRewardService);
    expect(toOperationDeps(deps).hookRunner).toBe(runtime.hookRunner);
    expect(toOperationDeps(deps).hookCwd).toBe(runtime.hookCwd);
  });

  test("HTTP MCP deps construction includes goalSessionStore", () => {
    // Mirror the stable runtime deps forwarded from src/mcp/serve-http.ts
    // buildScopedDeps. Frontier rewards are built from scoped, guarded stores
    // in that entry point and intentionally do not reuse the runtime singleton.
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
      timelineStore: runtime.timelineStore,
      bountyStore: runtime.bountyStore,
      creditsService: runtime.creditsService,
      cas: runtime.cas,
      frontier: runtime.frontier,
      workspace: requireWorkspace(runtime),
      contract: runtime.contract,
      onContributionWrite: runtime.onContributionWrite,
      hookRunner: runtime.hookRunner,
      hookCwd: runtime.hookCwd,
      workspaceBoundary: runtime.groveRoot,
      goalSessionStore: runtime.goalSessionStore,
      watchHub: new WatchHub(),
    };

    expect(deps.goalSessionStore).toBeDefined();
    expect(deps.goalSessionStore).toBe(runtime.goalSessionStore);
    expect(deps.timelineStore).toBe(runtime.timelineStore);
    expect(deps.creditsService).toBe(runtime.creditsService);
    expect(deps.frontierRewardService).toBeUndefined();
    expect(toOperationDeps(deps).timelineStore).toBe(runtime.timelineStore);
    expect(deps.runtimeSkillService).toBeUndefined();
    expect(toOperationDeps(deps).frontierRewardService).toBeUndefined();
    expect(toOperationDeps(deps).hookRunner).toBe(runtime.hookRunner);
    expect(toOperationDeps(deps).hookCwd).toBe(runtime.hookCwd);
  });

  test("toOperationDeps forwards sessionOwnerRef", () => {
    const ownerRef = { kind: "session" as const, id: "s1", uid: "u1" };
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
      timelineStore: runtime.timelineStore,
      bountyStore: runtime.bountyStore,
      cas: runtime.cas,
      frontier: runtime.frontier,
      workspace: requireWorkspace(runtime),
      workspaceBoundary: runtime.groveRoot,
      goalSessionStore: runtime.goalSessionStore,
      sessionOwnerRef: ownerRef,
      watchHub: new WatchHub(),
    };

    expect(toOperationDeps(deps).sessionOwnerRef).toEqual(ownerRef);
  });

  test("toOperationDeps forwards admission zoneId without watch namespace", () => {
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
      timelineStore: runtime.timelineStore,
      bountyStore: runtime.bountyStore,
      cas: runtime.cas,
      frontier: runtime.frontier,
      workspace: requireWorkspace(runtime),
      workspaceBoundary: runtime.groveRoot,
      goalSessionStore: runtime.goalSessionStore,
      zoneId: "zone-only",
      watchHub: new WatchHub(),
    };

    const opDeps = toOperationDeps(deps);

    expect(opDeps.zoneId).toBe("zone-only");
    expect(opDeps.namespace).toBeUndefined();
  });

  test("sessionToOwnerRef derives owner refs from session metadata", () => {
    expect(sessionToOwnerRef({ id: "nexus-session", uid: "stable-uid" })).toEqual({
      kind: "session",
      id: "nexus-session",
      uid: "stable-uid",
    });
    expect(sessionToOwnerRef(undefined)).toBeUndefined();
  });

  test("HTTP MCP stale-scope mutation guard covers session deletion", () => {
    expect(GOAL_SESSION_MUTATION_METHODS).toContain("deleteSession");
  });

  test("stdio MCP entrypoint wires settlement sweep with durable credits", () => {
    const source = readFileSync(join(import.meta.dir, "serve.ts"), "utf-8");

    expect(source).toContain("new SettlementSweep");
    expect(source).toContain("runtime.creditsService");
  });

  test("stdio runtime skills persist sessions through the active backend", () => {
    const source = readFileSync(join(import.meta.dir, "serve.ts"), "utf-8");

    expect(source).toContain("runtimeSkillSessionStore");
    expect(source).toContain("new NexusSessionStore(nexusClient, zoneId)");
    expect(source).toContain("sessionStore: runtimeSkillSessionStore");
    expect(source).not.toContain("sessionStore: runtime.goalSessionStore");
  });
});
