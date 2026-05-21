/**
 * Tests for NexusDataProvider lifecycle methods.
 *
 * Uses mock NexusClient and mock WorkspaceManager to test
 * createClaim, checkoutWorkspace, releaseClaim, cleanWorkspace.
 */

import { describe, expect, test } from "bun:test";
import { createContribution } from "../core/manifest.js";
import type { Claim, Contribution } from "../core/models.js";
import type { WorkspaceInfo, WorkspaceManager } from "../core/workspace.js";
import { WorkspaceStatus } from "../core/workspace.js";
import { MockNexusClient } from "../nexus/mock-client.js";
import { NexusContributionStore } from "../nexus/nexus-contribution-store.js";
import { NexusSessionStore } from "../nexus/nexus-session-store.js";
import { NexusDataProvider } from "./nexus-provider.js";

// ---------------------------------------------------------------------------
// Mock workspace manager
// ---------------------------------------------------------------------------

function makeMockWorkspaceManager(): WorkspaceManager & {
  readonly createdWorkspaces: Map<string, WorkspaceInfo>;
  readonly cleanedWorkspaces: Set<string>;
} {
  const createdWorkspaces = new Map<string, WorkspaceInfo>();
  const cleanedWorkspaces = new Set<string>();

  return {
    createdWorkspaces,
    cleanedWorkspaces,

    checkout: async (cid, _options) => {
      // Simulate failure for non-CID keys (like spawnIds)
      throw new Error(`Contribution not found: ${cid}`);
    },

    createBareWorkspace: async (key, options) => {
      const info: WorkspaceInfo = {
        cid: key,
        workspacePath: `/tmp/workspaces/${key}-${options.agent.agentId}`,
        agent: options.agent,
        status: WorkspaceStatus.Active,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      };
      createdWorkspaces.set(key, info);
      return info;
    },

    getWorkspace: async () => undefined,
    listWorkspaces: async () => [],
    cleanWorkspace: async (cid, agentId) => {
      cleanedWorkspaces.add(`${cid}:${agentId}`);
      return true;
    },
    markStale: async () => [],
    markWorkspaceStale: async () => {
      throw new Error("Not found");
    },
    touchWorkspace: async () => {
      throw new Error("Not found");
    },
    close: () => {
      /* noop */
    },
  };
}

function makeNexusContribution(_cid: string, summary: string): Contribution {
  return createContribution({
    kind: "work",
    mode: "evaluation",
    summary,
    tags: [],
    artifacts: {},
    relations: [],
    agent: { agentId: "agent-1" },
    createdAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusDataProvider lifecycle", () => {
  function createProvider(withWorkspace = true) {
    const client = new MockNexusClient();
    const workspace = withWorkspace ? makeMockWorkspaceManager() : undefined;
    const provider = new NexusDataProvider({
      nexusConfig: { client, zoneId: "test" },
      workspaceManager: workspace,
    });
    return { provider, client, workspace };
  }

  test("NexusDataProvider reads recipient inbox from Nexus IPC source", async () => {
    const client = new MockNexusClient();
    await client.write(
      "/zones/zone-1/sessions/sess-1/ipc/bob/inbox/msg-1.json",
      new TextEncoder().encode(
        JSON.stringify({
          message_id: "msg-1",
          sender: "alice",
          recipient: "bob",
          timestamp: "2026-05-12T12:00:00.000Z",
          payload: {
            kind: "grove.message",
            cid: "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            body: "provider inbox",
            recipients: ["@bob"],
            createdAt: "2026-05-12T12:00:00.000Z",
            from: { agentId: "alice" },
          },
        }),
      ),
    );

    const provider = new NexusDataProvider({
      nexusConfig: { client, zoneId: "zone-1" },
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
    });
    provider.setSessionScope("sess-1");

    const messages = await provider.getInboxMessages({ recipient: "@bob" });

    expect(messages.map((m) => m.body)).toEqual(["provider inbox"]);
  });

  test("getSessionContributions reads Nexus session links without a co-located server", async () => {
    const client = new MockNexusClient();
    const contributionStore = new NexusContributionStore({ client, zoneId: "zone-1" });
    const sessionStore = new NexusSessionStore(client, "zone-1");
    const first = makeNexusContribution(
      "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "first",
    );
    const second = makeNexusContribution(
      "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "second",
    );
    await contributionStore.put(first);
    await contributionStore.put(second);
    const session = await sessionStore.createSession({ goal: "nexus history" });
    await sessionStore.addContribution(session.id, second.cid);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await sessionStore.addContribution(session.id, first.cid);

    const provider = new NexusDataProvider({
      nexusConfig: { client, zoneId: "zone-1" },
    });

    const result = await provider.getSessionContributions(session.id);

    expect(result.map((c) => c.cid)).toEqual([second.cid, first.cid]);
  });

  test("createClaim creates a claim via NexusClaimStore", async () => {
    const { provider } = createProvider();

    const claim = await provider.createClaim({
      targetRef: "spawn-1",
      agent: { agentId: "agent-1" },
      intentSummary: "TUI-spawned: bash",
      leaseDurationMs: 300_000,
    });

    expect(claim.targetRef).toBe("spawn-1");
    expect(claim.agent.agentId).toBe("agent-1");
    expect(claim.status).toBe("active");
    expect(claim.intentSummary).toBe("TUI-spawned: bash");
  });

  test("checkoutWorkspace falls back to createBareWorkspace for spawnIds", async () => {
    const { provider, workspace } = createProvider();

    const path = await provider.checkoutWorkspace("spawn-1", { agentId: "agent-1" });

    expect(path).toContain("spawn-1");
    expect(path).toContain("agent-1");
    expect(workspace?.createdWorkspaces.has("spawn-1")).toBe(true);
  });

  test("checkoutWorkspace throws when workspace manager is not available", async () => {
    const { provider } = createProvider(false);

    await expect(provider.checkoutWorkspace("spawn-1", { agentId: "agent-1" })).rejects.toThrow(
      "Workspace manager not available",
    );
  });

  test("releaseClaim releases a claim", async () => {
    const { provider } = createProvider();

    // Create a claim first
    const claim = await provider.createClaim({
      targetRef: "spawn-2",
      agent: { agentId: "agent-2" },
      intentSummary: "test",
      leaseDurationMs: 300_000,
    });

    // Release it
    await provider.releaseClaim(claim.claimId);

    // Verify claim is no longer active
    const claims = await provider.getClaims({ status: "active" });
    const found = claims.find((c: Claim) => c.claimId === claim.claimId);
    expect(found).toBeUndefined();
  });

  test("cleanWorkspace delegates to workspace manager", async () => {
    const { provider, workspace } = createProvider();

    await provider.cleanWorkspace("spawn-1", "agent-1");

    expect(workspace?.cleanedWorkspaces.has("spawn-1:agent-1")).toBe(true);
  });

  test("cleanWorkspace is a no-op without workspace manager", async () => {
    const { provider } = createProvider(false);

    // Should not throw
    await provider.cleanWorkspace("spawn-1", "agent-1");
  });

  test("full lifecycle: create claim → checkout → release → clean", async () => {
    const { provider, workspace } = createProvider();

    // Step 1: Checkout workspace
    const workspacePath = await provider.checkoutWorkspace("spawn-life", {
      agentId: "agent-life",
    });
    expect(workspacePath).toContain("spawn-life");

    // Step 2: Create claim
    const claim = await provider.createClaim({
      targetRef: "spawn-life",
      agent: { agentId: "agent-life" },
      intentSummary: "lifecycle test",
      leaseDurationMs: 300_000,
      context: { workspacePath },
    });
    expect(claim.status).toBe("active");

    // Step 3: Release claim
    await provider.releaseClaim(claim.claimId);

    // Step 4: Clean workspace
    await provider.cleanWorkspace("spawn-life", "agent-life");
    expect(workspace?.cleanedWorkspaces.has("spawn-life:agent-life")).toBe(true);
  });

  test("heartbeatClaim renews the lease", async () => {
    const { provider } = createProvider();

    // Create a claim
    const claim = await provider.createClaim({
      targetRef: "hb-target",
      agent: { agentId: "hb-agent" },
      intentSummary: "heartbeat test",
      leaseDurationMs: 60_000,
    });

    const originalExpiry = new Date(claim.leaseExpiresAt).getTime();

    // Heartbeat with a longer lease
    const renewed = await provider.heartbeatClaim(claim.claimId, 300_000);

    expect(renewed.claimId).toBe(claim.claimId);
    expect(new Date(renewed.leaseExpiresAt).getTime()).toBeGreaterThan(originalExpiry);
    expect(new Date(renewed.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
      new Date(claim.heartbeatAt).getTime(),
    );

    // Cleanup
    await provider.releaseClaim(claim.claimId);
  });
});

// ---------------------------------------------------------------------------
// Nexus-mode spawn path tests
// ---------------------------------------------------------------------------

describe("Nexus-mode spawn path", () => {
  function createProvider() {
    const client = new MockNexusClient();
    const workspace = makeMockWorkspaceManager();
    const provider = new NexusDataProvider({
      nexusConfig: { client, zoneId: "test" },
      workspaceManager: workspace,
    });
    return { provider, workspace };
  }

  test("spawn path: workspace → claim → heartbeat → kill → cleanup", async () => {
    const { provider, workspace } = createProvider();
    const spawnId = `claude-${Date.now().toString(36)}`;
    const agent = { agentId: spawnId, role: "claude" };

    // Step 1: Checkout workspace (simulates app.tsx doSpawn step 1)
    const workspacePath = await provider.checkoutWorkspace(spawnId, agent);
    expect(workspacePath).toContain(spawnId);
    expect(workspace.createdWorkspaces.has(spawnId)).toBe(true);

    // Step 2: Create claim (simulates app.tsx doSpawn step 2)
    const claim = await provider.createClaim({
      targetRef: spawnId,
      agent,
      intentSummary: "TUI-spawned: bash",
      leaseDurationMs: 300_000,
      context: { workspacePath },
    });
    expect(claim.status).toBe("active");

    // Step 3: Heartbeat (simulates the heartbeat timer)
    const heartbeated = await provider.heartbeatClaim(claim.claimId, 300_000);
    // Heartbeat should renew: new expiry >= original (same ms is fine)
    expect(new Date(heartbeated.leaseExpiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(claim.leaseExpiresAt).getTime(),
    );
    // Heartbeat timestamp should be updated
    expect(new Date(heartbeated.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
      new Date(claim.heartbeatAt).getTime(),
    );

    // Verify claim is still active
    const activeClaims = await provider.getClaims({ status: "active" });
    expect(activeClaims.find((c: Claim) => c.claimId === claim.claimId)).toBeDefined();

    // Step 4: Kill (simulates handleKill)
    await provider.releaseClaim(claim.claimId);
    await provider.cleanWorkspace(spawnId, spawnId);

    // Verify cleanup
    const afterKill = await provider.getClaims({ status: "active" });
    expect(afterKill.find((c: Claim) => c.claimId === claim.claimId)).toBeUndefined();
    expect(workspace.cleanedWorkspaces.has(`${spawnId}:${spawnId}`)).toBe(true);
  });

  test("tmux failure rolls back claim and workspace", async () => {
    const { provider, workspace } = createProvider();
    const spawnId = `fail-${Date.now().toString(36)}`;
    const agent = { agentId: spawnId };

    // Step 1: Checkout workspace
    const workspacePath = await provider.checkoutWorkspace(spawnId, agent);
    expect(workspacePath).toContain(spawnId);

    // Step 2: Create claim
    const claim = await provider.createClaim({
      targetRef: spawnId,
      agent,
      intentSummary: "will-fail",
      leaseDurationMs: 300_000,
      context: { workspacePath },
    });
    expect(claim.status).toBe("active");

    // Step 3: Simulate tmux.spawn() failure — roll back
    // (This is what app.tsx does in the catch block)
    await provider.releaseClaim(claim.claimId);
    await provider.cleanWorkspace(spawnId, spawnId);

    // Verify: no active claims remain for this spawn
    const afterRollback = await provider.getClaims({ status: "active" });
    expect(afterRollback.find((c: Claim) => c.claimId === claim.claimId)).toBeUndefined();
    expect(workspace.cleanedWorkspaces.has(`${spawnId}:${spawnId}`)).toBe(true);
  });
});
