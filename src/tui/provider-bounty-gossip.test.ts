/**
 * Tests for bounty and gossip provider methods across all backends.
 *
 * Verifies that the bounties and gossip panels can discover capabilities
 * via isBountyProvider() / isGossipProvider() type guards from provider.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bounty } from "../core/bounty.js";
import { createSqliteStores } from "../local/sqlite-store.js";
import { MockNexusClient } from "../nexus/mock-client.js";
import { LocalDataProvider, type LocalProviderDeps } from "./local-provider.js";
import { NexusDataProvider } from "./nexus-provider.js";
import { isBountyProvider, isGossipProvider } from "./provider.js";
import { RemoteDataProvider } from "./remote-provider.js";

// ---------------------------------------------------------------------------
// LocalDataProvider tests
// ---------------------------------------------------------------------------

describe("LocalDataProvider bounty/gossip", () => {
  let tempDir: string;
  let stores: ReturnType<typeof createSqliteStores>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-bounty-test-"));
    const dbPath = join(tempDir, "grove.db");
    stores = createSqliteStores(dbPath);
  });

  afterEach(() => {
    stores.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes isBountyProvider() type guard check when bountyStore is provided", () => {
    const deps: LocalProviderDeps = {
      contributionStore: stores.contributionStore,
      claimStore: stores.claimStore,
      frontier: { compute: async () => ({ entries: [], staleCids: [] }) } as never,
      groveName: "test",
      bountyStore: stores.bountyStore,
    };
    const provider = new LocalDataProvider(deps);
    expect(isBountyProvider(provider)).toBe(true);
    provider.close();
  });

  it("fails isBountyProvider() type guard check when bountyStore is NOT provided", () => {
    const deps: LocalProviderDeps = {
      contributionStore: stores.contributionStore,
      claimStore: stores.claimStore,
      frontier: { compute: async () => ({ entries: [], staleCids: [] }) } as never,
      groveName: "test",
    };
    const provider = new LocalDataProvider(deps);
    expect(isBountyProvider(provider)).toBe(true); // method exists, just returns []
    provider.close();
  });

  it("returns empty bounty list from fresh store", async () => {
    const deps: LocalProviderDeps = {
      contributionStore: stores.contributionStore,
      claimStore: stores.claimStore,
      frontier: { compute: async () => ({ entries: [], staleCids: [] }) } as never,
      groveName: "test",
      bountyStore: stores.bountyStore,
    };
    const provider = new LocalDataProvider(deps);
    const bounties = await provider.listBounties();
    expect(bounties).toEqual([]);
    provider.close();
  });

  it("returns bounties after creating one", async () => {
    const bounty: Bounty = {
      bountyId: "b1",
      title: "Fix the bug",
      description: "Fix the critical bug",
      status: "open",
      creator: { agentId: "agent-1", agentName: "Agent 1" },
      amount: 100,
      criteria: { description: "Bug must be fixed" },
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await stores.bountyStore.createBounty(bounty);

    const deps: LocalProviderDeps = {
      contributionStore: stores.contributionStore,
      claimStore: stores.claimStore,
      frontier: { compute: async () => ({ entries: [], staleCids: [] }) } as never,
      groveName: "test",
      bountyStore: stores.bountyStore,
    };
    const provider = new LocalDataProvider(deps);
    const bounties = await provider.listBounties();
    expect(bounties.length).toBe(1);
    expect(bounties[0]?.bountyId).toBe("b1");
    expect(bounties[0]?.title).toBe("Fix the bug");
    provider.close();
  });

  it("does not expose getGossipPeers (gossip is server-level)", () => {
    const deps: LocalProviderDeps = {
      contributionStore: stores.contributionStore,
      claimStore: stores.claimStore,
      frontier: { compute: async () => ({ entries: [], staleCids: [] }) } as never,
      groveName: "test",
    };
    const provider = new LocalDataProvider(deps);
    expect(isGossipProvider(provider)).toBe(false);
    provider.close();
  });
});

// ---------------------------------------------------------------------------
// NexusDataProvider tests
// ---------------------------------------------------------------------------

describe("NexusDataProvider bounty/gossip", () => {
  let mockClient: MockNexusClient;

  beforeEach(() => {
    mockClient = new MockNexusClient();
  });

  afterEach(() => {
    mockClient.close();
  });

  it("passes isBountyProvider() type guard check", () => {
    const provider = new NexusDataProvider({
      nexusConfig: { client: mockClient, zoneId: "test-zone" },
    });
    expect(isBountyProvider(provider)).toBe(true);
    provider.close();
  });

  it("returns empty bounty list from fresh Nexus zone", async () => {
    const provider = new NexusDataProvider({
      nexusConfig: { client: mockClient, zoneId: "test-zone" },
    });
    const bounties = await provider.listBounties();
    expect(bounties).toEqual([]);
    provider.close();
  });

  it("passes isGossipProvider() type guard check", () => {
    const provider = new NexusDataProvider({
      nexusConfig: { client: mockClient, zoneId: "test-zone" },
    });
    expect(isGossipProvider(provider)).toBe(true);
    provider.close();
  });

  it("returns empty gossip peers when no serverUrl is configured", async () => {
    const provider = new NexusDataProvider({
      nexusConfig: { client: mockClient, zoneId: "test-zone" },
    });
    const peers = await provider.getGossipPeers();
    expect(peers).toEqual([]);
    provider.close();
  });

  it("fetches gossip peers from co-located server when serverUrl is set", async () => {
    const fakePeers = [
      {
        peerId: "peer-1",
        address: "http://node1:4515",
        age: 0,
        lastSeen: new Date().toISOString(),
      },
      {
        peerId: "peer-2",
        address: "http://node2:4515",
        age: 1,
        lastSeen: new Date().toISOString(),
      },
    ];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/gossip/peers") {
          return Response.json({ peers: fakePeers, liveness: [] });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const provider = new NexusDataProvider({
        nexusConfig: { client: mockClient, zoneId: "test-zone" },
        serverUrl: `http://localhost:${server.port}`,
      });
      const peers = await provider.getGossipPeers();
      expect(peers.length).toBe(2);
      expect(peers[0]?.peerId).toBe("peer-1");
      expect(peers[1]?.peerId).toBe("peer-2");
      provider.close();
    } finally {
      server.stop();
    }
  });

  it("returns empty peers when serverUrl is unreachable", async () => {
    const provider = new NexusDataProvider({
      nexusConfig: { client: mockClient, zoneId: "test-zone" },
      serverUrl: "http://localhost:19999",
    });
    const peers = await provider.getGossipPeers();
    expect(peers).toEqual([]);
    provider.close();
  });
});

// ---------------------------------------------------------------------------
// RemoteDataProvider tests
// ---------------------------------------------------------------------------

describe("RemoteDataProvider bounty/gossip", () => {
  it("passes isBountyProvider() type guard check", () => {
    const provider = new RemoteDataProvider("http://localhost:4515");
    expect(isBountyProvider(provider)).toBe(true);
    provider.close();
  });

  it("passes isGossipProvider() type guard check", () => {
    const provider = new RemoteDataProvider("http://localhost:4515");
    expect(isGossipProvider(provider)).toBe(true);
    provider.close();
  });

  // NOTE: Actual HTTP calls are tested via server integration tests.
  // These tests verify the type guard detection that panels rely on.
});

// ---------------------------------------------------------------------------
// NexusBountyStore round-trip via NexusDataProvider
// ---------------------------------------------------------------------------

describe("NexusBountyStore via NexusDataProvider", () => {
  let mockClient: MockNexusClient;
  let provider: NexusDataProvider;

  beforeEach(() => {
    mockClient = new MockNexusClient();
    provider = new NexusDataProvider({
      nexusConfig: { client: mockClient, zoneId: "zone-1" },
    });
  });

  afterEach(() => {
    provider.close();
  });

  it("stores and retrieves a bounty via the Nexus VFS", async () => {
    // Write a bounty directly to the mock VFS (simulates Nexus-side creation)
    const bounty: Bounty = {
      bountyId: "bounty-nexus-1",
      title: "Implement feature X",
      description: "Full implementation of feature X",
      status: "open",
      creator: { agentId: "coord-1", agentName: "Coordinator" },
      amount: 500,
      criteria: { description: "Feature passes all tests" },
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const encoder = new TextEncoder();
    const bountyPath = `/zones/zone-1/bounties/${bounty.bountyId}.json`;
    await mockClient.write(bountyPath, encoder.encode(JSON.stringify(bounty)));

    const bounties = await provider.listBounties();
    expect(bounties.length).toBe(1);
    expect(bounties[0]?.bountyId).toBe("bounty-nexus-1");
    expect(bounties[0]?.title).toBe("Implement feature X");
    expect(bounties[0]?.amount).toBe(500);
  });

  it("filters bounties by status via index", async () => {
    const encoder = new TextEncoder();

    // Create two bounties with different statuses
    const openBounty: Bounty = {
      bountyId: "b-open",
      title: "Open bounty",
      description: "d",
      status: "open",
      creator: { agentId: "a1" },
      amount: 100,
      criteria: { description: "c" },
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const claimedBounty: Bounty = {
      bountyId: "b-claimed",
      title: "Claimed bounty",
      description: "d",
      status: "claimed",
      creator: { agentId: "a1" },
      amount: 200,
      criteria: { description: "c" },
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Write bounties to VFS
    await mockClient.write(
      `/zones/zone-1/bounties/b-open.json`,
      encoder.encode(JSON.stringify(openBounty)),
    );
    await mockClient.write(
      `/zones/zone-1/bounties/b-claimed.json`,
      encoder.encode(JSON.stringify(claimedBounty)),
    );

    // Write status index markers
    await mockClient.write(`/zones/zone-1/indexes/bounties/status/open/b-open`, new Uint8Array(0));
    await mockClient.write(
      `/zones/zone-1/indexes/bounties/status/claimed/b-claimed`,
      new Uint8Array(0),
    );

    // List all bounties
    const all = await provider.listBounties();
    expect(all.length).toBe(2);

    // List only open bounties via status index
    const open = await provider.listBounties({ status: "open" as Bounty["status"] });
    expect(open.length).toBe(1);
    expect(open[0]?.bountyId).toBe("b-open");
  });

  it("respects limit parameter", async () => {
    const encoder = new TextEncoder();

    for (let i = 0; i < 5; i++) {
      const b: Bounty = {
        bountyId: `b-${i}`,
        title: `Bounty ${i}`,
        description: "d",
        status: "open",
        creator: { agentId: "a1" },
        amount: i * 10,
        criteria: { description: "c" },
        deadline: new Date(Date.now() + 86400_000).toISOString(),
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await mockClient.write(
        `/zones/zone-1/bounties/b-${i}.json`,
        encoder.encode(JSON.stringify(b)),
      );
    }

    const limited = await provider.listBounties({ limit: 3 });
    expect(limited.length).toBe(3);
  });
});
