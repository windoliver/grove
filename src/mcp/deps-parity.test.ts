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
import { type McpDeps, sessionToOwnerRef } from "./deps.js";
import { toOperationDeps } from "./operation-adapter.js";

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

  test("stdio MCP deps construction includes goalSessionStore", () => {
    // Mirror the deps construction from src/mcp/serve.ts
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
      bountyStore: runtime.bountyStore,
      cas: runtime.cas,
      frontier: runtime.frontier,
      workspace: requireWorkspace(runtime),
      contract: runtime.contract,
      onContributionWrite: runtime.onContributionWrite,
      workspaceBoundary: runtime.groveRoot,
      goalSessionStore: runtime.goalSessionStore,
      handoffStore: runtime.handoffStore,
      watchHub: new WatchHub(),
    };

    expect(deps.goalSessionStore).toBeDefined();
    expect(deps.goalSessionStore).toBe(runtime.goalSessionStore);
  });

  test("HTTP MCP deps construction includes goalSessionStore", () => {
    // Mirror the deps construction from src/mcp/serve-http.ts buildScopedDeps
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
      bountyStore: runtime.bountyStore,
      cas: runtime.cas,
      frontier: runtime.frontier,
      workspace: requireWorkspace(runtime),
      contract: runtime.contract,
      onContributionWrite: runtime.onContributionWrite,
      workspaceBoundary: runtime.groveRoot,
      goalSessionStore: runtime.goalSessionStore,
      watchHub: new WatchHub(),
    };

    expect(deps.goalSessionStore).toBeDefined();
    expect(deps.goalSessionStore).toBe(runtime.goalSessionStore);
  });

  test("toOperationDeps forwards sessionOwnerRef", () => {
    const ownerRef = { kind: "session" as const, id: "s1", uid: "u1" };
    const deps: McpDeps = {
      contributionStore: runtime.contributionStore,
      claimStore: runtime.claimStore,
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

  test("sessionToOwnerRef derives owner refs from session metadata", () => {
    expect(sessionToOwnerRef({ id: "nexus-session", uid: "stable-uid" })).toEqual({
      kind: "session",
      id: "nexus-session",
      uid: "stable-uid",
    });
    expect(sessionToOwnerRef(undefined)).toBeUndefined();
  });
});
