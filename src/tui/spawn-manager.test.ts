/**
 * Tests for SpawnManager — exercises the real spawn/kill lifecycle
 * including timer setup/teardown and tmux failure rollback.
 *
 * Uses mock provider + mock TmuxManager to test the actual wiring
 * in SpawnManager (not just provider methods).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Claim } from "../core/models.js";
import type { SpawnOptions, TmuxManager } from "./agents/tmux-manager.js";
import type { ClaimInput, ClaimsQuery, TuiDataProvider } from "./provider.js";
import { SpawnManager } from "./spawn-manager.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Minimal mock provider that tracks claims in memory. */
function makeMockProvider(): TuiDataProvider & {
  readonly claims: Map<string, Claim>;
  readonly workspaces: Map<string, string>;
  readonly cleanedWorkspaces: Set<string>;
  heartbeatCount: number;
} {
  const claims = new Map<string, Claim>();
  const workspaces = new Map<string, string>();
  const cleanedWorkspaces = new Set<string>();
  let heartbeatCount = 0;

  return {
    claims,
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
      return [];
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

    close() {},
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

    async sendKeys() {},
    async capturePanes() {
      return "";
    },
  };
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
  test("spawn creates workspace, claim, tmux session, and starts heartbeat timer", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));

    const result = await manager.spawn("claude", "bash");

    // Workspace was created
    expect(provider.workspaces.has(result.spawnId)).toBe(true);

    // Claim was created and is active
    expect(provider.claims.has(result.claimId)).toBe(true);
    expect(provider.claims.get(result.claimId)?.status).toBe("active");

    // Tmux session was spawned
    expect(tmux.spawnedSessions).toContain(`grove-${result.spawnId}`);

    // Heartbeat timer is running
    expect(manager.hasHeartbeat(result.claimId)).toBe(true);

    // Spawn record is tracked
    expect(manager.getSpawnRecord(result.spawnId)).toBeDefined();
    expect(manager.getSpawnRecord(result.spawnId)?.claimId).toBe(result.claimId);

    expect(errors).toHaveLength(0);
  });

  test("kill stops heartbeat, releases claim, and cleans workspace", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));

    const result = await manager.spawn("claude", "bash");
    const sessionName = `grove-${result.spawnId}`;

    // Kill the session
    await manager.kill(sessionName);

    // Heartbeat timer was stopped
    expect(manager.hasHeartbeat(result.claimId)).toBe(false);

    // Spawn record was removed
    expect(manager.getSpawnRecord(result.spawnId)).toBeUndefined();

    // Claim was released
    expect(provider.claims.get(result.claimId)?.status).toBe("released");

    // Workspace was cleaned
    expect(provider.cleanedWorkspaces.has(`${result.spawnId}:${result.spawnId}`)).toBe(true);

    // Tmux session was killed
    expect(tmux.killedSessions).toContain(sessionName);

    expect(errors).toHaveLength(0);
  });

  test("tmux.spawn() failure rolls back claim and workspace", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux(true); // configured to fail
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));

    await expect(manager.spawn("claude", "bash")).rejects.toThrow("tmux spawn failed");

    // Claim was created then released (rolled back)
    const allClaims = [...provider.claims.values()];
    expect(allClaims).toHaveLength(1);
    expect(allClaims[0]?.status).toBe("released");

    // Workspace was cleaned (rolled back)
    expect(provider.cleanedWorkspaces.size).toBe(1);

    // No heartbeat timer was started
    for (const claim of allClaims) {
      expect(manager.hasHeartbeat(claim.claimId)).toBe(false);
    }

    // No spawn record tracked
    const firstClaim = allClaims[0];
    expect(firstClaim).toBeDefined();
    expect(manager.getSpawnRecord(firstClaim?.agent.agentId ?? "")).toBeUndefined();
  });

  test("kill works even after claim lease expires (uses local tracking)", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));

    const result = await manager.spawn("claude", "bash");
    const sessionName = `grove-${result.spawnId}`;

    // Simulate lease expiry: change claim status to "expired"
    const claim = provider.claims.get(result.claimId);
    if (claim) {
      provider.claims.set(result.claimId, {
        ...claim,
        status: "expired" as Claim["status"],
      });
    }

    // Kill should still work via local spawn records
    await manager.kill(sessionName);

    // Heartbeat timer was stopped
    expect(manager.hasHeartbeat(result.claimId)).toBe(false);

    // Spawn record was removed
    expect(manager.getSpawnRecord(result.spawnId)).toBeUndefined();

    // Workspace was cleaned
    expect(provider.cleanedWorkspaces.has(`${result.spawnId}:${result.spawnId}`)).toBe(true);
  });

  test("destroy stops all heartbeat timers", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));

    const result1 = await manager.spawn("agent-a", "bash");
    const result2 = await manager.spawn("agent-b", "bash");

    expect(manager.hasHeartbeat(result1.claimId)).toBe(true);
    expect(manager.hasHeartbeat(result2.claimId)).toBe(true);

    manager.destroy();

    expect(manager.hasHeartbeat(result1.claimId)).toBe(false);
    expect(manager.hasHeartbeat(result2.claimId)).toBe(false);
  });

  test("heartbeat error is reported via onError callback", async () => {
    const provider = makeMockProvider();
    // Make heartbeatClaim reject after the first successful call
    let callCount = 0;
    provider.heartbeatClaim = async () => {
      callCount++;
      throw new Error("lease expired");
    };

    const tmux = makeMockTmux();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));
    manager.heartbeatIntervalMs = 10; // 10ms for fast test

    await manager.spawn("claude", "bash");

    // Wait for at least one heartbeat tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toContain("lease expired");
  });

  test("spawn without workspace support throws", async () => {
    const provider = makeMockProvider();
    // Remove workspace support
    (provider as unknown as Record<string, unknown>).checkoutWorkspace = undefined;

    const tmux = makeMockTmux();
    manager = new SpawnManager(provider, tmux, () => {});

    await expect(manager.spawn("claude", "bash")).rejects.toThrow(
      "Provider does not support workspace checkout",
    );
  });
});
