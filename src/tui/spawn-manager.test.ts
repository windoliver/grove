/**
 * Tests for SpawnManager — exercises the real spawn/kill lifecycle
 * including timer setup/teardown and tmux failure rollback.
 *
 * Uses mock provider + mock TmuxManager to test the actual wiring
 * in SpawnManager (not just provider methods).
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawn() does real work: git worktree add into the current repo, writeFile
// for config artifacts, chmod, and writeMcpConfig. Individual spawns routinely
// take 1–3s on a warm machine and 3–5s cold; the default 5s timeout races tests
// that spawn multiple agents. Bump to 30s so CI and local runs are stable.
setDefaultTimeout(30_000);

import type { AcpxTurn } from "../acp/types.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import { type Handoff, HandoffStatus } from "../core/handoff.js";
import type { Claim } from "../core/models.js";
import {
  computeRoutingSignatureForContribution,
  ROUTING_SIGNATURE_CONTEXT_KEY,
} from "../core/routing-provenance.js";
import { makeContribution, makeTopology } from "../core/test-helpers.js";
import type { SpawnOptions, TmuxManager } from "./agents/tmux-manager.js";
import { MockTmuxManager } from "./agents/tmux-manager.js";
import type { ClaimInput, ClaimsQuery, TuiDataProvider } from "./provider.js";
import type { PersistedSpawnRecord, SessionStore } from "./session-store.js";
import { SpawnManager } from "./spawn-manager.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Minimal mock provider that tracks claims in memory. */
function makeMockProvider(): TuiDataProvider & {
  readonly claims: Map<string, Claim>;
  readonly contributions: ReturnType<typeof makeContribution>[];
  readonly workspaces: Map<string, string>;
  readonly cleanedWorkspaces: Set<string>;
  heartbeatCount: number;
} {
  const claims = new Map<string, Claim>();
  const contributions: ReturnType<typeof makeContribution>[] = [];
  const workspaces = new Map<string, string>();
  const cleanedWorkspaces = new Set<string>();
  let heartbeatCount = 0;

  return {
    claims,
    contributions,
    workspaces,
    cleanedWorkspaces,
    heartbeatCount,

    capabilities: {
      outcomes: false,
      artifacts: false,
      vfs: false,
      messaging: false,
      costTracking: false,
      askUser: false,
      github: false,
      bounties: false,
      gossip: false,
      goals: false,
      sessions: false,
      handoffs: false,
      prompts: false,
    },

    async getDashboard() {
      return {
        metadata: {
          name: "test",
          contributionCount: 0,
          activeClaimCount: 0,
          mode: "test",
          backendLabel: "test",
        },
        activeClaims: [],
        recentContributions: [],
        frontierSummary: { topByMetric: [], topByAdoption: [] },
      };
    },
    async getContributions() {
      return contributions;
    },
    async getContribution() {
      return undefined;
    },
    async getClaims(query?: ClaimsQuery) {
      const all = [...claims.values()];
      if (query?.status === "active") return all.filter((c) => c.status === "active");
      if (query?.agentId) return all.filter((c) => c.agent.agentId === query.agentId);
      return all;
    },
    async getFrontier() {
      return { byMetric: {}, byAdoption: [], byRecency: [], byReviewScore: [], byReproduction: [] };
    },
    async getActivity() {
      return [];
    },
    async getDag() {
      return { contributions: [] };
    },
    async getHotThreads() {
      return [];
    },

    async createClaim(input: ClaimInput): Promise<Claim> {
      const now = new Date();
      const claim: Claim = {
        claimId: crypto.randomUUID(),
        targetRef: input.targetRef,
        agent: input.agent,
        status: "active",
        intentSummary: input.intentSummary,
        createdAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs).toISOString(),
      };
      claims.set(claim.claimId, claim);
      return claim;
    },

    async checkoutWorkspace(targetRef: string): Promise<string> {
      const path = `/tmp/ws/${targetRef}`;
      workspaces.set(targetRef, path);
      return path;
    },

    async heartbeatClaim(claimId: string, leaseDurationMs?: number): Promise<Claim> {
      heartbeatCount++;
      const claim = claims.get(claimId);
      if (!claim || claim.status !== "active") throw new Error("Claim not active");
      const now = new Date();
      const updated: Claim = {
        ...claim,
        heartbeatAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + (leaseDurationMs ?? 300_000)).toISOString(),
      };
      claims.set(claimId, updated);
      return updated;
    },

    async releaseClaim(claimId: string): Promise<void> {
      const claim = claims.get(claimId);
      if (claim) claims.set(claimId, { ...claim, status: "released" as Claim["status"] });
    },

    async cleanWorkspace(targetRef: string, agentId: string): Promise<void> {
      cleanedWorkspaces.add(`${targetRef}:${agentId}`);
    },

    close() {
      // No-op for test mock.
    },
  };
}

/** Mock TmuxManager that can be configured to succeed or fail. */
function makeMockTmux(shouldFail = false): TmuxManager & {
  readonly spawnedSessions: string[];
  readonly killedSessions: string[];
} {
  const spawnedSessions: string[] = [];
  const killedSessions: string[] = [];

  return {
    spawnedSessions,
    killedSessions,

    async isAvailable() {
      return true;
    },
    async listSessions() {
      return spawnedSessions;
    },

    async spawn(options: SpawnOptions) {
      if (shouldFail) throw new Error("tmux spawn failed");
      // Session name format: grove-{agentId}
      const sessionName = `grove-${options.agentId}`;
      spawnedSessions.push(sessionName);
      return sessionName;
    },

    async kill(sessionName: string) {
      killedSessions.push(sessionName);
      const idx = spawnedSessions.indexOf(sessionName);
      if (idx !== -1) spawnedSessions.splice(idx, 1);
    },

    async sendKeys() {
      // No-op for test mock.
    },
    async capturePanes() {
      return "";
    },
  };
}

function makeTempGitProject(prefix: string): {
  readonly projectRoot: string;
  readonly groveDir: string;
} {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init -q", { cwd: projectRoot });
  execSync("git config user.email test@grove.test", { cwd: projectRoot });
  execSync("git config user.name Grove-Test", { cwd: projectRoot });
  execSync("git commit --allow-empty -q -m init", { cwd: projectRoot });

  const groveDir = join(projectRoot, ".grove");
  mkdirSync(groveDir, { recursive: true });
  return { projectRoot, groveDir };
}

function writeNexusGroveConfig(
  groveDir: string,
  opts: {
    readonly policy: "required" | "warn-and-fallback";
    readonly nexusUrl?: string | undefined;
    readonly nexusManaged?: boolean | undefined;
  },
): void {
  writeFileSync(
    join(groveDir, "grove.json"),
    `${JSON.stringify(
      {
        name: "test",
        mode: "nexus",
        ...(opts.nexusUrl !== undefined ? { nexusUrl: opts.nexusUrl } : {}),
        ...(opts.nexusManaged === true ? { nexusManaged: true } : {}),
        skillCatalog: {
          policy: opts.policy,
          trustedKeys: [
            {
              id: "test-key",
              algorithm: "ed25519",
              publicKeySpkiDer: "AA==",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function makeMockRuntime(): AgentRuntime & {
  readonly configs: AgentConfig[];
  readonly sendCalls: Array<{ readonly session: AgentSession; readonly message: string }>;
  setSessionStatus(sessionId: string, status: AgentSession["status"], message?: string): void;
} {
  const configs: AgentConfig[] = [];
  const sendCalls: Array<{ readonly session: AgentSession; readonly message: string }> = [];
  const sessions = new Map<string, AgentSession>();
  const roleCounts = new Map<string, number>();
  const idleCallbacks = new Map<string, Array<() => void>>();
  return {
    sendsInitialPromptOnSpawn: true,
    configs,
    sendCalls,
    async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
      configs.push(config);
      const count = (roleCounts.get(role) ?? 0) + 1;
      roleCounts.set(role, count);
      const session: AgentSession = {
        id: count === 1 ? `session-${role}` : `session-${role}-${count}`,
        role,
        status: "running",
        agent: "mock",
      };
      sessions.set(session.id, session);
      return session;
    },
    async send(session: AgentSession, message: string): Promise<AcpxTurn> {
      sendCalls.push({ session, message });
      const turnId = `turn-${sendCalls.length}`;
      return {
        sessionId: session.id,
        turnId,
        messages: {
          [Symbol.asyncIterator]: () => ({
            async next() {
              return { done: true as const, value: undefined as never };
            },
          }),
        },
        result: Promise.resolve({
          turnId,
          stopReason: "end_turn" as const,
        }),
        async cancel() {
          // No-op for test mock.
        },
        async close() {
          // No-op for test mock.
        },
      };
    },
    async close(): Promise<void> {
      // No-op for test mock.
    },
    onIdle(session: AgentSession, callback: () => void): void {
      const callbacks = idleCallbacks.get(session.id) ?? [];
      callbacks.push(callback);
      idleCallbacks.set(session.id, callbacks);
    },
    async listSessions(): Promise<readonly AgentSession[]> {
      return [...sessions.values()];
    },
    async listSessionEntities(): Promise<
      readonly import("../core/entity.js").AgentSessionEntity[]
    > {
      return [];
    },
    async isAvailable(): Promise<boolean> {
      return true;
    },
    setSessionStatus(sessionId: string, status: AgentSession["status"], message?: string): void {
      const current = sessions.get(sessionId);
      if (!current) throw new Error(`unknown session ${sessionId}`);
      const next =
        message === undefined
          ? { ...current, status }
          : { ...current, status, statusMessage: message };
      sessions.set(sessionId, next);
      for (const callback of idleCallbacks.get(sessionId) ?? []) callback();
    },
  };
}

function signContributionForRouting(
  contribution: ReturnType<typeof makeContribution>,
  routingToken: string,
): ReturnType<typeof makeContribution> {
  const signature = computeRoutingSignatureForContribution(contribution, routingToken);
  return {
    ...contribution,
    context: {
      ...(contribution.context ?? {}),
      [ROUTING_SIGNATURE_CONTEXT_KEY]: signature,
    },
  };
}

function deferredTurn(turnId: string): {
  readonly turn: AcpxTurn;
  resolve(result: Awaited<AcpxTurn["result"]>): void;
  reject(error: unknown): void;
} {
  let resolveResult: (result: Awaited<AcpxTurn["result"]>) => void = () => undefined;
  let rejectResult: (error: unknown) => void = () => undefined;
  const result = new Promise<Awaited<AcpxTurn["result"]>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  return {
    turn: {
      sessionId: "session-reviewer",
      turnId,
      messages: {
        [Symbol.asyncIterator]: () => ({
          async next() {
            return { done: true as const, value: undefined as never };
          },
        }),
      },
      result,
      async cancel() {
        // No-op for test mock.
      },
      async close() {
        // No-op for test mock.
      },
    },
    resolve: resolveResult,
    reject: rejectResult,
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let manager: SpawnManager | undefined;

afterEach(() => {
  manager?.destroy();
  manager = undefined;
});

describe("SpawnManager", () => {
  test("does not suppress initial prompt just because role prompt says wait for feedback", async () => {
    const provider = makeMockProvider();
    const runtime = makeMockRuntime();
    manager = new SpawnManager(
      provider,
      undefined,
      () => {
        // No-op for test mock.
      },
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
      runtime,
    );

    await manager.spawn("coder", "claude", undefined, 0, {
      rolePrompt:
        "Submit work immediately. After submitting work, wait for reviewer feedback and do nothing else.",
    });

    expect(runtime.configs).toHaveLength(1);
    expect(runtime.configs[0]?.waitForPush).toBe(false);
    expect(runtime.configs[0]?.prompt).toContain("Submit work immediately");
  });

  test("stopActiveSession unregisters active rows before runtime close settles", async () => {
    const provider = makeMockProvider();
    const runtime = makeMockRuntime();
    const closedSessions: string[] = [];
    let releaseClose: (() => void) | undefined;
    runtime.close = async (session: AgentSession) => {
      closedSessions.push(session.id);
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    };
    manager = new SpawnManager(
      provider,
      undefined,
      () => {
        // No-op for test mock.
      },
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
      runtime,
    );

    const result = await manager.spawn("reviewer", "codex");
    const stopPromise = manager.stopActiveSession();

    expect(manager.getActiveRoles()).toEqual([]);
    expect(manager.getSpawnRecord(result.spawnId)).toBeUndefined();
    expect(closedSessions).toEqual(["session-reviewer"]);

    releaseClose?.();
    await stopPromise;
  });

  test("runtime crash marks role failed and removes it from active roles", async () => {
    const provider = makeMockProvider();
    const runtime = makeMockRuntime();
    manager = new SpawnManager(
      provider,
      undefined,
      () => {
        // No-op for test mock.
      },
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
      runtime,
    );

    await manager.spawn("coder", "codex");
    expect(manager.getActiveRoles()).toEqual(["coder"]);

    let failureNotifications = 0;
    const unsubscribe = manager.subscribeAgentFailures(() => {
      failureNotifications++;
    });

    runtime.setSessionStatus("session-coder", "crashed", "unexpected status 401 Unauthorized");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getActiveRoles()).toEqual([]);
    expect(manager.getAgentFailures().get("coder")).toContain("401 Unauthorized");
    expect(failureNotifications).toBe(1);

    unsubscribe();
  });

  test("spawn creates workspace and tmux session (no auto-claims)", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    // Use /tmp as groveDir so git worktree fails fast → falls through to provider mock
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
    );

    const result = await manager.spawn("claude", "bash");

    // Workspace was created (either via git worktree or provider fallback)
    expect(result.workspacePath).toBeTruthy();

    // No auto-claim (claims are agent-initiated via grove_claim)
    expect(result.claimId).toBe("");

    // Tmux session was spawned
    expect(tmux.spawnedSessions).toContain(`grove-${result.spawnId}`);

    // Spawn record is tracked
    expect(manager.getSpawnRecord(result.spawnId)).toBeDefined();

    // Workspace mode is always present
    expect(result.workspaceMode).toBeDefined();
    expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
      result.workspaceMode.status,
    );
  });

  test("kill cleans workspace and removes spawn record", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
    );

    const result = await manager.spawn("claude", "bash");
    // /tmp/no-grove is not a git repo → worktree fails → fallback_workspace
    expect(result.workspaceMode.status).toBe("fallback_workspace");

    const sessionName = `grove-${result.spawnId}`;

    await manager.kill(sessionName);

    // Spawn record was removed
    expect(manager.getSpawnRecord(result.spawnId)).toBeUndefined();

    // Workspace was cleaned
    expect(provider.cleanedWorkspaces.has(`${result.spawnId}:${result.spawnId}`)).toBe(true);

    // Tmux session was killed
    expect(tmux.killedSessions).toContain(sessionName);
  });

  test("tmux.spawn() failure rolls back workspace", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux(true); // configured to fail
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), [
      { kind: "local" as const, path: "/tmp" },
    ]);

    await expect(manager.spawn("claude", "bash")).rejects.toThrow("tmux spawn failed");

    // Workspace was cleaned (rolled back)
    expect(provider.cleanedWorkspaces.size).toBe(1);

    // No spawn record tracked
    expect(manager.getSpawnRecord("claude")).toBeUndefined();
  });

  test("kill works via local tracking (no claims needed)", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), [
      { kind: "local" as const, path: "/tmp" },
    ]);

    const result = await manager.spawn("claude", "bash");
    // No explicit groveDir — workspace mode depends on whether process.cwd() is a git repo
    expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
      result.workspaceMode.status,
    );

    const sessionName = `grove-${result.spawnId}`;

    await manager.kill(sessionName);

    // Spawn record was removed
    expect(manager.getSpawnRecord(result.spawnId)).toBeUndefined();

    // Workspace was cleaned
    expect(provider.cleanedWorkspaces.has(`${result.spawnId}:${result.spawnId}`)).toBe(true);
  });

  test("destroy clears spawn records", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), [
      { kind: "local" as const, path: "/tmp" },
    ]);

    const result1 = await manager.spawn("agent-a", "bash");
    const result2 = await manager.spawn("agent-b", "bash");

    expect(manager.getSpawnRecord(result1.spawnId)).toBeDefined();
    expect(manager.getSpawnRecord(result2.spawnId)).toBeDefined();
    // Both spawns have a workspace mode
    expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
      result1.workspaceMode.status,
    );
    expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
      result2.workspaceMode.status,
    );

    manager.destroy();

    manager.destroy();

    expect(manager.getSpawnRecord(result1.spawnId)).toBeUndefined();
    expect(manager.getSpawnRecord(result2.spawnId)).toBeUndefined();
  });

  test("spawn without workspace support falls back to git worktree", async () => {
    const provider = makeMockProvider();
    // Remove workspace support — SpawnManager tries git worktree first
    (provider as unknown as Record<string, unknown>).checkoutWorkspace = undefined;

    const tmux = makeMockTmux();
    manager = new SpawnManager(
      provider,
      tmux,
      () => {
        /* noop */
      },
      [{ kind: "local" as const, path: "/tmp" }],
    );

    // Spawn may succeed (git worktree) or fail (no git repo), but should not
    // throw "Provider does not support workspace checkout"
    try {
      await manager.spawn("claude", "bash");
    } catch (err) {
      expect(String(err)).not.toContain("Provider does not support workspace checkout");
    }
  });

  test("allow-fallback policy: worktree failure falls back to provider workspace", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
    );
    manager.setIsolationPolicy("allow-fallback");

    const result = await manager.spawn("claude", "bash");

    // Workspace was created via provider fallback
    expect(result.workspacePath).toBeTruthy();

    // Mode is either fallback_workspace (worktree failed) or isolated_worktree (worktree succeeded)
    expect(["fallback_workspace", "isolated_worktree", "bootstrap_failed"]).toContain(
      result.workspaceMode.status,
    );
  });

  test("strict policy: worktree failure in non-git dir throws", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
    );
    manager.setIsolationPolicy("strict");

    // /tmp/no-grove is not a git repo — strict policy must throw
    await expect(manager.spawn("claude", "bash")).rejects.toThrow(/Workspace provisioning failed/);
  });
});

// ---------------------------------------------------------------------------
// Skill injection E2E — validates the full path from SpawnManager.spawn()
// through injectSkills() into the provisioned workspace. Catches regressions
// where injection is wired but the workspace never actually receives files.
// ---------------------------------------------------------------------------

describe("SpawnManager — per-role skill injection", () => {
  test("allow-fallback still fails closed when required Nexus skill catalog is unreachable", async () => {
    const { projectRoot, groveDir } = makeTempGitProject("grove-skill-required-");
    const previousNexusUrl = process.env.GROVE_NEXUS_URL;
    delete process.env.GROVE_NEXUS_URL;

    try {
      writeNexusGroveConfig(groveDir, {
        policy: "required",
        nexusUrl: "http://127.0.0.1:1",
      });

      const provider = makeMockProvider();
      const tmux = makeMockTmux();
      const errors: string[] = [];
      manager = new SpawnManager(
        provider,
        tmux,
        (msg) => errors.push(msg),
        [{ kind: "local" as const, path: projectRoot }],
        undefined,
        groveDir,
      );
      manager.setIsolationPolicy("allow-fallback");

      await expect(
        manager.spawn("coder", "bash", undefined, 0, { skills: ["grove"] }),
      ).rejects.toThrow("Nexus skill catalog required");
      expect(tmux.spawnedSessions).toHaveLength(0);
      expect(errors.filter((e) => e.includes("Config write failed"))).toEqual([]);
    } finally {
      restoreEnv("GROVE_NEXUS_URL", previousNexusUrl);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("empty GROVE_NEXUS_URL falls back to grove.json nexusUrl for required skill catalogs", async () => {
    const { projectRoot, groveDir } = makeTempGitProject("grove-skill-empty-env-");
    const previousNexusUrl = process.env.GROVE_NEXUS_URL;
    process.env.GROVE_NEXUS_URL = "";

    try {
      writeNexusGroveConfig(groveDir, {
        policy: "required",
        nexusUrl: "http://127.0.0.1:1",
      });

      const provider = makeMockProvider();
      const tmux = makeMockTmux();
      const errors: string[] = [];
      manager = new SpawnManager(
        provider,
        tmux,
        (msg) => errors.push(msg),
        [{ kind: "local" as const, path: projectRoot }],
        undefined,
        groveDir,
      );
      manager.setIsolationPolicy("allow-fallback");

      await expect(
        manager.spawn("coder", "bash", undefined, 0, { skills: ["grove"] }),
      ).rejects.toThrow("http://127.0.0.1:1");
      expect(tmux.spawnedSessions).toHaveLength(0);
      expect(errors.filter((e) => e.includes("Config write failed"))).toEqual([]);
    } finally {
      restoreEnv("GROVE_NEXUS_URL", previousNexusUrl);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("empty GROVE_NEXUS_URL falls back to managed nexus.yaml for required skill catalogs", async () => {
    const { projectRoot, groveDir } = makeTempGitProject("grove-skill-managed-env-");
    const previousNexusUrl = process.env.GROVE_NEXUS_URL;
    process.env.GROVE_NEXUS_URL = "";

    try {
      writeNexusGroveConfig(groveDir, {
        policy: "required",
        nexusManaged: true,
      });
      writeFileSync(join(projectRoot, "nexus.yaml"), "ports:\n  http: 1\n", "utf-8");

      const provider = makeMockProvider();
      const tmux = makeMockTmux();
      const errors: string[] = [];
      manager = new SpawnManager(
        provider,
        tmux,
        (msg) => errors.push(msg),
        [{ kind: "local" as const, path: projectRoot }],
        undefined,
        groveDir,
      );
      manager.setIsolationPolicy("allow-fallback");

      await expect(
        manager.spawn("coder", "bash", undefined, 0, { skills: ["grove"] }),
      ).rejects.toThrow("http://localhost:1");
      expect(tmux.spawnedSessions).toHaveLength(0);
      expect(errors.filter((e) => e.includes("Config write failed"))).toEqual([]);
    } finally {
      restoreEnv("GROVE_NEXUS_URL", previousNexusUrl);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("managed nexus.yaml URL is written to MCP config", async () => {
    const { projectRoot, groveDir } = makeTempGitProject("grove-skill-managed-mcp-");
    const previousNexusUrl = process.env.GROVE_NEXUS_URL;
    process.env.GROVE_NEXUS_URL = "";

    try {
      writeNexusGroveConfig(groveDir, {
        policy: "warn-and-fallback",
        nexusManaged: true,
      });
      writeFileSync(join(projectRoot, "nexus.yaml"), "ports:\n  http: 23456\n", "utf-8");

      const provider = makeMockProvider();
      const tmux = makeMockTmux();
      manager = new SpawnManager(
        provider,
        tmux,
        () => undefined,
        [{ kind: "local" as const, path: projectRoot }],
        undefined,
        groveDir,
      );

      const result = await manager.spawn("coder", "bash");
      const mcpConfig = JSON.parse(
        readFileSync(join(result.workspacePath, ".mcp.json"), "utf-8"),
      ) as {
        readonly mcpServers?: {
          readonly grove?: { readonly env?: { readonly GROVE_NEXUS_URL?: string | undefined } };
        };
      };

      expect(mcpConfig.mcpServers?.grove?.env?.GROVE_NEXUS_URL).toBe("http://localhost:23456");
    } finally {
      restoreEnv("GROVE_NEXUS_URL", previousNexusUrl);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("warn-and-fallback Nexus skill catalog warnings are surfaced during spawn", async () => {
    const { projectRoot, groveDir } = makeTempGitProject("grove-skill-warning-");
    const previousNexusUrl = process.env.GROVE_NEXUS_URL;
    process.env.GROVE_NEXUS_URL = "";

    try {
      writeNexusGroveConfig(groveDir, {
        policy: "warn-and-fallback",
        nexusUrl: "http://127.0.0.1:1",
      });

      const provider = makeMockProvider();
      const tmux = makeMockTmux();
      const errors: string[] = [];
      manager = new SpawnManager(
        provider,
        tmux,
        (msg) => errors.push(msg),
        [{ kind: "local" as const, path: projectRoot }],
        undefined,
        groveDir,
      );
      manager.setIsolationPolicy("strict");

      const result = await manager.spawn("coder", "bash", undefined, 0, { skills: ["grove"] });

      expect(result.workspaceMode.status).toBe("isolated_worktree");
      expect(errors.some((e) => e.includes("Nexus skill catalog warning"))).toBe(true);
      expect(errors.some((e) => e.includes("fallback: local"))).toBe(true);
    } finally {
      restoreEnv("GROVE_NEXUS_URL", previousNexusUrl);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("spawn injects declared 'grove' skill into .claude/skills and .codex/skills", async () => {
    const { execSync } = await import("node:child_process");
    const { existsSync, mkdirSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // Isolated temp git repo — SpawnManager.spawn creates worktrees under
    // <projectRoot>/.grove/workspaces/<spawnId>/ via provisionWorkspace.
    // resolveBundledSkillsRoot walks up from process.argv[1]; in bun test
    // that resolves to the real grove repo, so `grove` skill is guaranteed
    // to be resolvable. We don't stage a fixture catalog here — the point
    // is to verify the real injection path writes real files.
    const projectRoot = mkdtempSync(join(tmpdir(), "grove-skill-e2e-"));
    execSync("git init -q", { cwd: projectRoot });
    execSync("git config user.email test@grove.test", { cwd: projectRoot });
    execSync("git config user.name Grove-Test", { cwd: projectRoot });
    execSync("git commit --allow-empty -q -m init", { cwd: projectRoot });

    const groveDir = join(projectRoot, ".grove");
    mkdirSync(groveDir, { recursive: true });

    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: projectRoot }],
      undefined,
      groveDir,
    );
    manager.setIsolationPolicy("strict");

    const result = await manager.spawn("coder", "bash", undefined, 0, {
      skills: ["grove"],
    });

    expect(result.workspaceMode.status).toBe("isolated_worktree");

    const claudeSkill = join(result.workspacePath, ".claude", "skills", "grove", "SKILL.md");
    const codexSkill = join(result.workspacePath, ".codex", "skills", "grove", "SKILL.md");
    const mcpJsonPath = join(result.workspacePath, ".mcp.json");
    const acpxRcPath = join(result.workspacePath, ".acpxrc.json");

    expect(existsSync(claudeSkill)).toBe(true);
    expect(existsSync(codexSkill)).toBe(true);
    // Both copies must be real and reference the grove skill (frontmatter).
    expect(readFileSync(claudeSkill, "utf-8")).toContain("name: grove");
    expect(readFileSync(codexSkill, "utf-8")).toContain("name: grove");
    const codexMd = readFileSync(join(result.workspacePath, "CODEX.md"), "utf-8");
    expect(codexMd).toContain("mcp__grove__grove_submit_work");
    expect(codexMd).toContain("do not run `bun --eval`");
    expect(codexMd).toContain("MCP tools are unavailable");
    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8")) as {
      mcpServers: { grove: { command: string } };
    };
    const acpxRc = JSON.parse(readFileSync(acpxRcPath, "utf-8")) as {
      mcpServers: Array<{ name: string; command: string }>;
    };
    expect(mcpJson.mcpServers.grove.command).toBe(process.execPath);
    expect(acpxRc.mcpServers.find((s) => s.name === "grove")?.command).toBe(process.execPath);

    // "Config write failed" is the exact symptom when injectSkills throws
    // and gets swallowed. Must not appear.
    expect(errors.filter((e) => e.includes("Config write failed"))).toEqual([]);
    expect(execSync("git status --short", { cwd: result.workspacePath, encoding: "utf-8" })).toBe(
      "",
    );
  });

  test("spawn writes Codex home MCP config when opt-in flag is set", async () => {
    const { execSync } = await import("node:child_process");
    const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const previousCodexHome = process.env.CODEX_HOME;
    const previousCodexWriteMcpConfig = process.env.GROVE_CODEX_WRITE_MCP_CONFIG;
    const previousNexusUrl = process.env.GROVE_NEXUS_URL;
    const previousNexusApiKey = process.env.NEXUS_API_KEY;

    try {
      const projectRoot = mkdtempSync(join(tmpdir(), "grove-codex-home-e2e-"));
      execSync("git init -q", { cwd: projectRoot });
      execSync("git config user.email test@grove.test", { cwd: projectRoot });
      execSync("git config user.name Grove-Test", { cwd: projectRoot });
      execSync("git commit --allow-empty -q -m init", { cwd: projectRoot });

      const groveDir = join(projectRoot, ".grove");
      mkdirSync(groveDir, { recursive: true });

      const codexHome = mkdtempSync(join(tmpdir(), "grove-codex-home-"));
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.4-mini"\n', "utf-8");
      process.env.CODEX_HOME = codexHome;
      process.env.GROVE_CODEX_WRITE_MCP_CONFIG = "1";
      process.env.GROVE_NEXUS_URL = "http://localhost:4515";
      process.env.NEXUS_API_KEY = "grv_test_key";

      const provider = makeMockProvider();
      const tmux = makeMockTmux();
      manager = new SpawnManager(
        provider,
        tmux,
        () => {
          /* ignore */
        },
        [{ kind: "local" as const, path: projectRoot }],
        undefined,
        groveDir,
      );
      manager.setIsolationPolicy("strict");

      await manager.spawn("coder", "bash");

      const config = readFileSync(join(codexHome, "config.toml"), "utf-8");
      expect(config).toContain('model = "gpt-5.4-mini"');
      expect(config).toContain("# BEGIN GROVE GENERATED MCP");
      expect(config).toContain("[mcp_servers.grove]");
      expect(config).toContain('NEXUS_API_KEY = "grv_test_key"');
      expect(config).toContain('GROVE_NEXUS_URL = "http://localhost:4515"');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexWriteMcpConfig === undefined) {
        delete process.env.GROVE_CODEX_WRITE_MCP_CONFIG;
      } else {
        process.env.GROVE_CODEX_WRITE_MCP_CONFIG = previousCodexWriteMcpConfig;
      }
      if (previousNexusUrl === undefined) delete process.env.GROVE_NEXUS_URL;
      else process.env.GROVE_NEXUS_URL = previousNexusUrl;
      if (previousNexusApiKey === undefined) delete process.env.NEXUS_API_KEY;
      else process.env.NEXUS_API_KEY = previousNexusApiKey;
    }
  });

  test("two roles in the same session each get their own skill-injected workspace", async () => {
    const { execSync } = await import("node:child_process");
    const { existsSync, mkdirSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const projectRoot = mkdtempSync(join(tmpdir(), "grove-skill-e2e-"));
    execSync("git init -q", { cwd: projectRoot });
    execSync("git config user.email test@grove.test", { cwd: projectRoot });
    execSync("git config user.name Grove-Test", { cwd: projectRoot });
    execSync("git commit --allow-empty -q -m init", { cwd: projectRoot });

    const groveDir = join(projectRoot, ".grove");
    mkdirSync(groveDir, { recursive: true });

    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: projectRoot }],
      undefined,
      groveDir,
    );
    manager.setIsolationPolicy("strict");

    const coderResult = await manager.spawn("coder", "bash", undefined, 0, { skills: ["grove"] });
    const reviewerResult = await manager.spawn("reviewer", "bash", undefined, 0, {
      skills: ["grove"],
    });

    // Different workspaces.
    expect(coderResult.workspacePath).not.toBe(reviewerResult.workspacePath);

    // Each got its own injected catalog — proves the injector runs per
    // spawn, not once globally.
    expect(existsSync(join(coderResult.workspacePath, ".claude/skills/grove/SKILL.md"))).toBe(true);
    expect(existsSync(join(coderResult.workspacePath, ".codex/skills/grove/SKILL.md"))).toBe(true);
    expect(existsSync(join(reviewerResult.workspacePath, ".claude/skills/grove/SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(reviewerResult.workspacePath, ".codex/skills/grove/SKILL.md"))).toBe(
      true,
    );

    // When a role declares no skills, no .claude/skills directory appears.
    const noSkillResult = await manager.spawn("watcher", "bash", undefined, 0, {});
    expect(existsSync(join(noSkillResult.workspacePath, ".claude/skills"))).toBe(false);
    expect(existsSync(join(noSkillResult.workspacePath, ".codex/skills"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shell injection regression tests
// ---------------------------------------------------------------------------

describe("SpawnManager — shell injection safety", () => {
  /** Helper: spawn with a given PR title and return the MockTmuxManager session entry. */
  async function spawnWithTitle(title: string) {
    const provider = makeMockProvider();
    const tmux = new MockTmuxManager();
    const errors: string[] = [];
    const mgr = new SpawnManager(provider, tmux, (msg) => errors.push(msg), [
      { kind: "local" as const, path: "/tmp" },
    ]);

    // Assign to module-level `manager` so afterEach can call destroy().
    manager = mgr;

    mgr.setPrContext({ number: 42, title, filesChanged: 5 });

    const result = await mgr.spawn("claude", "bash");
    // workspace mode is always present, regardless of whether worktree succeeded
    expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
      result.workspaceMode.status,
    );
    const sessionName = `grove-${result.spawnId}`;
    const session = tmux.sessions.get(sessionName);
    expect(session).toBeDefined();
    return { session: session!, sessionName, tmux, errors };
  }

  test("PR title with backticks is safely passed as env var", async () => {
    const title = "`whoami`";
    const { session } = await spawnWithTitle(title);

    // The command must NOT contain the malicious payload.
    expect(session.command).not.toContain(title);

    // The env var must carry the raw string, not an executed result.
    expect(session.env).toBeDefined();
    expect(session.env!.GROVE_PR_TITLE).toBe(title);
  });

  test("PR title with $() is safely passed as env var", async () => {
    const title = "$(rm -rf /)";
    const { session } = await spawnWithTitle(title);

    expect(session.command).not.toContain(title);

    expect(session.env).toBeDefined();
    expect(session.env!.GROVE_PR_TITLE).toBe(title);
  });

  test("PR title with semicolons is safely passed as env var", async () => {
    const title = "; malicious-command";
    const { session } = await spawnWithTitle(title);

    expect(session.command).not.toContain(title);

    expect(session.env).toBeDefined();
    expect(session.env!.GROVE_PR_TITLE).toBe(title);
  });

  test("PR title with $VARIABLE is safely passed as env var", async () => {
    const title = "$HOME and $PATH";
    const { session } = await spawnWithTitle(title);

    expect(session.command).not.toContain(title);

    expect(session.env).toBeDefined();
    expect(session.env!.GROVE_PR_TITLE).toBe(title);
  });

  test("PR context is NOT embedded in the command string", async () => {
    const title = "innocuous title";
    const provider = makeMockProvider();
    const tmux = new MockTmuxManager();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), [
      { kind: "local" as const, path: "/tmp" },
    ]);
    manager.setPrContext({ number: 99, title, filesChanged: 10 });

    const result = await manager.spawn("claude", "bash");
    expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
      result.workspaceMode.status,
    );
    const sessionName = `grove-${result.spawnId}`;
    const session = tmux.sessions.get(sessionName);
    expect(session).toBeDefined();

    // The command must not contain any GROVE_PR_ references —
    // those belong exclusively in the env object.
    expect(session!.command).not.toContain("GROVE_PR_");
    expect(session!.command).not.toContain("GROVE_PR_NUMBER");
    expect(session!.command).not.toContain("GROVE_PR_TITLE");
    expect(session!.command).not.toContain("GROVE_PR_FILES");

    // Env must contain all three PR context vars.
    expect(session!.env).toBeDefined();
    expect(session!.env!.GROVE_PR_NUMBER).toBe("99");
    expect(session!.env!.GROVE_PR_TITLE).toBe(title);
    expect(session!.env!.GROVE_PR_FILES).toBe("10");
  });
});

// ---------------------------------------------------------------------------
// Mock SessionStore for persistence tests
// ---------------------------------------------------------------------------

/** In-memory SessionStore mock that tracks save/remove operations. */
function makeMockSessionStore(): SessionStore & {
  readonly records: Map<string, PersistedSpawnRecord>;
  readonly saveCalls: PersistedSpawnRecord[];
  readonly removeCalls: string[];
} {
  const records = new Map<string, PersistedSpawnRecord>();
  const saveCalls: PersistedSpawnRecord[] = [];
  const removeCalls: string[] = [];

  return {
    records,
    saveCalls,
    removeCalls,

    save(record: PersistedSpawnRecord): void {
      saveCalls.push(record);
      records.set(record.spawnId, record);
    },

    remove(spawnId: string): void {
      removeCalls.push(spawnId);
      records.delete(spawnId);
    },

    loadAll(): readonly PersistedSpawnRecord[] {
      return [...records.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// Session persistence tests
// ---------------------------------------------------------------------------

describe("SpawnManager — session persistence", () => {
  test("spawn persists record to session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      store,
    );

    const result = await manager.spawn("claude", "bash");

    // Session store was called with the correct record
    expect(store.saveCalls).toHaveLength(1);
    expect(store.saveCalls[0]?.spawnId).toBe(result.spawnId);
    expect(store.saveCalls[0]?.claimId).toBe(result.claimId);
    expect(store.saveCalls[0]?.workspacePath).toBe(result.workspacePath);
    expect(store.saveCalls[0]?.spawnedAt).toBeDefined();

    // Record is present in store
    expect(store.records.has(result.spawnId)).toBe(true);

    // workspaceMode is present on the SpawnResult
    expect(result.workspaceMode).toBeDefined();
  });

  test("syncWorkspaces uses provisioned workspace paths, not spawn ids", async () => {
    const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const projectRoot = mkdtempSync(join(tmpdir(), "grove-sync-workspaces-"));
    try {
      const groveDir = join(projectRoot, ".grove");
      const coderWorkspace = join(groveDir, "workspaces", "coder-2d079fe9");
      const reviewerWorkspace = join(groveDir, "workspaces", "reviewer-2d079fe9");
      mkdirSync(coderWorkspace, { recursive: true });
      mkdirSync(reviewerWorkspace, { recursive: true });
      writeFileSync(join(coderWorkspace, "handoff-smoke.txt"), "handoff-ok", "utf-8");

      const provider = makeMockProvider();
      const tmux = makeMockTmux();
      manager = new SpawnManager(
        provider,
        tmux,
        () => undefined,
        [{ kind: "local" as const, path: projectRoot }],
        undefined,
        groveDir,
      );
      const records = (
        manager as unknown as {
          spawnRecords: Map<
            string,
            {
              claimId: string;
              targetRef: string;
              agentId: string;
              workspacePath: string;
              role: string;
            }
          >;
        }
      ).spawnRecords;
      records.set("coder-motibvk5", {
        claimId: "",
        targetRef: "coder-motibvk5",
        agentId: "coder-motibvk5",
        workspacePath: coderWorkspace,
        role: "coder",
      });
      records.set("reviewer-motibyy6", {
        claimId: "",
        targetRef: "reviewer-motibyy6",
        agentId: "reviewer-motibyy6",
        workspacePath: reviewerWorkspace,
        role: "reviewer",
      });

      manager.syncWorkspaces("coder", "reviewer");

      expect(existsSync(join(reviewerWorkspace, "handoff-smoke.txt"))).toBe(true);
      expect(readFileSync(join(reviewerWorkspace, "handoff-smoke.txt"), "utf-8")).toBe(
        "handoff-ok",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("kill removes record from session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      store,
    );

    const result = await manager.spawn("claude", "bash");
    expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
      result.workspaceMode.status,
    );
    const sessionName = `grove-${result.spawnId}`;

    await manager.kill(sessionName);

    // Remove was called with the agentId
    expect(store.removeCalls).toContain(result.spawnId);

    // Record is gone from store
    expect(store.records.has(result.spawnId)).toBe(false);
  });

  test("spawn without session store works normally (backward compatibility)", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    // No session store passed — must not throw. Use /tmp groveDir for fast test.
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
    );

    const result = await manager.spawn("claude", "bash");
    expect(result.spawnId).toBeDefined();
    expect(result.claimId).toBe("");
    expect(result.workspaceMode.status).toBe("fallback_workspace");
  });

  test("fallback workspace still receives Grove MCP config", async () => {
    const { existsSync, mkdirSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const projectRoot = mkdtempSync(join(tmpdir(), "grove-fallback-bootstrap-"));
    const groveDir = join(projectRoot, ".grove");
    const fallbackRoot = join(projectRoot, "fallback-workspaces");
    mkdirSync(groveDir, { recursive: true });

    const provider = makeMockProvider();
    provider.checkoutWorkspace = async (targetRef: string): Promise<string> =>
      join(fallbackRoot, targetRef);
    const tmux = makeMockTmux();
    manager = new SpawnManager(
      provider,
      tmux,
      () => undefined,
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      groveDir,
    );

    const result = await manager.spawn("coder", "bash");

    expect(result.workspaceMode.status).toBe("fallback_workspace");
    expect(existsSync(join(result.workspacePath, ".mcp.json"))).toBe(true);
    expect(existsSync(join(result.workspacePath, ".acpxrc.json"))).toBe(true);
    expect(existsSync(join(result.workspacePath, "CODEX.md"))).toBe(true);

    const mcpJson = JSON.parse(readFileSync(join(result.workspacePath, ".mcp.json"), "utf-8")) as {
      mcpServers: { grove: { env: { GROVE_DIR: string } } };
    };
    expect(mcpJson.mcpServers.grove.env.GROVE_DIR).toBe(groveDir);
  });

  test("destroy does not clear session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];
    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      store,
    );

    const result = await manager.spawn("claude", "bash");
    expect(["isolated_worktree", "fallback_workspace", "bootstrap_failed"]).toContain(
      result.workspaceMode.status,
    );
    expect(store.records.size).toBe(1);

    manager.destroy();

    // Records should still be in the store after destroy
    expect(store.records.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation tests
// ---------------------------------------------------------------------------

describe("SpawnManager — reconciliation", () => {
  test("reconcile reattaches live tmux sessions", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];

    // Pre-populate the store with a record that has a live tmux session
    const record: PersistedSpawnRecord = {
      spawnId: "agent-live",
      claimId: "claim-live",
      targetRef: "agent-live",
      agentId: "agent-live",
      workspacePath: "/tmp/ws/agent-live",
      spawnedAt: new Date().toISOString(),
    };
    store.save(record);

    // Simulate the tmux session being alive
    tmux.spawnedSessions.push("grove-agent-live");

    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      store,
    );
    const result = await manager.reconcile();

    expect(result.reattached).toBe(1);
    expect(result.released).toBe(0);

    // In-memory state was restored
    expect(manager.getSpawnRecord("agent-live")).toBeDefined();
    expect(manager.getSpawnRecord("agent-live")?.claimId).toBe("claim-live");

    // Store record was NOT removed (still live)
    expect(store.records.has("agent-live")).toBe(true);
  });

  test("reconcile releases dead tmux sessions", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];

    // Pre-populate the store with a record whose tmux session is dead
    const record: PersistedSpawnRecord = {
      spawnId: "agent-dead",
      claimId: "claim-dead",
      targetRef: "agent-dead",
      agentId: "agent-dead",
      workspacePath: "/tmp/ws/agent-dead",
      spawnedAt: new Date().toISOString(),
    };
    store.save(record);

    // tmux has no live sessions — agent-dead is orphaned

    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      store,
    );
    const result = await manager.reconcile();

    expect(result.reattached).toBe(0);
    expect(result.released).toBe(1);

    // In-memory state was NOT restored
    expect(manager.getSpawnRecord("agent-dead")).toBeUndefined();

    // Store record was removed
    expect(store.records.has("agent-dead")).toBe(false);
    expect(store.removeCalls).toContain("agent-dead");

    // Workspace was cleaned
    expect(provider.cleanedWorkspaces.has("agent-dead:agent-dead")).toBe(true);
  });

  test("reconcile handles mix of live and dead sessions", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];

    store.save({
      spawnId: "alive",
      claimId: "claim-alive",
      targetRef: "alive",
      agentId: "alive",
      workspacePath: "/tmp/ws/alive",
      spawnedAt: new Date().toISOString(),
    });
    store.save({
      spawnId: "dead",
      claimId: "claim-dead",
      targetRef: "dead",
      agentId: "dead",
      workspacePath: "/tmp/ws/dead",
      spawnedAt: new Date().toISOString(),
    });

    // Only "alive" has a tmux session
    tmux.spawnedSessions.push("grove-alive");

    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      store,
    );
    const result = await manager.reconcile();

    expect(result.reattached).toBe(1);
    expect(result.released).toBe(1);

    // Live session reattached
    expect(manager.getSpawnRecord("alive")).toBeDefined();

    // Dead session cleaned up
    expect(manager.getSpawnRecord("dead")).toBeUndefined();
    expect(store.records.has("dead")).toBe(false);
    expect(provider.cleanedWorkspaces.has("dead:dead")).toBe(true);
  });

  test("reconcile returns zeroes with no session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];

    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), [
      { kind: "local" as const, path: "/tmp" },
    ]);
    const result = await manager.reconcile();

    expect(result.reattached).toBe(0);
    expect(result.released).toBe(0);
  });

  test("reconcile returns zeroes with empty session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];

    manager = new SpawnManager(
      provider,
      tmux,
      (msg) => errors.push(msg),
      [{ kind: "local" as const, path: "/tmp" }],
      store,
    );
    const result = await manager.reconcile();

    expect(result.reattached).toBe(0);
    expect(result.released).toBe(0);
  });

  test("setWsBridge late-registers hyphenated roles by full role name", async () => {
    // Regression: setWsBridge used to derive role via spawnId.split("-")[0],
    // which truncates `code-reviewer-mo3i3zh6` to `code` and drops inbound
    // IPC because NexusWsBridge does an exact role lookup downstream.
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), [
      { kind: "local" as const, path: "/tmp" },
    ]);

    const seedSession = {
      id: "grove-code-reviewer-0--mo3i3zh6",
      role: "code-reviewer",
      status: "running" as const,
    };
    // Seed agentSessions directly — we're testing setWsBridge in isolation,
    // not the full spawn pipeline.
    (manager as unknown as { agentSessions: Map<string, typeof seedSession> }).agentSessions.set(
      "code-reviewer-mo3i3zh6",
      seedSession,
    );

    const registered: { role: string; sessionId: string }[] = [];
    const stubBridge = {
      registerSession(role: string, session: { id: string }) {
        registered.push({ role, sessionId: session.id });
      },
      close() {
        /* destroy() calls this on teardown */
      },
    } as unknown as Parameters<typeof manager.setWsBridge>[0];

    manager.setWsBridge(stubBridge);

    expect(registered).toHaveLength(1);
    expect(registered[0]!.role).toBe("code-reviewer");
    expect(registered[0]!.sessionId).toBe("grove-code-reviewer-0--mo3i3zh6");
  });
});

describe("SpawnManager — delivery state recovery", () => {
  const makeManager = () => {
    const provider = makeMockProvider();
    const tmux = new MockTmuxManager();
    return new SpawnManager(provider, tmux, () => undefined, [
      { kind: "local" as const, path: "/tmp" },
    ]);
  };

  test("markDeliveryRecovered flips disabled → ready", () => {
    const manager = makeManager();
    manager.markDeliveryDisabled("transient outage");
    expect(manager.getDeliveryState()).toBe("disabled");

    manager.markDeliveryRecovered();
    expect(manager.getDeliveryState()).toBe("ready");
    expect(manager.getDeliveryDisabledReason()).toBeUndefined();
  });

  test("markDeliveryRecovered is a no-op when already ready", () => {
    const manager = makeManager();
    manager.markDeliveryReady();
    expect(manager.getDeliveryState()).toBe("ready");
    manager.markDeliveryRecovered();
    expect(manager.getDeliveryState()).toBe("ready");
  });

  test("markDeliveryRecovered resolves pending waiters", async () => {
    const manager = makeManager();
    manager.markDeliveryDisabled("outage");
    manager.markDeliveryRecovered();
    await expect(manager.testWaitForDelivery(100)).resolves.toBeUndefined();
  });
});

describe("SpawnManager — local contribution delivery", () => {
  test("local delivery suppresses managed Nexus URL in spawned MCP config", async () => {
    const { projectRoot, groveDir } = makeTempGitProject("grove-local-delivery-mcp-");
    try {
      writeNexusGroveConfig(groveDir, {
        policy: "warn-and-fallback",
        nexusUrl: "http://localhost:23456",
      });
      const provider = makeMockProvider();
      const runtime = makeMockRuntime();
      manager = new SpawnManager(
        provider,
        undefined,
        () => undefined,
        [{ kind: "local" as const, path: projectRoot }],
        undefined,
        groveDir,
        runtime,
      );
      manager.setTopology(makeTopology());
      manager.enableLocalContributionDelivery({ seedExisting: false, startTimers: false });

      const spawned = await manager.spawn("coder", "codex");
      const mcpConfig = JSON.parse(
        readFileSync(join(spawned.workspacePath, ".mcp.json"), "utf-8"),
      ) as {
        readonly mcpServers?: {
          readonly grove?: { readonly env?: Readonly<Record<string, string>> | undefined };
        };
      };
      const forwardedEnv = runtime.configs[0]?.mcpServers?.[0]?.env;

      expect(mcpConfig.mcpServers?.grove?.env?.GROVE_NEXUS_URL).toBeUndefined();
      expect(forwardedEnv?.GROVE_NEXUS_URL).toBeUndefined();
      expect(forwardedEnv?.GROVE_ROUTING_TOKEN).toBeDefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("routes signed local contributions and marks matching handoffs delivered without Nexus", async () => {
    const provider = makeMockProvider();
    const runtime = makeMockRuntime();
    const deliveredHandoffs: string[] = [];
    const handoffs: Handoff[] = [];
    (provider.capabilities as { handoffs: boolean }).handoffs = true;
    Object.assign(provider, {
      getHandoffs: async (query?: { readonly sourceCid?: string; readonly toRole?: string }) =>
        handoffs.filter(
          (handoff) =>
            (query?.sourceCid === undefined || handoff.sourceCid === query.sourceCid) &&
            (query?.toRole === undefined || handoff.toRole === query.toRole),
        ),
      markHandoffDelivered: async (handoffId: string) => {
        deliveredHandoffs.push(handoffId);
      },
      cancelHandoff: async () => undefined,
      manualResolveHandoff: async () => undefined,
      resendHandoff: async () => undefined,
      rerouteHandoff: async () => undefined,
    });

    manager = new SpawnManager(
      provider,
      undefined,
      () => undefined,
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
      runtime,
    );
    manager.setTopology(makeTopology());
    expect(manager.getDeliveryState()).toBe("pending");

    manager.enableLocalContributionDelivery({ seedExisting: false, startTimers: false });
    expect(manager.getDeliveryState()).toBe("ready");

    const coder = await manager.spawn("coder", "codex");
    await manager.spawn("reviewer", "claude", undefined, 0, { waitForPush: true });
    const coderToken = runtime.configs.find((config) => config.role === "coder")?.env
      ?.GROVE_ROUTING_TOKEN;
    expect(coderToken).toBeDefined();

    const contribution = signContributionForRouting(
      makeContribution({
        summary: "local coder handoff",
        agent: { agentId: "session-coder", role: "coder" },
      }),
      coderToken ?? "missing-token",
    );
    handoffs.push({
      handoffId: "handoff-1",
      sourceCid: contribution.cid,
      fromRole: "coder",
      toRole: "reviewer",
      status: HandoffStatus.PendingPickup,
      requiresReply: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    provider.contributions.push(contribution);

    await manager.testPollLocalContributions();

    expect(runtime.sendCalls).toHaveLength(1);
    expect(runtime.sendCalls[0]?.session.id).toBe("session-reviewer");
    expect(runtime.sendCalls[0]?.message).toContain("local coder handoff");
    expect(runtime.sendCalls[0]?.message).toContain(coder.workspacePath);
    expect(deliveredHandoffs).toEqual(["handoff-1"]);
  });

  test("routes signed local contributions from the matching same-role session", async () => {
    const provider = makeMockProvider();
    const runtime = makeMockRuntime();
    const deliveredHandoffs: string[] = [];
    const handoffs: Handoff[] = [];
    (provider.capabilities as { handoffs: boolean }).handoffs = true;
    Object.assign(provider, {
      getHandoffs: async (query?: { readonly sourceCid?: string; readonly toRole?: string }) =>
        handoffs.filter(
          (handoff) =>
            (query?.sourceCid === undefined || handoff.sourceCid === query.sourceCid) &&
            (query?.toRole === undefined || handoff.toRole === query.toRole),
        ),
      markHandoffDelivered: async (handoffId: string) => {
        deliveredHandoffs.push(handoffId);
      },
      cancelHandoff: async () => undefined,
      manualResolveHandoff: async () => undefined,
      resendHandoff: async () => undefined,
      rerouteHandoff: async () => undefined,
    });

    manager = new SpawnManager(
      provider,
      undefined,
      () => undefined,
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
      runtime,
    );
    manager.setTopology(makeTopology());
    manager.enableLocalContributionDelivery({ seedExisting: false, startTimers: false });

    await manager.spawn("coder", "codex");
    const secondCoder = await manager.spawn("coder", "codex");
    await manager.spawn("reviewer", "claude", undefined, 0, { waitForPush: true });
    const coderToken = runtime.configs.find((config) => config.role === "coder")?.env
      ?.GROVE_ROUTING_TOKEN;
    expect(coderToken).toBeDefined();

    const contribution = signContributionForRouting(
      makeContribution({
        summary: "second local coder handoff",
        agent: { agentId: "session-coder-2", role: "coder" },
      }),
      coderToken ?? "missing-token",
    );
    handoffs.push({
      handoffId: "handoff-second-coder",
      sourceCid: contribution.cid,
      fromRole: "coder",
      toRole: "reviewer",
      status: HandoffStatus.PendingPickup,
      requiresReply: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    provider.contributions.push(contribution);

    await manager.testPollLocalContributions();

    expect(runtime.sendCalls).toHaveLength(1);
    expect(runtime.sendCalls[0]?.session.id).toBe("session-reviewer");
    expect(runtime.sendCalls[0]?.message).toContain("second local coder handoff");
    expect(runtime.sendCalls[0]?.message).toContain(secondCoder.workspacePath);
    expect(deliveredHandoffs).toEqual(["handoff-second-coder"]);
  });

  test("marks matching handoffs delivered only after the target turn succeeds", async () => {
    const provider = makeMockProvider();
    const runtime = makeMockRuntime();
    const deliveredHandoffs: string[] = [];
    const handoffs: Handoff[] = [];
    (provider.capabilities as { handoffs: boolean }).handoffs = true;
    Object.assign(provider, {
      getHandoffs: async (query?: { readonly sourceCid?: string; readonly toRole?: string }) =>
        handoffs.filter(
          (handoff) =>
            (query?.sourceCid === undefined || handoff.sourceCid === query.sourceCid) &&
            (query?.toRole === undefined || handoff.toRole === query.toRole),
        ),
      markHandoffDelivered: async (handoffId: string) => {
        deliveredHandoffs.push(handoffId);
      },
      cancelHandoff: async () => undefined,
      manualResolveHandoff: async () => undefined,
      resendHandoff: async () => undefined,
      rerouteHandoff: async () => undefined,
    });

    manager = new SpawnManager(
      provider,
      undefined,
      () => undefined,
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
      runtime,
    );
    manager.setTopology(makeTopology());
    manager.enableLocalContributionDelivery({ seedExisting: false, startTimers: false });

    await manager.spawn("coder", "codex");
    await manager.spawn("reviewer", "claude", undefined, 0, { waitForPush: true });
    const coderToken = runtime.configs.find((config) => config.role === "coder")?.env
      ?.GROVE_ROUTING_TOKEN;
    expect(coderToken).toBeDefined();

    const pendingTurn = deferredTurn("turn-delayed");
    runtime.send = async (session: AgentSession, message: string) => {
      runtime.sendCalls.push({ session, message });
      return pendingTurn.turn;
    };

    const contribution = signContributionForRouting(
      makeContribution({
        summary: "delayed local handoff",
        agent: { agentId: "session-coder", role: "coder" },
      }),
      coderToken ?? "missing-token",
    );
    handoffs.push({
      handoffId: "handoff-delayed",
      sourceCid: contribution.cid,
      fromRole: "coder",
      toRole: "reviewer",
      status: HandoffStatus.PendingPickup,
      requiresReply: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    provider.contributions.push(contribution);

    const pollPromise = manager.testPollLocalContributions();
    await waitForCondition(() => runtime.sendCalls.length === 1);

    expect(deliveredHandoffs).toEqual([]);

    pendingTurn.resolve({ turnId: "turn-delayed", stopReason: "end_turn" });
    await pollPromise;

    expect(deliveredHandoffs).toEqual(["handoff-delayed"]);
  });

  test("dead-letters local handoffs when the target turn ends abnormally", async () => {
    const provider = makeMockProvider();
    const runtime = makeMockRuntime();
    const deliveredHandoffs: string[] = [];
    const deadLetteredHandoffs: string[] = [];
    const handoffs: Handoff[] = [];
    (provider.capabilities as { handoffs: boolean }).handoffs = true;
    Object.assign(provider, {
      getHandoffs: async (query?: { readonly sourceCid?: string; readonly toRole?: string }) =>
        handoffs.filter(
          (handoff) =>
            (query?.sourceCid === undefined || handoff.sourceCid === query.sourceCid) &&
            (query?.toRole === undefined || handoff.toRole === query.toRole),
        ),
      markHandoffDelivered: async (handoffId: string) => {
        deliveredHandoffs.push(handoffId);
      },
      cancelHandoff: async () => undefined,
      manualResolveHandoff: async () => undefined,
      resendHandoff: async () => undefined,
      rerouteHandoff: async () => undefined,
      getHandoffStore: () => ({
        list: async (query?: { readonly sourceCid?: string; readonly toRole?: string }) =>
          handoffs.filter(
            (handoff) =>
              (query?.sourceCid === undefined || handoff.sourceCid === query.sourceCid) &&
              (query?.toRole === undefined || handoff.toRole === query.toRole),
          ),
        markDeadLettered: async (handoffId: string) => {
          deadLetteredHandoffs.push(handoffId);
        },
      }),
    });

    manager = new SpawnManager(
      provider,
      undefined,
      () => undefined,
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
      runtime,
    );
    manager.setTopology(makeTopology());
    manager.enableLocalContributionDelivery({ seedExisting: false, startTimers: false });

    await manager.spawn("coder", "codex");
    await manager.spawn("reviewer", "claude", undefined, 0, { waitForPush: true });
    const coderToken = runtime.configs.find((config) => config.role === "coder")?.env
      ?.GROVE_ROUTING_TOKEN;
    expect(coderToken).toBeDefined();

    runtime.send = async (session: AgentSession, message: string) => {
      runtime.sendCalls.push({ session, message });
      return {
        ...deferredTurn("turn-max-tokens").turn,
        sessionId: session.id,
        result: Promise.resolve({ turnId: "turn-max-tokens", stopReason: "max_tokens" as const }),
      };
    };

    const contribution = signContributionForRouting(
      makeContribution({
        summary: "abnormal local handoff",
        agent: { agentId: "session-coder", role: "coder" },
      }),
      coderToken ?? "missing-token",
    );
    handoffs.push({
      handoffId: "handoff-abnormal",
      sourceCid: contribution.cid,
      fromRole: "coder",
      toRole: "reviewer",
      status: HandoffStatus.PendingPickup,
      requiresReply: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    provider.contributions.push(contribution);

    await manager.testPollLocalContributions();

    expect(runtime.sendCalls).toHaveLength(1);
    expect(deliveredHandoffs).toEqual([]);
    expect(deadLetteredHandoffs).toEqual(["handoff-abnormal"]);
    expect(manager.getAgentFailures().get("reviewer")).toContain("stopReason=max_tokens");
  });

  test("re-seeds historical contributions when local routing scope changes to a resumed session", async () => {
    const provider = makeMockProvider();
    const runtime = makeMockRuntime();
    let sessionContributions: ReturnType<typeof makeContribution>[] = [];
    let sessionReads = 0;
    (provider.capabilities as { sessions: boolean }).sessions = true;
    Object.assign(provider, {
      getSessionContributions: async () => {
        sessionReads++;
        return sessionContributions;
      },
    });

    manager = new SpawnManager(
      provider,
      undefined,
      () => undefined,
      [{ kind: "local" as const, path: "/tmp" }],
      undefined,
      "/tmp/no-grove",
      runtime,
    );
    manager.setTopology(makeTopology());
    manager.enableLocalContributionDelivery({ startTimers: false });

    await manager.spawn("coder", "codex");
    await manager.spawn("reviewer", "claude", undefined, 0, { waitForPush: true });
    const coderToken = runtime.configs.find((config) => config.role === "coder")?.env
      ?.GROVE_ROUTING_TOKEN;
    expect(coderToken).toBeDefined();

    const historical = signContributionForRouting(
      makeContribution({
        summary: "historical resumed contribution",
        createdAt: "2026-01-01T00:00:00.000Z",
        agent: { agentId: "session-coder", role: "coder" },
      }),
      coderToken ?? "missing-token",
    );
    sessionContributions = [historical];

    manager.setSessionId("resumed-session");
    await waitForCondition(() => sessionReads > 0);

    await manager.testPollLocalContributions();
    expect(runtime.sendCalls).toHaveLength(0);

    const fresh = signContributionForRouting(
      makeContribution({
        summary: "fresh resumed contribution",
        createdAt: "2026-01-01T00:00:01.000Z",
        agent: { agentId: "session-coder", role: "coder" },
      }),
      coderToken ?? "missing-token",
    );
    sessionContributions = [historical, fresh];

    await manager.testPollLocalContributions();

    expect(runtime.sendCalls).toHaveLength(1);
    expect(runtime.sendCalls[0]?.message).toContain("fresh resumed contribution");
  });
});
