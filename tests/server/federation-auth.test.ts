/**
 * Auth-exemption tests for the namespace-auth middleware as configured by
 * createApp() (#226).
 *
 * Covers:
 *   - GET /api/cas/blake3:<hex>          — exempt when gossip is configured.
 *   - GET /api/cas/blake3:<hex>          — bearer-required when gossip is NOT
 *     configured.
 *   - POST /api/gossip/fetch/:cid        — bearer-required even when gossip IS
 *     configured (it is a local trigger, not a peer-to-peer endpoint).
 *   - POST /api/gossip/fetch/:cid        — reaches the route handler when a
 *     valid bearer token is supplied.
 */

import { describe, expect, it } from "bun:test";
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
import { createApp } from "../../src/server/app.js";
import type { ServerDeps } from "../../src/server/deps.js";
import {
  InMemoryClaimStore,
  InMemoryContentStore,
  TEST_AUTH_HEADERS,
  TEST_NAMESPACE_KEY,
} from "../../src/server/test-helpers.js";

const TEST_REGISTRY = new Map([[TEST_NAMESPACE_KEY, "test-project/main"]]);
const TEST_HMAC_SECRET = "test-hmac-secret-for-federation-auth";
const SAMPLE_CID = `blake3:${"a".repeat(64)}`;

// ---------------------------------------------------------------------------
// Stub GossipService — never actually called by these tests, but lets createApp
// take the "gossip is configured" branch and the route handler short-circuit
// to a deterministic response.
// ---------------------------------------------------------------------------

class NoOpTransport implements GossipTransport {
  async exchange(_peer: PeerInfo, _message: GossipMessage): Promise<GossipMessage> {
    return {
      peerId: "stub",
      frontier: [],
      load: { queueDepth: 0 },
      capabilities: {},
      timestamp: new Date().toISOString(),
    };
  }
  async shuffle(_peer: PeerInfo, _request: ShuffleRequest): Promise<ShuffleResponse> {
    return { offered: [] };
  }
  async fetchContribution(_peer: PeerInfo, _cid: string): Promise<unknown | undefined> {
    return undefined;
  }
  async fetchArtifact(_peer: PeerInfo, _contentHash: string): Promise<Uint8Array | undefined> {
    return undefined;
  }
}

class StubGossipService implements GossipService {
  start(): void {
    /* expected */
  }
  async stop(): Promise<void> {
    /* expected */
  }
  async handleExchange(_message: GossipMessage): Promise<GossipMessage> {
    return this.currentMessage();
  }
  handleShuffle(_request: ShuffleRequest): ShuffleResponse {
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
      peerId: "stub",
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
  // Used by gossip.post("/fetch/:cid"). Returning "no-source" lets the route
  // handler emit a deterministic 404 without touching the network, so the auth
  // test only asserts the middleware decision (request reached handler).
  async fetchRemoteContribution(
    cid: string,
  ): Promise<{ kind: "no-source"; cid: string }> {
    return { kind: "no-source", cid };
  }
}

function appWithGossip(): ReturnType<typeof createApp> {
  const deps: ServerDeps = {
    contributionStore: new InMemoryContributionStore(),
    claimStore: new InMemoryClaimStore(),
    cas: new InMemoryContentStore(),
    frontier: new DefaultFrontierCalculator(new InMemoryContributionStore()),
    gossip: new StubGossipService() as unknown as GossipService,
    gossipHmacSecret: TEST_HMAC_SECRET,
    watchHub: new WatchHub(),
  };
  return createApp(deps, TEST_REGISTRY);
}

function appWithoutGossip(): ReturnType<typeof createApp> {
  const deps: ServerDeps = {
    contributionStore: new InMemoryContributionStore(),
    claimStore: new InMemoryClaimStore(),
    cas: new InMemoryContentStore(),
    frontier: new DefaultFrontierCalculator(new InMemoryContributionStore()),
    watchHub: new WatchHub(),
  };
  return createApp(deps, TEST_REGISTRY);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("federation auth exemptions (#226)", () => {
  it("GET /api/cas/:hash with NO auth succeeds when gossip is configured", async () => {
    const app = appWithGossip();
    const res = await app.request(`/api/cas/${SAMPLE_CID}`);
    // Exempt path → middleware lets it through. CAS is empty, so the handler
    // returns 404. Any non-{400,401} status proves auth was bypassed.
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("GET /api/cas/:hash with NO auth fails when gossip is NOT configured", async () => {
    const app = appWithoutGossip();
    const res = await app.request(`/api/cas/${SAMPLE_CID}`);
    // Without gossip, no exemption applies — bearer auth is required.
    expect([400, 401]).toContain(res.status);
  });

  it("POST /api/gossip/fetch/:cid with NO auth fails even when gossip IS configured", async () => {
    const app = appWithGossip();
    const res = await app.request(`/api/gossip/fetch/${encodeURIComponent(SAMPLE_CID)}`, {
      method: "POST",
    });
    // This is the new behavior — local trigger must stay bearer-protected.
    expect([400, 401]).toContain(res.status);
  });

  it("POST /api/gossip/fetch/:cid WITH bearer reaches the route handler", async () => {
    const app = appWithGossip();
    const res = await app.request(`/api/gossip/fetch/${encodeURIComponent(SAMPLE_CID)}`, {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
    });
    // Stub returns "no-source" → handler responds 404. Important point: the
    // response is from the route handler, not the auth middleware.
    expect(res.status).toBe(404);
    const data = (await res.json()) as { kind?: string; cid?: string };
    expect(data.kind).toBe("no-source");
    expect(data.cid).toBe(SAMPLE_CID);
  });
});
