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
import { agentTaskViewToEntity } from "../core/agent-task.js";
import {
  claimToEntity,
  contributionToEntity,
  timelineEventToEntity,
  workBlockToEntity,
} from "../core/entity.js";
import type { FrontierCalculator } from "../core/frontier.js";
import {
  DefaultFrontierCalculator,
  SessionAggregatingFrontierCalculator,
} from "../core/frontier.js";
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
import { TaskController } from "../core/task-controller.js";
import { TimelineEventType } from "../core/timeline.js";
import { timelineEventForClaim } from "../core/timeline-projector.js";
import type { WatchEntity, WatchKind } from "../core/watch-events.js";
import { WatchHub } from "../core/watch-hub.js";
import { CachedFrontierCalculator } from "../gossip/cached-frontier.js";
import { HttpGossipTransport } from "../gossip/http-transport.js";
import { DefaultGossipService } from "../gossip/protocol.js";
import { createLocalRuntime } from "../local/runtime.js";
import { NexusWatchSubscriber } from "../nexus/nexus-watch-subscriber.js";
import { parseGossipSeeds, parsePort } from "../shared/env.js";
import { wireAgentTaskStoreWrites } from "./agent-task-store-wiring.js";
import { createApp } from "./app.js";
import type { ServerDeps } from "./deps.js";
import { loadKeyRegistry } from "./middleware/namespace-auth.js";
import { SessionService } from "./session-service.js";
import { memoizeContributionStoreForSession } from "./session-store-factory.js";
import { createServerAgentRuntime, taskControllerEnabled } from "./task-controller-wiring.js";
import { resolveWatchHubConfig } from "./watch-hub-config.js";
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
let serverFrontier: FrontierCalculator = runtime.frontier;
/**
 * Frontier calculator dedicated to gossip's outbound digest. Defaults to
 * the same store as `serverFrontier`; in Nexus mode it is rebound to a
 * root-only calculator so we don't advertise session-scoped CIDs that the
 * peer fetch path cannot resolve (#226).
 */
let gossipFrontier: FrontierCalculator = runtime.frontier;
let serverTimelineStore: import("../core/timeline-store.js").TimelineStore = runtime.timelineStore;
let inboxReadSource: import("../core/operations/inbox-delegation.js").InboxReadSource | undefined;
let messageDelivery: import("../core/operations/inbox-delegation.js").MessageDelivery | undefined;
let messageDeliveryForSession:
  | ((
      sessionId: string | undefined,
    ) => import("../core/operations/inbox-delegation.js").MessageDelivery | undefined)
  | undefined;

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
  const clientKey = isValidKey && rawClientKey ? rawClientKey : randomBytes(32).toString("hex");
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

// ---------------------------------------------------------------------------
// Watch protocol (#292)
// ---------------------------------------------------------------------------
// `watchHub` holds per-(namespace, kind) RV counters and the replay ring.
// `watchEventBus` is the in-process fan-out channel for `entity.changed`
// envelopes; the publisher lives inside Nexus stores and the subscriber
// lives here in the server. Even in pure-local mode we instantiate both
// so the wiring is uniform — the bus is just idle when nothing publishes.
//
// KNOWN GAP (tracked separately from #293, see #294 informer client):
// The bus is process-local. MCP/agent processes that share the same Nexus
// VFS write through Nexus stores, but their `entity.changed` envelopes
// publish to a *different* in-process bus and never reach this server's
// watchSubscriber. Today the watch protocol covers writes performed
// through grove-server's own routes plus the in-process onEntityWrite
// fast path. Closing the gap requires routing entity.changed through
// NexusEventBus (cross-process via Nexus IPC) on both sides.
const watchHub = new WatchHub(resolveWatchHubConfig(process.env));
const watchEventBus = new LocalEventBus();
let taskController: TaskController | undefined;

if (nexusUrl) {
  const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
  const { NexusContributionStore } = await import("../nexus/nexus-contribution-store.js");
  const { NexusClaimStore } = await import("../nexus/nexus-claim-store.js");
  const { NexusBountyStore } = await import("../nexus/nexus-bounty-store.js");
  const { NexusOutcomeStore } = await import("../nexus/nexus-outcome-store.js");
  const { NexusCas } = await import("../nexus/nexus-cas.js");
  const { NexusSessionStore } = await import("../nexus/nexus-session-store.js");
  const { NexusTimelineStore } = await import("../nexus/nexus-timeline-store.js");
  const { NexusWatchPublisher } = await import("../nexus/nexus-watch-publisher.js");

  const nexusClient = new NexusHttpClient({
    url: nexusUrl,
    ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
  });

  // Publisher fans out `entity.changed` envelopes from store mutations
  // onto the local event-bus, where the subscriber (instantiated below
  // after the stores) hydrates them into the WatchHub. This closes the
  // cross-process loop: writes from MCP / other grove processes that
  // share the same Nexus VFS reach this server's watchers.
  const watchPublisher = new NexusWatchPublisher(watchEventBus);

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

  const { NexusInboxClient, NexusMessageDelivery } = await import("../nexus/index.js");
  const { NexusIpcClient } = await import("../nexus/nexus-ipc-client.js");
  const sessionId = process.env.GROVE_SESSION_ID;
  inboxReadSource = new NexusInboxClient({
    nexusUrl,
    ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
    sessionId,
    zoneId,
    client: nexusClient,
  });
  messageDelivery = new NexusMessageDelivery({
    ipcClient: new NexusIpcClient({
      nexusUrl,
      ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
      sessionId,
      zoneId,
    }),
  });
  messageDeliveryForSession = (requestedSessionId) =>
    new NexusMessageDelivery({
      ipcClient: new NexusIpcClient({
        nexusUrl,
        ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
        sessionId: requestedSessionId ?? process.env.GROVE_SESSION_ID,
        zoneId,
      }),
    });

  serverContributionStore = new NexusContributionStore({
    client: nexusClient,
    zoneId,
    watchPublisher,
  });
  serverClaimStore = new NexusClaimStore({ client: nexusClient, zoneId, watchPublisher });
  serverBountyStore = new NexusBountyStore({ client: nexusClient, zoneId });
  serverOutcomeStore = new NexusOutcomeStore({ client: nexusClient, zoneId });
  serverCas = new NexusCas({ client: nexusClient, zoneId });
  serverTimelineStore = new NexusTimelineStore({ client: nexusClient, zoneId, watchPublisher });
  const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);
  const nexusContributionStoreForSession = memoizeContributionStoreForSession(
    (sessionId: string) =>
      new NexusContributionStore({
        client: nexusClient,
        zoneId,
        sessionId,
        watchPublisher,
      }),
  );
  contributionStoreForSessionFactory = nexusContributionStoreForSession;
  serverFrontier = new CachedFrontierCalculator(
    new SessionAggregatingFrontierCalculator({
      rootStore: serverContributionStore,
      listSessionIds: async () =>
        (await nexusSessionStore.listSessions({ includeArchived: true })).map(
          (session) => session.id,
        ),
      storeForSession: nexusContributionStoreForSession,
    }),
  );
  // Gossip federation advertises CIDs by bare hash and the peer fetch path
  // resolves against the *root* contribution store (no session scope on the
  // wire). Advertising session-only contributions through the aggregating
  // wrapper would make peers chase 404s. Keep a root-only frontier for
  // gossip's outbound digest while the HTTP API continues to use the
  // session-aggregating wrapper for local reads.
  gossipFrontier = new DefaultFrontierCalculator(serverContributionStore);
  console.log(`grove-server: using Nexus stores at ${nexusUrl} (zone=${zoneId})`);
}

/**
 * Parse a positive-integer env var. Returns undefined when unset, empty,
 * or malformed (so callers fall through to the library default). Refuses
 * NaN, non-finite, zero, and negative values — setTimeout(NaN) and
 * setTimeout(<=0) run on every tick and would turn gossip into a hot loop.
 */
function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(
      `grove-server: invalid ${name}='${raw}' (must be a positive integer). Ignoring; using default.`,
    );
    return undefined;
  }
  return n;
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
      intervalMs: parsePositiveIntEnv("GROVE_GOSSIP_INTERVAL_MS"),
      antiEntropy: {
        enabled: process.env.GROVE_GOSSIP_ANTI_ENTROPY === "1",
        intervalMs: parsePositiveIntEnv("GROVE_GOSSIP_ANTI_ENTROPY_INTERVAL_MS"),
        batchSize: parsePositiveIntEnv("GROVE_GOSSIP_ANTI_ENTROPY_BATCH"),
      },
    },
    transport,
    frontier: gossipFrontier,
    getLoad: () => ({ queueDepth: 0 }),
    contributionStore: serverContributionStore,
    cas: serverCas,
  });
}

const operationFrontierRewardService =
  serverBountyStore === runtime.bountyStore ? runtime.frontierRewardService : undefined;

// Per-request session-scoped handoff store factory. The HTTP handoff
// routes accept ?sessionId= and use this factory to build a scoped
// SqliteHandoffStore on demand, preventing cross-session reads/mutations
// from remote TUIs that share the same process-global runtime.
const { SqliteHandoffStore: _SqliteHandoffStore } = await import(
  "../local/sqlite-handoff-store.js"
);
const handoffStoreForSession = (sessionId: string) =>
  new _SqliteHandoffStore(runtime.db, sessionId) as import("../core/handoff.js").HandoffStore;

// Subscribe to cross-process `entity.changed` envelopes (#292). Started in
// every mode so future bus-publishers (Nexus-backed bus, other processes)
// fan in uniformly; idle no-op when nothing publishes (pure local).
const watchSubscriber = new NexusWatchSubscriber({
  bus: watchEventBus,
  hub: watchHub,
  fetchEntity: makeWatchEntityFetcher({
    contributionStore: serverContributionStore,
    claimStore: serverClaimStore,
    timelineStore: serverTimelineStore,
    agentTaskStore: runtime.agentTaskStore,
  }),
});
watchSubscriber.start();

wireAgentTaskStoreWrites({
  store: runtime.agentTaskStore,
  namespace: zoneId,
  watchHub,
  watchSubscriber,
  enqueueTaskId: (taskId) => {
    taskController?.enqueue(taskId);
  },
  onError(error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[grove] Warning: AgentTask write fan-out failed: ${detail}\n`);
  },
});

const deps: ServerDeps = {
  contributionStore: serverContributionStore,
  contributionStoreForSession: contributionStoreForSessionFactory,
  claimStore: serverClaimStore,
  timelineStore: serverTimelineStore,
  agentTaskStore: runtime.agentTaskStore,
  outcomeStore: serverOutcomeStore,
  bountyStore: serverBountyStore,
  creditsService: runtime.creditsService,
  frontierRewardService: operationFrontierRewardService,
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
  inboxReadSource,
  messageDelivery,
  messageDeliveryForSession,
  watchHub,
  watchSubscriber,
};

const app = createApp(deps, registry);

let sharedAgentRuntime: import("../core/agent-runtime.js").AgentRuntime | undefined;
const getSharedAgentRuntime = async (): Promise<
  import("../core/agent-runtime.js").AgentRuntime
> => {
  sharedAgentRuntime ??= await createServerAgentRuntime();
  return sharedAgentRuntime;
};

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
  sweepReconciler.register(new SettlementSweep(serverBountyStore, runtime.creditsService));
  sweepReconciler.start();
  console.log("sweep-reconciler started (BountyIndexSweep, SettlementSweep)");
}

// ---------------------------------------------------------------------------
// Claim expiry sweep — drives lease-derived state changes into the watch log
// ---------------------------------------------------------------------------
//
// expireStale() flips active claims past their lease to `expired` and bumps
// revision, but it does not on its own emit a watch event in SQLite mode and
// the Nexus mode publisher can be self-filtered by sourceInstanceId. Without
// this sweep, /api/watch?kind=Claim clients would never observe a lease-only
// expiry — they'd see the claim as active until another write touched it.
const CLAIM_EXPIRY_INTERVAL_MS = 30_000;
const claimExpiryTimer = setInterval(async () => {
  try {
    const expired = await serverClaimStore.expireStale();
    for (const { claim } of expired) {
      const entity = claimToEntity(claim, () => Date.now(), zoneId);
      try {
        watchHub.recordWrite({ kind: "Claim", namespace: zoneId, op: "MODIFIED", entity });
        watchSubscriber.markSeen({
          kind: "Claim",
          entityId: claim.claimId,
          generation: entity.metadata.generation,
        });
      } catch (err) {
        process.stderr.write(
          `[grove] Warning: claim-expiry watch fan-out threw: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
      try {
        await serverTimelineStore.appendTimelineEvent(
          timelineEventForClaim(claim, TimelineEventType.ClaimExpired),
        );
      } catch (err) {
        process.stderr.write(
          `[grove] Warning: claim-expiry timeline projection threw: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `[grove] Warning: claim-expiry sweep failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}, CLAIM_EXPIRY_INTERVAL_MS);
// Don't hold the event loop open just for this timer.
(claimExpiryTimer as unknown as { unref?: () => void }).unref?.();

// ---------------------------------------------------------------------------
// Server bind safety checks
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
// MUST run before SessionService/task-controller setup or Bun.serve() —
// otherwise we could spawn sessions or bind the socket before deciding to exit.
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

// ---------------------------------------------------------------------------
// Optional SessionService + WebSocket push
// ---------------------------------------------------------------------------

let sessionService: SessionService | undefined;
let wsHandler: ReturnType<typeof createWsHandler> | undefined;

if (runtime.contract?.topology !== undefined) {
  const agentRuntime = await getSharedAgentRuntime();
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

  // SSE watch streams (#292) hold connections idle for up to bookmarkIntervalMs
  // (default 30s) plus replay drift. Bun's default idleTimeout is 10s — without
  // raising it, the watcher's TCP connection is closed before the next BOOKMARK
  // fires and clients see silent disconnects. 255 is Bun's max.
  const idleTimeout = 255;

  if (wsHandler !== undefined) {
    const wsh = wsHandler;
    return Bun.serve({
      port: PORT,
      idleTimeout,
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
    idleTimeout,
    ...hostnameOpts,
    fetch: app.fetch,
  });
}

const server = startServer();

if (taskControllerEnabled(process.env) && runtime.agentTaskStore !== undefined) {
  taskController = new TaskController({
    taskStore: runtime.agentTaskStore,
    runtime: await getSharedAgentRuntime(),
    onError(error, taskId) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[task-controller] ${taskId}: ${detail}\n`);
    },
  });
  await taskController.resync();
  taskController.start();
  console.log("task-controller enabled");
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
  if (sweepReconciler) {
    sweepReconciler.stop();
  }
  await taskController?.stop();
  if (sessionService) {
    sessionService.destroy();
  }
  if (gossipService) {
    await gossipService.stop();
  }
  watchSubscriber.stop();
  server.stop();
  runtime.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

// ---------------------------------------------------------------------------
// Watch entity fetcher (#292)
// ---------------------------------------------------------------------------

/**
 * Build a fetcher used by NexusWatchSubscriber to hydrate `entity.changed`
 * envelopes into full WatchEntity payloads via the same stores the server
 * uses for HTTP reads — keeping the wire format minimal.
 */
function makeWatchEntityFetcher(stores: {
  contributionStore: import("../core/store.js").ContributionStore;
  claimStore: import("../core/store.js").ClaimStore;
  timelineStore: import("../core/timeline-store.js").TimelineStore;
  agentTaskStore?: import("../core/store.js").AgentTaskStore | undefined;
}): (kind: WatchKind, namespace: string, id: string) => Promise<WatchEntity> {
  return async (kind, namespace, id) => {
    if (kind === "Contribution") {
      const c = await stores.contributionStore.get(id);
      if (!c) throw new Error(`Contribution ${id} not found`);
      return contributionToEntity(c, namespace);
    }
    if (kind === "Claim") {
      const c = await stores.claimStore.getClaim(id);
      if (!c) throw new Error(`Claim ${id} not found`);
      return claimToEntity(c, () => Date.now(), namespace);
    }
    if (kind === "WorkBlock") {
      const block = await stores.timelineStore.getWorkBlock(id);
      if (!block) throw new Error(`WorkBlock ${id} not found`);
      return workBlockToEntity(block, namespace);
    }
    if (kind === "TimelineEvent") {
      const event = await stores.timelineStore.getTimelineEvent(id);
      if (!event) throw new Error(`TimelineEvent ${id} not found`);
      return timelineEventToEntity(event, namespace);
    }
    if (kind === "AgentTask") {
      const view = await stores.agentTaskStore?.getAgentTask(id);
      if (!view) throw new Error(`AgentTask ${id} not found`);
      return agentTaskViewToEntity(view, namespace);
    }
    throw new Error(`Unsupported kind for watch fetcher: ${kind}`);
  };
}
