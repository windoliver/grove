/**
 * Grove HTTP server entry point.
 *
 * Creates stores from environment/flags and starts Bun.serve().
 * Optionally enables gossip federation when GOSSIP_SEEDS is set.
 * Optionally enables WebSocket push via SessionService when a contract
 * with topology is available and GROVE_AGENT_RUNTIME is set.
 *
 * This is the only file excluded from test coverage — use createApp() for testing.
 */

import { join } from "node:path";
import type { GossipService } from "../core/gossip/types.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { TmuxRuntime } from "../core/tmux-runtime.js";
import { HttpGossipTransport } from "../gossip/http-transport.js";
import { DefaultGossipService } from "../gossip/protocol.js";
import { createLocalRuntime } from "../local/runtime.js";
import { parseGossipSeeds, parsePort } from "../shared/env.js";
import { createApp } from "./app.js";
import type { ServerDeps } from "./deps.js";
import { SessionService } from "./session-service.js";
import { createWsHandler } from "./ws-handler.js";

const GROVE_DIR = process.env.GROVE_DIR ?? join(process.cwd(), ".grove");
const PORT = parsePort(process.env.PORT, 4515);
const HOST = process.env.HOST; // optional — defaults to localhost via Bun
// Nexus env vars — available for IPC routing but NOT for data stores.
// Data stores use local SQLite to avoid Nexus VFS rate limits.

// Local runtime for contract parsing, workspace, frontier, goal sessions.
// Contribution stores are overridden with Nexus when available.
const runtime = createLocalRuntime({
  groveDir: GROVE_DIR,
  workspace: false,
  parseContract: true,
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

// Use Nexus stores when URL is available (single source of truth).
// Fall back to local SQLite when Nexus is not configured.
const serverContributionStore: import("../core/store.js").ContributionStore =
  runtime.contributionStore;
const serverClaimStore: import("../core/store.js").ClaimStore = runtime.claimStore;
const serverOutcomeStore: import("../core/outcome.js").OutcomeStore | undefined =
  runtime.outcomeStore;
const serverBountyStore: import("../core/bounty-store.js").BountyStore = runtime.bountyStore;
const serverCas: import("../core/cas.js").ContentStore = runtime.cas;
const serverFrontier: import("../core/frontier.js").FrontierCalculator = runtime.frontier;

// Server uses local SQLite for reads (same DB as MCP agents write to).
// Nexus VFS hits rate limits with N reads per list() call.
// Nexus is used for IPC only (via NexusWsBridge SSE), not for data storage.

const deps: ServerDeps = {
  contributionStore: serverContributionStore,
  claimStore: serverClaimStore,
  outcomeStore: serverOutcomeStore,
  bountyStore: serverBountyStore,
  goalSessionStore: runtime.goalSessionStore,
  cas: serverCas,
  frontier: serverFrontier,
  gossip: gossipService,
  topology: runtime.contract?.topology,
};

const app = createApp(deps);

// ---------------------------------------------------------------------------
// Optional SessionService + WebSocket push
// ---------------------------------------------------------------------------

let sessionService: SessionService | undefined;
let wsHandler: ReturnType<typeof createWsHandler> | undefined;

if (runtime.contract?.topology !== undefined) {
  // Create an agent runtime — prefer acpx, fall back to tmux
  let agentRuntime: import("../core/agent-runtime.js").AgentRuntime;
  {
    const { AcpxRuntime } = await import("../core/acpx-runtime.js");
    const acpx = new AcpxRuntime();
    if (await acpx.isAvailable()) {
      agentRuntime = acpx;
    } else {
      agentRuntime = new TmuxRuntime();
    }
  }

  const eventBus = new LocalEventBus();

  sessionService = new SessionService({
    contract: runtime.contract,
    runtime: agentRuntime,
    eventBus,
    projectRoot: runtime.groveRoot,
    workspaceBaseDir: join(GROVE_DIR, "workspaces"),
  });

  wsHandler = createWsHandler(sessionService);
  console.log("session-service enabled (topology found in contract)");
}

// ---------------------------------------------------------------------------
// Start server (with optional WebSocket upgrade)
// ---------------------------------------------------------------------------

function startServer() {
  const hostnameOpts = HOST ? { hostname: HOST } : {};

  if (wsHandler !== undefined) {
    const wsh = wsHandler;
    return Bun.serve({
      port: PORT,
      ...hostnameOpts,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const upgraded = server.upgrade(req);
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return app.fetch(req);
      },
      websocket: {
        open(ws) {
          wsh.open(ws as unknown as import("./ws-handler.js").WsSocket);
        },
        message(ws, message) {
          wsh.message(
            ws as unknown as import("./ws-handler.js").WsSocket,
            typeof message === "string" ? message : new TextDecoder().decode(message),
          );
        },
        close(ws) {
          wsh.close(ws as unknown as import("./ws-handler.js").WsSocket);
        },
      },
    });
  }

  return Bun.serve({
    port: PORT,
    ...hostnameOpts,
    fetch: app.fetch,
  });
}

const server = startServer();

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
  if (sessionService) {
    sessionService.destroy();
  }
  if (gossipService) {
    await gossipService.stop();
  }
  server.stop();
  runtime.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
