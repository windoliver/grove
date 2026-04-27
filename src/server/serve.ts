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
import { readProjectId } from "../core/project-id.js";
import {
  appendServerKey,
  detectWorktreeName,
  readClientKey,
  readNamespace,
  writeClientKey,
  writeNamespace,
} from "../core/project-key.js";
import { TmuxRuntime } from "../core/tmux-runtime.js";
import { HttpGossipTransport } from "../gossip/http-transport.js";
import { DefaultGossipService } from "../gossip/protocol.js";
import { createLocalRuntime } from "../local/runtime.js";
import { parseGossipSeeds, parsePort } from "../shared/env.js";
import { createApp } from "./app.js";
import type { ServerDeps } from "./deps.js";
import { loadKeyRegistry } from "./middleware/namespace-auth.js";
import { SessionService } from "./session-service.js";
import { memoizeContributionStoreForSession } from "./session-store-factory.js";
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
const gossipHmacSecret = process.env.GROVE_GOSSIP_HMAC_SECRET || undefined;

// Gossip routes bypass namespace auth (peers have different namespaces), so HMAC
// is the only protection. Require it when gossip is actually configured.
if (seedPeers.length > 0 && !gossipHmacSecret) {
  console.error(
    "grove-server: FATAL: GOSSIP_SEEDS is set without GROVE_GOSSIP_HMAC_SECRET.\n" +
      "  Gossip routes (/api/gossip/*) are exempt from namespace auth — HMAC is required.\n" +
      "  Set GROVE_GOSSIP_HMAC_SECRET to a shared secret for all federated peers,\n" +
      "  or unset GOSSIP_SEEDS to disable gossip.",
  );
  process.exit(1);
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

// Prefer the namespace persisted by `grove init` — stable across branch renames.
// Fall back to GROVE_ZONE_ID env var, then auto-derive from project-id/branch.
let zoneId = readNamespace(GROVE_DIR) ?? process.env.GROVE_ZONE_ID;
if (!zoneId) {
  const projectId = readProjectId(GROVE_DIR);
  const worktreeName = await detectWorktreeName();
  zoneId = projectId ? `${projectId}/${worktreeName}` : "default";
  if (!projectId) {
    console.warn(
      "grove-server: no project-id found — namespace defaults to 'default'. Run `grove init`.",
    );
  }
}

const rawRegistry = loadKeyRegistry(join(GROVE_DIR, "server-keys.yaml"));
// Scope registry to this server's own namespace only — reject keys for other worktrees.
// This server is one-namespace-per-process: all stores are process-global and
// scoped to zoneId. Keys for other namespaces would allow cross-namespace access.
const droppedCount = [...rawRegistry.values()].filter((ns) => ns !== zoneId).length;
if (droppedCount > 0) {
  console.log(
    `grove-server: dropping ${droppedCount} key(s) for other namespaces (this process serves '${zoneId}' only).`,
  );
}
let registry = new Map([...rawRegistry].filter(([, ns]) => ns === zoneId));
if (registry.size === 0) {
  // Never auto-generate credentials for the shared 'default' namespace — doing so
  // would let uninitialized servers read/write each other's Nexus state.
  if (zoneId === "default") {
    console.error(
      "grove-server: cannot start without a project namespace.\n" +
        "  Run 'grove init' to generate a unique project-id and namespace credentials,\n" +
        "  or set GROVE_ZONE_ID to an explicit namespace before starting.",
    );
    process.exit(1);
  }
  // Pre-A3 workspace: project-id exists but no server-keys.yaml yet.
  // Auto-generate credentials so API routes are usable immediately (upgrade path).
  const { randomBytes } = await import("node:crypto");
  const rawClientKey = readClientKey(GROVE_DIR);
  // Accept grv_-prefixed keys (from grove init) or raw hex keys (from older auto-upgrade).
  // Require non-empty with ≥32 chars of hex content to prevent empty-token bypass.
  const isValidKey =
    typeof rawClientKey === "string" &&
    /^(?:grv_)?[0-9a-f]{32,}$/i.test(rawClientKey) &&
    rawClientKey.replace(/^grv_/, "").length >= 32;
  // Fail closed if the existing client key is already registered for a DIFFERENT namespace.
  // Reusing the same key for a different namespace would silently convert authorization
  // from the old namespace to the new one, making old-namespace data appear missing.
  if (isValidKey && rawClientKey) {
    const existingNs = rawRegistry.get(rawClientKey);
    if (existingNs !== undefined && existingNs !== zoneId) {
      console.error(
        `grove-server: cannot start — existing api-key is registered for namespace '${existingNs}' ` +
          `but computed namespace is '${zoneId}'.\n` +
          `  Run 'grove init' to generate fresh credentials for the current namespace.`,
      );
      process.exit(1);
    }
  }
  const clientKey = isValidKey ? rawClientKey! : randomBytes(32).toString("hex");
  if (!isValidKey) {
    writeClientKey(GROVE_DIR, clientKey);
  }
  appendServerKey(GROVE_DIR, clientKey, zoneId);
  // Persist the namespace file so future startups skip auto-derive.
  if (!readNamespace(GROVE_DIR)) {
    writeNamespace(GROVE_DIR, zoneId);
  }
  registry = new Map([[clientKey, zoneId]]);
  console.warn(
    `grove-server: auto-generated namespace credentials for '${zoneId}'. ` +
      `Re-run 'grove init' to register additional keys.`,
  );
}

if (seedPeers.length > 0) {
  const allowPrivateIPs = process.env.GROVE_GOSSIP_ALLOW_PRIVATE_IPS === "true";
  // Use HMAC (not bearer token) for peer-to-peer auth — namespace API keys must never be sent to peers.
  const transport = new HttpGossipTransport({ allowPrivateIPs, hmacSecret: gossipHmacSecret });
  gossipService = new DefaultGossipService({
    config: {
      peerId,
      address: peerAddress,
      seedPeers: [...seedPeers],
      hmacSecret: gossipHmacSecret,
    },
    transport,
    frontier: runtime.frontier,
    getLoad: () => ({ queueDepth: 0 }),
  });
}

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
  contributionStoreForSessionFactory = memoizeContributionStoreForSession(
    (sessionId: string) => new NexusContributionStore({ client: nexusClient, zoneId, sessionId }),
  );
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
  gossipHmacSecret: gossipHmacSecret,
  topology: runtime.contract?.topology,
  contract: runtime.contract,
  idempotencyStore: runtime.idempotencyStore,
};

const app = createApp(deps, registry);

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
          const auth = req.headers.get("Authorization");
          const key = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
          if (!key || !registry.has(key)) {
            return new Response(
              JSON.stringify({
                error: {
                  code: "NAMESPACE_UNAUTHORIZED",
                  message: "Invalid or missing bearer token",
                },
              }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            );
          }
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
