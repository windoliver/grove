import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GossipService } from "../../src/core/gossip/types.js";
import { PeerStatus } from "../../src/core/gossip/types.js";
import { createApp } from "../../src/server/app.js";
import type { ServerDeps } from "../../src/server/deps.js";
import type { TestContext } from "./helpers.js";
import { createTestContext, validManifestBody } from "./helpers.js";

describe("GET /api/grove", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns grove metadata with gossip disabled", async () => {
    const res = await ctx.app.request("/api/grove");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.version).toBe("0.1.0");
    expect(data.protocol.manifestVersion).toBe(1);
    expect(data.stats.contributions).toBe(0);
    expect(data.stats.activeClaims).toBe(0);
    expect(data.gossip).toEqual({ enabled: false });
  });

  test("returns gossip status when enabled", async () => {
    const mockPeer = {
      peerId: "peer-1",
      address: "http://localhost:4516",
      age: 2,
      lastSeen: "2025-01-01T00:00:00.000Z",
    };
    const mockGossip: GossipService = {
      start: () => {},
      stop: async () => {},
      handleExchange: async (msg) => msg,
      handleShuffle: () => ({ offered: [] }),
      peers: () => [mockPeer],
      liveness: () => [
        {
          peer: mockPeer,
          status: PeerStatus.Alive,
          lastSeen: "2025-01-01T00:00:00.000Z",
          suspectedAt: undefined,
        },
      ],
      currentMessage: async () => ({
        peerId: "self",
        frontier: [],
        load: { queueDepth: 0 },
        capabilities: {},
        timestamp: new Date().toISOString(),
      }),
      mergedFrontier: () => [],
      on: () => {},
      off: () => {},
    };

    const depsWithGossip: ServerDeps = { ...ctx.deps, gossip: mockGossip };
    const appWithGossip = createApp(depsWithGossip);
    const res = await appWithGossip.request("/api/grove");
    const data = await res.json();

    expect(data.gossip.enabled).toBe(true);
    expect(data.gossip.peers).toBe(1);
    expect(data.gossip.liveness).toHaveLength(1);
    expect(data.gossip.liveness[0].peerId).toBe("peer-1");
    expect(data.gossip.liveness[0].status).toBe("alive");
  });

  test("stats reflect contributions count", async () => {
    await ctx.app.request("/api/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validManifestBody()),
    });

    const res = await ctx.app.request("/api/grove");
    const data = await res.json();
    expect(data.stats.contributions).toBe(1);
  });

  test("stats reflect active claims count", async () => {
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetRef: "some-target",
        agent: { agentId: "agent-1" },
        intentSummary: "Working on it",
      }),
    });

    const res = await ctx.app.request("/api/grove");
    const data = await res.json();
    expect(data.stats.activeClaims).toBe(1);
  });
});
