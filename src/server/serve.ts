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
// Nexus env vars — when GROVE_NEXUS_URL is set, contribution/claim/bounty/
// outcome/CAS reads and writes go through Nexus stores so this process sees
// the same data MCP agents produce. See the store-construction block below.

// Local runtime for contract parsing, workspace, frontier, goal sessions.
// Contribution stores are overridden with Nexus when available.
const runtime = createLocalRuntime({
  groveDir: GROVE_DIR,
  workspace: false,
  parseContract: true,
});

if (!runtime.contract) {
  console.log("no GROVE.md found — sessions must provide a preset or a loaded contract");
}

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

// When GROVE_NEXUS_URL is set, agents write through the MCP server to Nexus
// stores (see src/mcp/serve.ts). If the HTTP server kept reading local SQLite
// in that mode, /api/contributions would return [] and reviewers polling the
// HTTP API would never see the coder's submitted CID — blocking the
// review-loop handoff chain. Mirror the MCP pattern: same Nexus stores, same
// fail-closed semantics when health is unreachable.
let serverContributionStore: import("../core/store.js").ContributionStore =
  runtime.contributionStore;
let serverClaimStore: import("../core/store.js").ClaimStore = runtime.claimStore;
let serverOutcomeStore: import("../core/outcome.js").OutcomeStore | undefined =
  runtime.outcomeStore;
let serverBountyStore: import("../core/bounty-store.js").BountyStore = runtime.bountyStore;
let serverCas: import("../core/cas.js").ContentStore = runtime.cas;
const serverFrontier: import("../core/frontier.js").FrontierCalculator = runtime.frontier;

// In Nexus mode, contributions are stored at session-scoped VFS paths
// (/zones/{zoneId}/sessions/{sessionId}/contributions/). A process-global
// NexusContributionStore built with sessionId=undefined queries the zone-wide
// FTS index and never sees per-session writes, so /api/contributions?sessionId=
// returns []. The factory below builds a scoped store per request; routes use
// it when the query param is present.
let contributionStoreForSessionFactory:
  | ((sessionId: string) => import("../core/store.js").ContributionStore)
  | undefined;

const nexusUrl = process.env.GROVE_NEXUS_URL;
const nexusApiKey = process.env.NEXUS_API_KEY;
const zoneId = process.env.GROVE_ZONE_ID ?? "default";
if (nexusUrl) {
  const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
  const { NexusContributionStore } = await import("../nexus/nexus-contribution-store.js");
  const { NexusClaimStore } = await import("../nexus/nexus-claim-store.js");
  const { NexusBountyStore } = await import("../nexus/nexus-bounty-store.js");
  const { NexusOutcomeStore } = await import("../nexus/nexus-outcome-store.js");
  const { NexusCas } = await import("../nexus/nexus-cas.js");

  const nexusClient = new NexusHttpClient({
    url: nexusUrl,
    ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
  });

  // Retry health check — during `grove up` Nexus may briefly be unavailable.
  // Matches the MCP server's retry window so both processes either come up
  // together or fail together.
  let health = false;
  for (let attempt = 1; attempt <= 5 && !health; attempt++) {
    health = await Promise.race([
      fetch(`${nexusUrl}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]).catch(() => false);
    if (!health && attempt < 5) {
      console.error(
        `grove-server: Nexus health attempt ${attempt}/5 failed — retrying in ${attempt}s`,
      );
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }

  if (!health) {
    // Fail closed for the same reason as the MCP server: a silent fallback to
    // local SQLite would split reads from the Nexus writes that MCP agents
    // already performed, leaving /api/contributions empty and deadlocking any
    // reviewer that polls the HTTP surface for the coder's CID.
    console.error(
      `grove-server: FATAL: GROVE_NEXUS_URL=${nexusUrl} is set but health check failed. ` +
        `Refusing to fall back to local stores — that would silently bypass Nexus ` +
        `routing and leave contributions invisible to /api/contributions readers.`,
    );
    process.exit(1);
  }

  serverContributionStore = new NexusContributionStore({ client: nexusClient, zoneId });
  serverClaimStore = new NexusClaimStore({ client: nexusClient, zoneId });
  serverBountyStore = new NexusBountyStore({ client: nexusClient, zoneId });
  serverOutcomeStore = new NexusOutcomeStore({ client: nexusClient, zoneId });
  serverCas = new NexusCas({ client: nexusClient, zoneId });
  contributionStoreForSessionFactory = (sessionId: string) =>
    new NexusContributionStore({ client: nexusClient, zoneId, sessionId });
  console.log(`grove-server: using Nexus stores at ${nexusUrl} (zone=${zoneId})`);
}

// Per-request session-scoped handoff store factory. The HTTP handoff
// routes accept ?sessionId= and use this factory to build a scoped
// SqliteHandoffStore on demand, preventing cross-session reads/mutations
// from remote TUIs that share the same process-global runtime.
const { SqliteHandoffStore: _SqliteHandoffStore } = await import(
  "../local/sqlite-handoff-store.js"
);
const handoffStoreForSession = (sessionId: string) =>
  new _SqliteHandoffStore(runtime.db, sessionId) as import("../core/handoff.js").HandoffStore;

const deps: ServerDeps = {
  contributionStore: serverContributionStore,
  contributionStoreForSession: contributionStoreForSessionFactory,
  claimStore: serverClaimStore,
  outcomeStore: serverOutcomeStore,
  bountyStore: serverBountyStore,
  goalSessionStore: runtime.goalSessionStore,
  handoffStore: runtime.handoffStore,
  handoffStoreForSession,
  cas: serverCas,
  frontier: serverFrontier,
  gossip: gossipService,
  topology: runtime.contract?.topology,
  contract: runtime.contract,
  idempotencyStore: runtime.idempotencyStore,
};

const app = createApp(deps);

// ---------------------------------------------------------------------------
// Background sweep reconciler
// ---------------------------------------------------------------------------

import { BountyIndexSweep } from "../core/bounty-index-sweep.js";
import { SettlementSweep } from "../core/settlement-sweep.js";
import { SweepReconciler } from "../core/sweep-reconciler.js";

let sweepReconciler: SweepReconciler | undefined;
if (serverBountyStore) {
  sweepReconciler = new SweepReconciler({
    intervalMs: 60_000,
    onCycle(results) {
      for (const r of results) {
        if (r.found > 0 || r.errors.length > 0) {
          console.log(
            `[sweep] ${r.strategy}: found=${r.found} repaired=${r.repaired} errors=${r.errors.length}`,
          );
        }
      }
    },
  });
  sweepReconciler.register(new BountyIndexSweep(serverBountyStore));
  // SettlementSweep runs without creditsService — it can recover non-escrowed
  // bounties. Escrowed bounties (those with reservationId) will log an error
  // and wait for a CreditsService to be available. When a production
  // CreditsService is wired in, pass it: new SettlementSweep(store, credits).
  sweepReconciler.register(new SettlementSweep(serverBountyStore));
  sweepReconciler.start();
  console.log("sweep-reconciler started (BountyIndexSweep, SettlementSweep)");
}

// ---------------------------------------------------------------------------
// Optional SessionService + WebSocket push
// ---------------------------------------------------------------------------

let sessionService: SessionService | undefined;
let wsHandler: ReturnType<typeof createWsHandler> | undefined;

if (runtime.contract?.topology !== undefined) {
  // Create an agent runtime via selectRuntime (honors GROVE_RUNTIME env),
  // fall back to tmux when neither acp nor acpx is available
  let agentRuntime: import("../core/agent-runtime.js").AgentRuntime;
  {
    const { selectRuntime } = await import("../core/select-runtime.js");
    const picked = selectRuntime();
    if (await picked.isAvailable()) {
      agentRuntime = picked;
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

// Refuse to bind a non-localhost address without an explicit operator
// opt-in. The HTTP surface has no authentication (role-sensitive mutations
// are gated to MCP stdio, but read routes and `?sessionId=` scoping are
// caller-asserted), so the deployment trust boundary is the localhost
// binding. Operators who want remote access MUST set
// `GROVE_ALLOW_UNAUTHENTICATED_REMOTE=true` to acknowledge the risk;
// typical production usage places the server behind an authenticated
// reverse proxy.
//
// MUST run BEFORE Bun.serve() — otherwise the socket would already be
// bound and listening before we decided to exit.
const LOCALHOST_ADDRESSES = new Set(["localhost", "127.0.0.1", "::1"]);
if (HOST && !LOCALHOST_ADDRESSES.has(HOST)) {
  if (process.env.GROVE_ALLOW_UNAUTHENTICATED_REMOTE !== "true") {
    console.error(
      "\u26a0 Refusing to bind non-localhost address without authentication.\n" +
        "  Set GROVE_ALLOW_UNAUTHENTICATED_REMOTE=true to opt in explicitly,\n" +
        "  or front this process with an authenticated reverse proxy and bind to localhost.",
    );
    process.exit(1);
  }
  console.warn(
    "\u26a0 Server bound to non-localhost address without authentication (GROVE_ALLOW_UNAUTHENTICATED_REMOTE=true).",
  );
}

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

// Start gossip after server is listening
if (gossipService) {
  gossipService.start();
  console.log(`gossip enabled: peerId=${peerId}, seeds=${gossipSeedsRaw}`);
}

console.log(`grove-server listening on http://${HOST ?? "localhost"}:${server.port}`);

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  if (sweepReconciler) {
    sweepReconciler.stop();
  }
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
