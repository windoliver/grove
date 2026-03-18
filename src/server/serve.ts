/**
 * Grove HTTP server entry point.
 *
 * Creates stores from environment/flags and starts Bun.serve().
 * Optionally enables gossip federation when GOSSIP_SEEDS is set.
 *
 * This is the only file excluded from test coverage — use createApp() for testing.
 */

import { join } from "node:path";
import type { GossipService } from "../core/gossip/types.js";
import { HttpGossipTransport } from "../gossip/http-transport.js";
import { DefaultGossipService } from "../gossip/protocol.js";
import { createLocalRuntime } from "../local/runtime.js";
import { parseGossipSeeds, parsePort } from "../shared/env.js";
import { createApp } from "./app.js";
import type { ServerDeps } from "./deps.js";

const GROVE_DIR = process.env.GROVE_DIR ?? join(process.cwd(), ".grove");
const PORT = parsePort(process.env.PORT, 4515);
const HOST = process.env.HOST; // optional — defaults to localhost via Bun

const runtime = createLocalRuntime({
  groveDir: GROVE_DIR,
  workspace: false, // server doesn't need workspace manager
  parseContract: true, // parse topology from GROVE.md
});

// ---------------------------------------------------------------------------
// Optional gossip federation
// ---------------------------------------------------------------------------

let gossipService: GossipService | undefined;

const gossipSeedsRaw = process.env.GOSSIP_SEEDS; // comma-separated "id@address" pairs
const peerId = process.env.GOSSIP_PEER_ID ?? `grove-${PORT}`;
const peerAddress = process.env.GOSSIP_ADDRESS ?? `http://localhost:${PORT}`;

const seedPeers = parseGossipSeeds(gossipSeedsRaw);
if (seedPeers.length > 0) {
  const allowPrivateIPs = process.env.GROVE_GOSSIP_ALLOW_PRIVATE_IPS === "true";
  const hmacSecret = process.env.GROVE_GOSSIP_HMAC_SECRET || undefined;
  const transport = new HttpGossipTransport({ allowPrivateIPs });
  gossipService = new DefaultGossipService({
    config: { peerId, address: peerAddress, seedPeers: [...seedPeers], hmacSecret },
    transport,
    frontier: runtime.frontier,
    getLoad: () => ({ queueDepth: 0 }),
  });
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const deps: ServerDeps = {
  contributionStore: runtime.contributionStore,
  claimStore: runtime.claimStore,
  outcomeStore: runtime.outcomeStore,
  bountyStore: runtime.bountyStore,
  goalSessionStore: runtime.goalSessionStore,
  cas: runtime.cas,
  frontier: runtime.frontier,
  gossip: gossipService,
  topology: runtime.contract?.topology,
};

const app = createApp(deps);

const server = Bun.serve({
  port: PORT,
  ...(HOST ? { hostname: HOST } : {}),
  fetch: app.fetch,
});

// Warn when bound to a non-localhost address (no auth is enforced).
const LOCALHOST_ADDRESSES = new Set(["localhost", "127.0.0.1", "::1"]);
if (HOST && !LOCALHOST_ADDRESSES.has(HOST)) {
  console.warn(
    "\u26a0 Server bound to non-localhost address without authentication. See security docs for securing.",
  );
}

// Start gossip after server is listening
if (gossipService) {
  gossipService.start();
  console.log(`gossip enabled: peerId=${peerId}, seeds=${gossipSeedsRaw}`);
}

console.log(`grove-server listening on http://${HOST ?? "localhost"}:${server.port}`);

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  if (gossipService) {
    await gossipService.stop();
  }
  server.stop();
  runtime.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
