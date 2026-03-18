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
      bounties: false,
      gossip: false,
      goals: false,
      sessions: false,
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
    manager = new SpawnManager(provider, tmux, () => {
      // No-op error callback for test.
    });

    await expect(manager.spawn("claude", "bash")).rejects.toThrow(
      "Provider does not support workspace checkout",
    );
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
    const mgr = new SpawnManager(provider, tmux, (msg) => errors.push(msg));

    // Assign to module-level `manager` so afterEach can call destroy().
    manager = mgr;

    mgr.setPrContext({ number: 42, title, filesChanged: 5 });

    const result = await mgr.spawn("claude", "bash");
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
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));
    manager.setPrContext({ number: 99, title, filesChanged: 10 });

    const result = await manager.spawn("claude", "bash");
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
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), store);

    const result = await manager.spawn("claude", "bash");

    // Session store was called with the correct record
    expect(store.saveCalls).toHaveLength(1);
    expect(store.saveCalls[0]?.spawnId).toBe(result.spawnId);
    expect(store.saveCalls[0]?.claimId).toBe(result.claimId);
    expect(store.saveCalls[0]?.workspacePath).toBe(result.workspacePath);
    expect(store.saveCalls[0]?.spawnedAt).toBeDefined();

    // Record is present in store
    expect(store.records.has(result.spawnId)).toBe(true);
  });

  test("kill removes record from session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), store);

    const result = await manager.spawn("claude", "bash");
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
    // No session store passed — must not throw
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));

    const result = await manager.spawn("claude", "bash");
    expect(result.spawnId).toBeDefined();
    expect(result.claimId).toBeDefined();
    expect(errors).toHaveLength(0);
  });

  test("destroy does not clear session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];
    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), store);

    await manager.spawn("claude", "bash");
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

    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), store);
    const result = await manager.reconcile();

    expect(result.reattached).toBe(1);
    expect(result.released).toBe(0);

    // In-memory state was restored
    expect(manager.getSpawnRecord("agent-live")).toBeDefined();
    expect(manager.getSpawnRecord("agent-live")?.claimId).toBe("claim-live");

    // Heartbeat was restarted
    expect(manager.hasHeartbeat("claim-live")).toBe(true);

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

    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), store);
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

    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), store);
    const result = await manager.reconcile();

    expect(result.reattached).toBe(1);
    expect(result.released).toBe(1);

    // Live session reattached
    expect(manager.getSpawnRecord("alive")).toBeDefined();
    expect(manager.hasHeartbeat("claim-alive")).toBe(true);

    // Dead session cleaned up
    expect(manager.getSpawnRecord("dead")).toBeUndefined();
    expect(store.records.has("dead")).toBe(false);
    expect(provider.cleanedWorkspaces.has("dead:dead")).toBe(true);
  });

  test("reconcile returns zeroes with no session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const errors: string[] = [];

    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg));
    const result = await manager.reconcile();

    expect(result.reattached).toBe(0);
    expect(result.released).toBe(0);
  });

  test("reconcile returns zeroes with empty session store", async () => {
    const provider = makeMockProvider();
    const tmux = makeMockTmux();
    const store = makeMockSessionStore();
    const errors: string[] = [];

    manager = new SpawnManager(provider, tmux, (msg) => errors.push(msg), store);
    const result = await manager.reconcile();

    expect(result.reattached).toBe(0);
    expect(result.released).toBe(0);
  });
});
