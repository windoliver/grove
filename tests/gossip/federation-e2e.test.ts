/**
 * Two-server gossip federation end-to-end test.
 *
 * Stands up two in-process grove-servers (A and B) on real Bun.serve ports,
 * places a contribution + artifact only on server A, runs a single gossip
 * round on server B (so it pulls A's frontier digest), then asks B to
 * `POST /api/gossip/fetch/:cid`. Verifies that B ends up with both the
 * contribution manifest and the artifact bytes — proving the full
 * federation path: advertisement tracking → frontier merge →
 * peersAdvertising → fetchContribution → fetchArtifact → BLAKE3 verify →
 * local persistence.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hash as blake3Hash } from "blake3";

import { DefaultFrontierCalculator } from "../../src/core/frontier.js";
import { createContribution } from "../../src/core/manifest.js";
import { InMemoryContributionStore } from "../../src/core/testing.js";
import { WatchHub } from "../../src/core/watch-hub.js";
import { HttpGossipTransport } from "../../src/gossip/http-transport.js";
import { DefaultGossipService } from "../../src/gossip/protocol.js";
import { createApp } from "../../src/server/app.js";
import type { ServerDeps } from "../../src/server/deps.js";
import {
  InMemoryClaimStore,
  InMemoryContentStore,
  TEST_AUTH_HEADERS,
  TEST_NAMESPACE_KEY,
} from "../../src/server/test-helpers.js";

const TEST_REGISTRY = new Map([[TEST_NAMESPACE_KEY, "test-project/main"]]);
const TEST_HMAC_SECRET = "test-hmac-secret-for-federation-e2e";

function blake3Of(bytes: Uint8Array): string {
  return `blake3:${blake3Hash(bytes).toString("hex")}`;
}

interface ServerHandle {
  url: string;
  deps: ServerDeps;
  gossipService: DefaultGossipService;
  stop: () => Promise<void>;
}

/**
 * Start a full grove-server with its own gossip service.
 *
 * We follow a two-phase setup: start the HTTP listener first to learn the
 * port (Bun.serve port:0 allocates immediately), then construct the
 * GossipService with the real address. The `deps` object is mutated after
 * createApp() so route handlers — which read deps via `c.get("deps")` at
 * request time — pick up the live gossip service. The `app.use("/api/*")`
 * auth-exempt closure also evaluates `deps.gossip !== undefined` per
 * request, so installing gossip post-construction is safe.
 */
async function startServer(opts: {
  peerId: string;
  seedPeers: { peerId: string; address: string }[];
}): Promise<ServerHandle> {
  const contributionStore = new InMemoryContributionStore();
  const claimStore = new InMemoryClaimStore();
  const cas = new InMemoryContentStore();
  const frontier = new DefaultFrontierCalculator(contributionStore);
  const watchHub = new WatchHub();

  // Mutable deps holder so we can install gossip after we know our port.
  // Cast away `readonly` only at this construction site; route handlers
  // continue to treat ServerDeps as readonly.
  const deps: ServerDeps = {
    contributionStore,
    claimStore,
    cas,
    frontier,
    watchHub,
    gossipHmacSecret: TEST_HMAC_SECRET,
  };
  const app = createApp(deps, TEST_REGISTRY);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const url = `http://localhost:${server.port}`;

  // Now that we have the real address, build the gossip service and install it.
  const transport = new HttpGossipTransport({
    allowPrivateIPs: true,
    hmacSecret: TEST_HMAC_SECRET,
  });
  const gossipService = new DefaultGossipService({
    config: {
      peerId: opts.peerId,
      address: url,
      seedPeers: opts.seedPeers.map((p) => ({
        peerId: p.peerId,
        address: p.address,
        age: 0,
        lastSeen: new Date().toISOString(),
      })),
      hmacSecret: TEST_HMAC_SECRET,
    },
    transport,
    frontier,
    contributionStore,
    cas,
  });

  // Install gossip post-construction. readonly is compile-only; the auth
  // middleware closure re-reads deps.gossip on every request.
  (deps as { gossip?: DefaultGossipService }).gossip = gossipService;

  return {
    url,
    deps,
    gossipService,
    stop: async () => {
      await gossipService.stop();
      server.stop(true);
    },
  };
}

describe("gossip federation e2e", () => {
  let serverA: ServerHandle;
  let serverB: ServerHandle;

  beforeAll(async () => {
    serverA = await startServer({ peerId: "A", seedPeers: [] });
    serverB = await startServer({
      peerId: "B",
      seedPeers: [{ peerId: "A", address: serverA.url }],
    });
  });

  afterAll(async () => {
    await serverB.stop();
    await serverA.stop();
  });

  it("server B fetches a contribution + artifact that only server A holds", async () => {
    // 1. Place a contribution + artifact on server A only.
    const bytes = new Uint8Array([10, 20, 30]);
    const artifactHash = blake3Of(bytes);
    await serverA.deps.cas.put(bytes);

    const contribution = createContribution({
      kind: "work",
      mode: "evaluation",
      summary: "hello from A",
      artifacts: { payload: artifactHash },
      relations: [],
      tags: [],
      agent: {
        agentId: "agent-A",
        agentName: "agent-A",
        provider: "test",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const cid = contribution.cid;
    await serverA.deps.contributionStore.put(contribution);

    // 2. Force a single gossip round on B so it pulls A's frontier digest
    //    over real HTTP. After the round, B's advertisement map should know
    //    A advertises `cid`.
    await serverB.gossipService.runRound();

    // 3. Ask B to fetch the cid on demand.
    const res = await fetch(`${serverB.url}/api/gossip/fetch/${encodeURIComponent(cid)}`, {
      method: "POST",
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { kind: string; cid: string };
    expect(result.kind).toBe("ok");
    expect(result.cid).toBe(cid);

    // 4. Both the manifest and the artifact bytes should now exist locally on B.
    const localContribution = await serverB.deps.contributionStore.get(cid);
    expect(localContribution).toBeDefined();
    expect(localContribution?.cid).toBe(cid);
    expect(await serverB.deps.cas.exists(artifactHash)).toBe(true);
  });
});
