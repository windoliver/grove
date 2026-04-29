/**
 * Integration tests for gossip HTTP routes.
 *
 * Tests the server routes at /api/gossip/* by creating a test app
 * with a real GossipService (using in-memory transport).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DefaultFrontierCalculator } from "../../src/core/frontier.js";
import type {
  FrontierDigestEntry,
  GossipEventListener,
  GossipMessage,
  GossipService,
  GossipTransport,
  PeerInfo,
  PeerLiveness,
  ShuffleRequest,
  ShuffleResponse,
} from "../../src/core/gossip/types.js";
import { InMemoryContributionStore } from "../../src/core/testing.js";
import { WatchHub } from "../../src/core/watch-hub.js";
import { DefaultGossipService, signPayload } from "../../src/gossip/protocol.js";
import { createApp } from "../../src/server/app.js";
import type { ServerDeps } from "../../src/server/deps.js";
import {
  InMemoryClaimStore,
  InMemoryContentStore,
  TEST_AUTH_HEADERS,
  TEST_NAMESPACE_KEY,
} from "../../src/server/test-helpers.js";

const TEST_REGISTRY = new Map([[TEST_NAMESPACE_KEY, "test-project/main"]]);
const TEST_HMAC_SECRET = "test-hmac-secret-for-routes-test";

function signGossipPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, hmacSignature: signPayload(payload, TEST_HMAC_SECRET) };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class NoOpTransport implements GossipTransport {
  async exchange(_peer: PeerInfo, _message: GossipMessage): Promise<GossipMessage> {
    return {
      peerId: "remote-peer",
      frontier: [],
      load: { queueDepth: 0 },
      capabilities: {},
      timestamp: new Date().toISOString(),
    };
  }
  async shuffle(_peer: PeerInfo, _request: ShuffleRequest): Promise<ShuffleResponse> {
    return { offered: [] };
  }
}

class CapturingGossipService implements GossipService {
  lastExchange: GossipMessage | undefined;
  lastShuffle: ShuffleRequest | undefined;

  start(): void {
    /* expected */
  }

  async stop(): Promise<void> {
    /* expected */
  }

  async handleExchange(message: GossipMessage): Promise<GossipMessage> {
    this.lastExchange = message;
    return this.currentMessage();
  }

  handleShuffle(request: ShuffleRequest): ShuffleResponse {
    this.lastShuffle = request;
    return { offered: [] };
  }

  peers(): readonly PeerInfo[] {
    return [];
  }

  liveness(): readonly PeerLiveness[] {
    return [];
  }

  async currentMessage(): Promise<GossipMessage> {
    return {
      peerId: "capture-server",
      frontier: [],
      load: { queueDepth: 0 },
      capabilities: {},
      timestamp: new Date().toISOString(),
    };
  }

  mergedFrontier(): readonly FrontierDigestEntry[] {
    return [];
  }

  on(_listener: GossipEventListener): void {
    /* expected */
  }

  off(_listener: GossipEventListener): void {
    /* expected */
  }
}

function appWithGossip(
  gossip: GossipService,
  hmacSecret = TEST_HMAC_SECRET,
): ReturnType<typeof createApp> {
  const contributionStore = new InMemoryContributionStore();
  const claimStore = new InMemoryClaimStore();
  const cas = new InMemoryContentStore();
  const frontier = new DefaultFrontierCalculator(contributionStore);

  const deps: ServerDeps = {
    contributionStore,
    claimStore,
    cas,
    frontier,
    gossip,
    gossipHmacSecret: hmacSecret,
  };
  return createApp(deps, TEST_REGISTRY);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let gossipService: DefaultGossipService;

beforeAll(() => {
  const contributionStore = new InMemoryContributionStore();
  const claimStore = new InMemoryClaimStore();
  const cas = new InMemoryContentStore();
  const frontier = new DefaultFrontierCalculator(contributionStore);

  gossipService = new DefaultGossipService({
    config: {
      peerId: "test-server",
      address: "http://localhost:0",
      seedPeers: [
        {
          peerId: "seed-1",
          address: "http://seed-1:4515",
          age: 0,
          lastSeen: new Date().toISOString(),
        },
      ],
      hmacSecret: TEST_HMAC_SECRET,
    },
    transport: new NoOpTransport(),
    frontier,
  });

  const deps: ServerDeps = {
    contributionStore,
    claimStore,
    cas,
    frontier,
    gossip: gossipService,
    gossipHmacSecret: TEST_HMAC_SECRET,
    watchHub: new WatchHub(),
  };
  const app = createApp(deps, TEST_REGISTRY);

  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// Tests: gossip not configured
// ---------------------------------------------------------------------------

describe("gossip routes: not configured", () => {
  let noGossipServer: ReturnType<typeof Bun.serve>;
  let noGossipUrl: string;

  beforeAll(() => {
    const contributionStore = new InMemoryContributionStore();
    const claimStore = new InMemoryClaimStore();
    const cas = new InMemoryContentStore();
    const frontier = new DefaultFrontierCalculator(contributionStore);

    const deps: ServerDeps = {
      contributionStore,
      claimStore,
      cas,
      frontier,
      watchHub: new WatchHub(),
    };
    const app = createApp(deps, TEST_REGISTRY);
    noGossipServer = Bun.serve({ port: 0, fetch: app.fetch });
    noGossipUrl = `http://localhost:${noGossipServer.port}`;
  });

  afterAll(() => {
    noGossipServer.stop(true);
  });

  it("POST /api/gossip/exchange returns 501 when gossip not configured", async () => {
    const res = await fetch(`${noGossipUrl}/api/gossip/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        peerId: "remote",
        frontier: [],
        load: { queueDepth: 0 },
        capabilities: {},
        timestamp: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(501);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("error");
  });

  it("POST /api/gossip/shuffle returns 501 when gossip not configured", async () => {
    const res = await fetch(`${noGossipUrl}/api/gossip/shuffle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        sender: {
          peerId: "remote",
          address: "http://remote:4515",
          age: 0,
          lastSeen: new Date().toISOString(),
        },
        offered: [],
      }),
    });
    expect(res.status).toBe(501);
  });

  it("GET /api/gossip/peers returns 501 when gossip not configured", async () => {
    const res = await fetch(`${noGossipUrl}/api/gossip/peers`, { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(501);
  });

  it("GET /api/gossip/frontier returns 501 when gossip not configured", async () => {
    const res = await fetch(`${noGossipUrl}/api/gossip/frontier`, { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// Tests: gossip exchange
// ---------------------------------------------------------------------------

describe("POST /api/gossip/exchange", () => {
  it("returns 200 with our gossip message", async () => {
    const payload = {
      peerId: "incoming-peer",
      frontier: [{ metric: "val_bpb", value: 0.97, cid: "blake3:abc123" }],
      load: { queueDepth: 2 },
      capabilities: { platform: "H100" },
      timestamp: new Date().toISOString(),
    };
    const res = await fetch(`${baseUrl}/api/gossip/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(signGossipPayload(payload)),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("peerId", "test-server");
    expect(data).toHaveProperty("frontier");
    expect(data).toHaveProperty("load");
    expect(data).toHaveProperty("capabilities");
    expect(data).toHaveProperty("timestamp");
  });

  it("returns 400 for invalid body", async () => {
    const res = await fetch(`${baseUrl}/api/gossip/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  it("preserves signed protocol fields before handing exchange to the service", async () => {
    const capture = new CapturingGossipService();
    const app = appWithGossip(capture);

    const payload = {
      peerId: "incoming-peer",
      address: "http://incoming-peer:4515",
      frontier: [
        {
          metric: "loss",
          value: 0.03,
          cid: "blake3:abc123",
          tags: ["eval"],
          direction: "minimize",
        },
      ],
      load: { queueDepth: 2 },
      capabilities: { platform: "H100" },
      timestamp: new Date().toISOString(),
      agentCapacity: { totalSlots: 4, usedSlots: 2, freeSlots: 2 },
    };
    const signedPayload = signGossipPayload(payload);

    const res = await app.request("/api/gossip/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedPayload),
    });

    expect(res.status).toBe(200);
    expect(capture.lastExchange?.hmacSignature).toBe(signedPayload.hmacSignature);
    expect(capture.lastExchange?.agentCapacity?.freeSlots).toBe(2);
    expect(capture.lastExchange?.frontier[0]?.direction).toBe("minimize");
  });

  it("accepts a signed HMAC exchange after route validation", async () => {
    const secret = "shared-secret";
    const targetStore = new InMemoryContributionStore();
    const targetService = new DefaultGossipService({
      config: {
        peerId: "target-server",
        address: "http://target:4515",
        seedPeers: [],
        hmacSecret: secret,
      },
      transport: new NoOpTransport(),
      frontier: new DefaultFrontierCalculator(targetStore),
    });
    const remoteService = new DefaultGossipService({
      config: {
        peerId: "remote-server",
        address: "http://remote:4515",
        seedPeers: [],
        hmacSecret: secret,
      },
      transport: new NoOpTransport(),
      frontier: new DefaultFrontierCalculator(new InMemoryContributionStore()),
    });
    const app = appWithGossip(targetService, secret);
    const signedMessage = await remoteService.currentMessage();

    const res = await app.request("/api/gossip/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedMessage),
    });

    expect(res.status).toBe(200);
    expect(targetService.peers().map((p) => p.peerId)).toContain("remote-server");
  });

  it("preserves minimize direction when merging frontier digests through the route", async () => {
    const service = new DefaultGossipService({
      config: {
        peerId: "target-server",
        address: "http://target:4515",
        seedPeers: [],
        hmacSecret: TEST_HMAC_SECRET,
      },
      transport: new NoOpTransport(),
      frontier: new DefaultFrontierCalculator(new InMemoryContributionStore()),
    });
    const app = appWithGossip(service);
    const cid = "blake3:same";

    for (const value of [0.03, 0.05]) {
      const res = await app.request("/api/gossip/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          signGossipPayload({
            peerId: "incoming-peer",
            address: "http://incoming-peer:4515",
            frontier: [{ metric: "loss", value, cid, direction: "minimize" }],
            load: { queueDepth: 0 },
            capabilities: {},
            timestamp: new Date().toISOString(),
          }),
        ),
      });
      expect(res.status).toBe(200);
    }

    const frontierRes = await app.request("/api/gossip/frontier", { headers: TEST_AUTH_HEADERS });
    expect(frontierRes.status).toBe(200);
    const data = (await frontierRes.json()) as {
      entries: readonly { metric: string; cid: string; value: number; direction?: string }[];
    };
    expect(data.entries).toContainEqual({
      metric: "loss",
      cid,
      value: 0.03,
      direction: "minimize",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: gossip shuffle
// ---------------------------------------------------------------------------

describe("POST /api/gossip/shuffle", () => {
  it("returns 200 with shuffle response", async () => {
    const payload = {
      sender: {
        peerId: "shuffle-peer",
        address: "http://shuffle-peer:4515",
        age: 0,
        lastSeen: new Date().toISOString(),
      },
      offered: [
        {
          peerId: "offered-peer",
          address: "http://offered-peer:4515",
          age: 1,
          lastSeen: new Date().toISOString(),
        },
      ],
    };
    const res = await fetch(`${baseUrl}/api/gossip/shuffle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(signGossipPayload(payload)),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("offered");
    expect(Array.isArray((data as { offered: unknown[] }).offered)).toBe(true);
  });

  it("returns 400 for missing sender", async () => {
    const res = await fetch(`${baseUrl}/api/gossip/shuffle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ offered: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("preserves HMAC signatures before handing shuffle to the service", async () => {
    const capture = new CapturingGossipService();
    const app = appWithGossip(capture);

    const payload = {
      sender: {
        peerId: "shuffle-peer",
        address: "http://shuffle-peer:4515",
        age: 0,
        lastSeen: new Date().toISOString(),
      },
      offered: [],
    };
    const signedPayload = signGossipPayload(payload);

    const res = await app.request("/api/gossip/shuffle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedPayload),
    });

    expect(res.status).toBe(200);
    expect(capture.lastShuffle?.hmacSignature).toBe(signedPayload.hmacSignature);
  });
});

// ---------------------------------------------------------------------------
// Tests: gossip peers
// ---------------------------------------------------------------------------

describe("GET /api/gossip/peers", () => {
  it("returns peers and liveness", async () => {
    const res = await fetch(`${baseUrl}/api/gossip/peers`, { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("peers");
    expect(data).toHaveProperty("liveness");
    expect(Array.isArray((data as { peers: unknown[] }).peers)).toBe(true);
    expect(Array.isArray((data as { liveness: unknown[] }).liveness)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: gossip frontier
// ---------------------------------------------------------------------------

describe("GET /api/gossip/frontier", () => {
  it("returns merged frontier entries", async () => {
    const res = await fetch(`${baseUrl}/api/gossip/frontier`, { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("entries");
    expect(Array.isArray((data as { entries: unknown[] }).entries)).toBe(true);
  });
});
