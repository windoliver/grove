/**
 * Grove HTTP server entry point.
 *
 * Creates stores from environment/flags and starts Bun.serve().
 * Optionally enables gossip federation when GOSSIP_SEEDS is set.
 *
 * This is the only file excluded from test coverage — use createApp() for testing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseGroveContract } from "../core/contract.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import type { GossipService } from "../core/gossip/types.js";
import type { AgentTopology } from "../core/topology.js";
import { CachedFrontierCalculator } from "../gossip/cached-frontier.js";
import { HttpGossipTransport } from "../gossip/http-transport.js";
import { DefaultGossipService } from "../gossip/protocol.js";
import { FsCas } from "../local/fs-cas.js";
import { createSqliteStores } from "../local/sqlite-store.js";
import { createApp } from "./app.js";
import type { ServerDeps } from "./deps.js";

const GROVE_DIR = process.env.GROVE_DIR ?? join(process.cwd(), ".grove");
const PORT = Number(process.env.PORT ?? 4515);
const HOST = process.env.HOST; // optional — defaults to localhost via Bun

const dbPath = join(GROVE_DIR, "grove.db");
const casDir = join(GROVE_DIR, "cas");

const stores = createSqliteStores(dbPath);
const cas = new FsCas(casDir);
const rawFrontier = new DefaultFrontierCalculator(stores.contributionStore);
const frontier = new CachedFrontierCalculator(rawFrontier);

// ---------------------------------------------------------------------------
// Optional gossip federation
// ---------------------------------------------------------------------------

let gossipService: GossipService | undefined;

const gossipSeeds = process.env.GOSSIP_SEEDS; // comma-separated "id@address" pairs
const peerId = process.env.GOSSIP_PEER_ID ?? `grove-${PORT}`;
const peerAddress = process.env.GOSSIP_ADDRESS ?? `http://localhost:${PORT}`;

if (gossipSeeds) {
  const seedPeers = gossipSeeds.split(",").map((seed) => {
    const [id, address] = seed.trim().split("@");
    if (!id || !address) {
      throw new Error(`Invalid GOSSIP_SEEDS entry: "${seed}". Expected format: "id@address".`);
    }
    return { peerId: id, address, age: 0, lastSeen: new Date().toISOString() };
  });

  const transport = new HttpGossipTransport();
  gossipService = new DefaultGossipService({
    config: { peerId, address: peerAddress, seedPeers },
    transport,
    frontier,
    getLoad: () => ({ queueDepth: 0 }),
  });
}

// ---------------------------------------------------------------------------
// Optional agent topology from GROVE.md contract
// ---------------------------------------------------------------------------

let topology: AgentTopology | undefined;
try {
  const grovemdPath = join(GROVE_DIR, "..", "GROVE.md");
  if (existsSync(grovemdPath)) {
    const raw = await Bun.file(grovemdPath).text();
    const contract = parseGroveContract(raw);
    topology = contract.topology;
  }
} catch {
  // Topology is optional
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const deps: ServerDeps = {
  contributionStore: stores.contributionStore,
  claimStore: stores.claimStore,
  outcomeStore: stores.outcomeStore,
  bountyStore: stores.bountyStore,
  cas,
  frontier,
  gossip: gossipService,
  topology,
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
  console.log(`gossip enabled: peerId=${peerId}, seeds=${gossipSeeds}`);
}

console.log(`grove-server listening on http://${HOST ?? "localhost"}:${server.port}`);

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  if (gossipService) {
    await gossipService.stop();
  }
  server.stop();
  stores.close();
  cas.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
