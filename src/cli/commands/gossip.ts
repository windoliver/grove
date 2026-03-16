/**
 * grove gossip — gossip protocol commands.
 *
 * Supports three modes:
 *   Server query mode: query a running grove-server's gossip state
 *   Direct mode: CLI participates in gossip using local stores
 *   Daemon mode: CLI runs a persistent gossip loop with state persistence
 *
 * Usage:
 *   grove gossip peers      [--server <url>]          List known peers
 *   grove gossip status     [--server <url>]          Show gossip overview
 *   grove gossip frontier   [--server <url>]          Show merged frontier
 *   grove gossip exchange   <peer-url> [--peer-id id] Push-pull frontier exchange
 *   grove gossip shuffle    <peer-url> [--peer-id id] CYCLON peer sampling shuffle
 *   grove gossip sync       <seeds>    [--peer-id id] Full round with seed peers
 *   grove gossip daemon     <seeds>    [--peer-id id] Run persistent gossip loop
 *   grove gossip watch      [--server <url>]          Stream gossip events
 *   grove gossip add-peer   <id@address>              Add peer to local store
 *   grove gossip remove-peer <id>                     Remove peer from local store
 */

import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { FrontierEntry } from "../../core/frontier.js";
import type {
  FrontierDigestEntry,
  GossipEvent,
  GossipMessage,
  PeerInfo,
  PeerLiveness,
  ShuffleRequest,
} from "../../core/gossip/types.js";
import { CachedFrontierCalculator } from "../../gossip/cached-frontier.js";
import { CyclonPeerSampler } from "../../gossip/cyclon.js";
import { HttpGossipTransport } from "../../gossip/http-transport.js";
import { DefaultGossipService } from "../../gossip/protocol.js";
import { SqliteGossipStore } from "../../local/gossip-store.js";
import type { CliDeps, Writer } from "../context.js";
import { resolveGroveDir } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVER = "http://localhost:4515";
const DEFAULT_DIGEST_LIMIT = 5;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function handleGossip(
  args: readonly string[],
  groveOverride: string | undefined,
  /** Injected for direct-mode commands that need local stores. */
  withCliDeps?: (
    fn: (args: readonly string[], deps: CliDeps) => Promise<void>,
    args: readonly string[],
  ) => Promise<void>,
  writer: Writer = console.log,
): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "peers":
      await handlePeers(subArgs, writer);
      break;
    case "status":
      await handleStatus(subArgs, writer);
      break;
    case "frontier":
      await handleFrontier(subArgs, writer);
      break;
    case "exchange":
      if (!withCliDeps) {
        throw new Error("exchange requires local grove stores");
      }
      await withCliDeps(async (a, deps) => handleExchange(a, deps, writer), [...subArgs]);
      break;
    case "shuffle":
      await handleShuffle(subArgs, writer);
      break;
    case "sync":
      if (!withCliDeps) {
        throw new Error("sync requires local grove stores");
      }
      await withCliDeps(async (a, deps) => handleSync(a, deps, writer), [...subArgs]);
      break;
    case "daemon":
      if (!withCliDeps) {
        throw new Error("daemon requires local grove stores");
      }
      await withCliDeps(
        async (a, deps) => handleDaemon(a, deps, groveOverride, writer),
        [...subArgs],
      );
      break;
    case "watch":
      await handleWatch(subArgs, writer);
      break;
    case "add-peer":
      handleAddPeer(subArgs, groveOverride, writer);
      break;
    case "remove-peer":
      handleRemovePeer(subArgs, groveOverride, writer);
      break;
    default:
      printGossipUsage(writer);
      if (subcommand && subcommand !== "--help" && subcommand !== "-h") {
        process.exitCode = 1;
      }
  }
}

// ---------------------------------------------------------------------------
// Server query commands
// ---------------------------------------------------------------------------

async function handlePeers(args: readonly string[], writer: Writer): Promise<void> {
  const { server, json } = parseServerArgs([...args]);

  const res = await fetch(`${server}/api/gossip/peers`);
  if (!res.ok) {
    throw new Error(`Server error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    peers: PeerInfo[];
    liveness: Array<{
      peer: PeerInfo;
      status: string;
      lastSeen: string;
      suspectedAt?: string;
    }>;
  };

  if (json) {
    writer(JSON.stringify(data, null, 2));
    return;
  }

  if (data.peers.length === 0) {
    writer("No peers known.");
    return;
  }

  writer("Known peers:\n");
  for (const l of data.liveness) {
    const status = formatStatus(l.status);
    writer(
      `  ${l.peer.peerId}  ${l.peer.address}  age=${l.peer.age}  ${status}  last=${l.lastSeen}`,
    );
  }
  writer(`\nTotal: ${data.peers.length} peer(s)`);
}

async function handleStatus(args: readonly string[], writer: Writer): Promise<void> {
  const { server, json } = parseServerArgs([...args]);

  const res = await fetch(`${server}/api/grove`);
  if (!res.ok) {
    throw new Error(`Server error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    version: string;
    stats: { contributions: number; activeClaims: number };
    gossip?: {
      enabled: boolean;
      peers: number;
      liveness: Array<{ peerId: string; status: string; lastSeen: string }>;
    };
  };

  if (json) {
    writer(JSON.stringify(data, null, 2));
    return;
  }

  if (!data.gossip || !data.gossip.enabled) {
    writer("Gossip: disabled");
    return;
  }

  writer(`Gossip: enabled`);
  writer(`Peers: ${data.gossip.peers}`);
  writer(`Contributions: ${data.stats.contributions}`);
  writer(`Active claims: ${data.stats.activeClaims}`);

  if (data.gossip.liveness.length > 0) {
    writer("\nPeer liveness:");
    for (const l of data.gossip.liveness) {
      writer(`  ${l.peerId}  ${formatStatus(l.status)}  last=${l.lastSeen}`);
    }
  }
}

async function handleFrontier(args: readonly string[], writer: Writer): Promise<void> {
  const { server, json } = parseServerArgs([...args]);

  const res = await fetch(`${server}/api/gossip/frontier`);
  if (!res.ok) {
    throw new Error(`Server error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { entries: FrontierDigestEntry[] };

  if (json) {
    writer(JSON.stringify(data, null, 2));
    return;
  }

  if (data.entries.length === 0) {
    writer("(no frontier data from gossip)");
    return;
  }

  // Group by metric
  const byMetric = new Map<string, FrontierDigestEntry[]>();
  for (const entry of data.entries) {
    const list = byMetric.get(entry.metric) ?? [];
    list.push(entry);
    byMetric.set(entry.metric, list);
  }

  for (const [metric, entries] of byMetric) {
    writer(`\n${metric}:`);
    for (const e of entries) {
      const tags = e.tags && e.tags.length > 0 ? `  [${e.tags.join(", ")}]` : "";
      writer(`  ${e.cid.slice(0, 16)}…  value=${e.value}${tags}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Direct gossip commands
// ---------------------------------------------------------------------------

async function handleExchange(
  args: readonly string[],
  deps: CliDeps,
  writer: Writer,
): Promise<void> {
  const { peerUrl, peerId, json } = parseDirectArgs([...args]);

  const transport = new HttpGossipTransport({ allowPrivateIPs: true });
  const message = await buildGossipMessage(peerId, deps);
  const target = urlToPeerInfo(peerUrl);

  writer(`Exchanging frontier with ${peerUrl}...`);
  const response = await transport.exchange(target, message);

  if (json) {
    writer(JSON.stringify(response, null, 2));
    return;
  }

  writer(`\nReceived from ${response.peerId}:`);
  writer(`  Frontier entries: ${response.frontier.length}`);
  writer(`  Load: queueDepth=${response.load.queueDepth}`);
  writer(`  Timestamp: ${response.timestamp}`);

  if (response.frontier.length > 0) {
    writer("\nFrontier digest:");
    for (const e of response.frontier) {
      writer(`  ${e.metric}: ${e.cid.slice(0, 16)}… value=${e.value}`);
    }
  }

  // Show what's new — CIDs they have that we might not
  const localCids = new Set(message.frontier.map((e) => e.cid));
  const newEntries = response.frontier.filter((e) => !localCids.has(e.cid));
  if (newEntries.length > 0) {
    writer(`\nNew CIDs discovered: ${newEntries.length}`);
    for (const e of newEntries) {
      writer(`  ${e.metric}: ${e.cid.slice(0, 16)}… value=${e.value}`);
    }
  } else {
    writer("\nNo new CIDs discovered (frontiers in sync).");
  }
}

async function handleShuffle(args: readonly string[], writer: Writer): Promise<void> {
  const { peerUrl, peerId, json } = parseDirectArgs([...args]);

  const transport = new HttpGossipTransport({ allowPrivateIPs: true });
  // Use the target URL as our address — not routable for incoming gossip,
  // but satisfies the sender schema and identifies the request origin.
  const selfPeer: PeerInfo = {
    peerId,
    address: peerUrl,
    age: 0,
    lastSeen: new Date().toISOString(),
  };

  const target = urlToPeerInfo(peerUrl);
  // Don't include self in offered — CLI can't receive incoming gossip
  const request: ShuffleRequest = {
    sender: { ...selfPeer, age: 0 },
    offered: [],
  };

  writer(`Shuffling with ${peerUrl}...`);
  const response = await transport.shuffle(target, request);

  if (json) {
    writer(JSON.stringify(response, null, 2));
    return;
  }

  if (response.offered.length === 0) {
    writer("Peer has no other peers to share.");
    return;
  }

  writer(`\nDiscovered ${response.offered.length} peer(s):`);
  for (const peer of response.offered) {
    writer(`  ${peer.peerId}  ${peer.address}  age=${peer.age}`);
  }
}

async function handleSync(args: readonly string[], deps: CliDeps, writer: Writer): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      "peer-id": { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const seedsArg = positionals[0];
  if (!seedsArg) {
    throw new Error("Usage: grove gossip sync <seed1,seed2,...> [--peer-id id]");
  }

  const peerId = values["peer-id"] ?? `cli-${hostname()}-${process.pid}`;
  const json = values.json ?? false;
  const transport = new HttpGossipTransport({ allowPrivateIPs: true });

  // Parse seeds: either "peerId@url" or just "url"
  const seeds = parseSeedList(seedsArg);

  // Use the first seed's address as our sender address — not routable for
  // incoming gossip, but satisfies the sender schema and identifies origin.
  const selfPeer: PeerInfo = {
    peerId,
    address: seeds[0]?.address ?? `cli://${hostname()}`,
    age: 0,
    lastSeen: new Date().toISOString(),
  };
  const sampler = new CyclonPeerSampler(selfPeer, { maxViewSize: 10, shuffleLength: 5 }, seeds);

  const message = await buildGossipMessage(peerId, deps);

  writer(`Syncing with ${seeds.length} seed(s)...\n`);

  const allDiscovered: FrontierDigestEntry[] = [];
  const allPeers: PeerInfo[] = [];

  // 1. Shuffle with each seed to discover peers
  for (const seed of seeds) {
    try {
      writer(`  Shuffling with ${seed.peerId} (${seed.address})...`);
      // Don't include self in offered — CLI can't receive incoming gossip
      const request: ShuffleRequest = {
        sender: { ...selfPeer, age: 0 },
        offered: [],
      };
      const shuffleResp = await transport.shuffle(seed, request);
      sampler.processShuffleResponse(shuffleResp, request.offered);

      for (const peer of shuffleResp.offered) {
        allPeers.push(peer);
      }
      writer(`    Discovered ${shuffleResp.offered.length} peer(s)`);
    } catch (err) {
      writer(`    Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Exchange frontier with all known peers (seeds + discovered)
  const exchangeTargets = sampler.getView();
  writer(`\nExchanging frontier with ${exchangeTargets.length} peer(s)...\n`);

  for (const peer of exchangeTargets) {
    try {
      writer(`  Exchange with ${peer.peerId} (${peer.address})...`);
      const response = await transport.exchange(peer, message);

      for (const entry of response.frontier) {
        allDiscovered.push(entry);
      }
      writer(`    Received ${response.frontier.length} frontier entries`);
    } catch (err) {
      writer(`    Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Summary
  const localCids = new Set(message.frontier.map((e) => e.cid));
  const newCids = new Set(allDiscovered.filter((e) => !localCids.has(e.cid)).map((e) => e.cid));

  if (json) {
    writer(
      JSON.stringify(
        {
          peersDiscovered: allPeers.length,
          frontierEntriesReceived: allDiscovered.length,
          newCids: [...newCids],
          view: [...sampler.getView()],
        },
        null,
        2,
      ),
    );
    return;
  }

  writer(`\nSync complete:`);
  writer(`  Peers in view: ${sampler.size}`);
  writer(`  Frontier entries received: ${allDiscovered.length}`);
  writer(`  New CIDs discovered: ${newCids.size}`);

  if (newCids.size > 0) {
    writer("\nNew CIDs:");
    for (const cid of newCids) {
      writer(`  ${cid.slice(0, 24)}…`);
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon mode
// ---------------------------------------------------------------------------

async function handleDaemon(
  args: readonly string[],
  deps: CliDeps,
  groveOverride: string | undefined,
  writer: Writer,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      "peer-id": { type: "string" },
      port: { type: "string" },
      interval: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const seedsArg = positionals[0];
  if (!seedsArg) {
    throw new Error(
      "Usage: grove gossip daemon <seeds> [--peer-id id] [--port port] [--interval s]",
    );
  }

  const peerId = values["peer-id"] ?? `cli-${hostname()}-${process.pid}`;
  const port = values.port ? Number.parseInt(values.port, 10) : 4516;
  const intervalSec = values.interval ? Number.parseInt(values.interval, 10) : 30;
  const seeds = parseSeedList(seedsArg);
  const address = `http://${hostname()}:${port}`;

  // Open gossip state store
  const { groveDir } = resolveGroveDir(groveOverride);
  const gossipStore = new SqliteGossipStore(join(groveDir, "gossip.db"));

  // Load persisted peers and merge with seeds
  const persistedPeers = gossipStore.loadPeers();
  const allSeeds = [...seeds];
  for (const p of persistedPeers) {
    if (!allSeeds.some((s) => s.peerId === p.peerId)) {
      allSeeds.push(p);
    }
  }

  // Load persisted frontier
  const persistedFrontier = gossipStore.loadFrontier();

  // Create gossip service
  const cachedFrontier = new CachedFrontierCalculator(deps.frontier);
  const transport = new HttpGossipTransport({ allowPrivateIPs: true });
  const gossipService = new DefaultGossipService({
    config: {
      peerId,
      address,
      seedPeers: allSeeds,
      intervalMs: intervalSec * 1000,
    },
    transport,
    frontier: cachedFrontier,
    initialFrontier: persistedFrontier,
  });

  // Register event listener for console output and state persistence
  gossipService.on((event: GossipEvent) => {
    writer(`[gossip] ${event.type}: peer=${event.peerId} at ${event.timestamp}`);

    // Persist state after each event
    gossipStore.savePeers(gossipService.peers());
    gossipStore.saveFrontier(gossipService.mergedFrontier());
  });

  // Start HTTP server for incoming gossip requests
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "POST" && path === "/api/gossip/exchange") {
        const body = (await req.json()) as GossipMessage;
        const response = await gossipService.handleExchange(body);
        return Response.json(response);
      }

      if (req.method === "POST" && path === "/api/gossip/shuffle") {
        const body = (await req.json()) as ShuffleRequest;
        const response = gossipService.handleShuffle(body);
        return Response.json(response);
      }

      if (req.method === "GET" && path === "/api/gossip/peers") {
        return Response.json({
          peers: gossipService.peers(),
          liveness: gossipService.liveness(),
        });
      }

      if (req.method === "GET" && path === "/api/gossip/frontier") {
        return Response.json({ entries: gossipService.mergedFrontier() });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  writer(`Gossip daemon started:`);
  writer(`  Peer ID:   ${peerId}`);
  writer(`  Address:   ${address}`);
  writer(`  Port:      ${port}`);
  writer(`  Interval:  ${intervalSec}s`);
  writer(`  Seeds:     ${seeds.map((s) => s.peerId).join(", ")}`);
  writer(
    `  Persisted: ${persistedPeers.length} peer(s), ${persistedFrontier.length} frontier entries`,
  );
  writer(`\nListening for gossip on port ${port}. Press Ctrl+C to stop.\n`);

  // Start the gossip loop
  gossipService.start();

  // Wait for SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      writer("\nShutting down gossip daemon...");
      await gossipService.stop();
      server.stop(true);

      // Persist final state
      gossipStore.savePeers(gossipService.peers());
      gossipStore.saveFrontier(gossipService.mergedFrontier());
      gossipStore.close();

      writer("State persisted. Goodbye.");
      resolve();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

async function handleWatch(args: readonly string[], writer: Writer): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      server: { type: "string", short: "s" },
      interval: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const server = values.server ?? process.env.GROVE_SERVER ?? DEFAULT_SERVER;
  const intervalSec = values.interval ? Number.parseInt(values.interval, 10) : 5;
  const json = values.json ?? false;

  writer(
    `Watching gossip events on ${server} (poll every ${intervalSec}s). Press Ctrl+C to stop.\n`,
  );

  // Track previous state to detect changes
  let previousPeers = new Map<string, string>(); // peerId -> status
  let previousFrontierSize = 0;
  let running = true;

  const shutdown = () => {
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      const [peersRes, frontierRes] = await Promise.all([
        fetch(`${server}/api/gossip/peers`),
        fetch(`${server}/api/gossip/frontier`),
      ]);

      if (!peersRes.ok || !frontierRes.ok) {
        writer(`[error] Server returned ${peersRes.status}/${frontierRes.status}`);
        await Bun.sleep(intervalSec * 1000);
        continue;
      }

      const peersData = (await peersRes.json()) as {
        peers: PeerInfo[];
        liveness: PeerLiveness[];
      };
      const frontierData = (await frontierRes.json()) as {
        entries: FrontierDigestEntry[];
      };

      const currentPeers = new Map<string, string>();
      for (const l of peersData.liveness) {
        currentPeers.set(l.peer.peerId, l.status);
      }

      // Detect changes
      const events: Array<{ type: string; peerId: string; detail?: string }> = [];

      // New peers
      for (const [peerId, status] of currentPeers) {
        if (!previousPeers.has(peerId)) {
          events.push({ type: "peer_joined", peerId, detail: status });
        } else if (previousPeers.get(peerId) !== status) {
          events.push({ type: `status_changed`, peerId, detail: status });
        }
      }

      // Removed peers
      for (const [peerId] of previousPeers) {
        if (!currentPeers.has(peerId)) {
          events.push({ type: "peer_removed", peerId });
        }
      }

      // Frontier changes
      if (frontierData.entries.length !== previousFrontierSize) {
        events.push({
          type: "frontier_updated",
          peerId: "local",
          detail: `${previousFrontierSize} -> ${frontierData.entries.length} entries`,
        });
      }

      // Output events
      for (const event of events) {
        const ts = new Date().toISOString();
        if (json) {
          writer(JSON.stringify({ ...event, timestamp: ts }));
        } else {
          const detail = event.detail ? ` (${event.detail})` : "";
          writer(`[${ts}] ${event.type}: ${event.peerId}${detail}`);
        }
      }

      previousPeers = currentPeers;
      previousFrontierSize = frontierData.entries.length;
    } catch (err) {
      writer(`[error] ${err instanceof Error ? err.message : String(err)}`);
    }

    await Bun.sleep(intervalSec * 1000);
  }

  writer("\nWatch stopped.");
}

// ---------------------------------------------------------------------------
// Peer management
// ---------------------------------------------------------------------------

function handleAddPeer(
  args: readonly string[],
  groveOverride: string | undefined,
  writer: Writer,
): void {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    strict: true,
    allowPositionals: true,
  });

  const peerSpec = positionals[0];
  if (!peerSpec) {
    throw new Error("Usage: grove gossip add-peer <peerId@address>");
  }

  const atIndex = peerSpec.indexOf("@");
  if (atIndex <= 0) {
    throw new Error("Peer must be in format: peerId@address (e.g., node1@http://host:4515)");
  }

  const peerId = peerSpec.slice(0, atIndex);
  const address = peerSpec.slice(atIndex + 1);

  const { groveDir } = resolveGroveDir(groveOverride);
  const gossipStore = new SqliteGossipStore(join(groveDir, "gossip.db"));

  try {
    const peer: PeerInfo = {
      peerId,
      address,
      age: 0,
      lastSeen: new Date().toISOString(),
    };

    const added = gossipStore.addPeer(peer);
    if (added) {
      writer(`Added peer: ${peerId} at ${address}`);
    } else {
      writer(`Peer ${peerId} already exists.`);
    }
  } finally {
    gossipStore.close();
  }
}

function handleRemovePeer(
  args: readonly string[],
  groveOverride: string | undefined,
  writer: Writer,
): void {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    strict: true,
    allowPositionals: true,
  });

  const peerId = positionals[0];
  if (!peerId) {
    throw new Error("Usage: grove gossip remove-peer <peerId>");
  }

  const { groveDir } = resolveGroveDir(groveOverride);
  const gossipStore = new SqliteGossipStore(join(groveDir, "gossip.db"));

  try {
    const removed = gossipStore.removePeer(peerId);
    if (removed) {
      writer(`Removed peer: ${peerId}`);
    } else {
      writer(`Peer ${peerId} not found.`);
    }
  } finally {
    gossipStore.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildGossipMessage(peerId: string, deps: CliDeps): Promise<GossipMessage> {
  const frontier = await deps.frontier.compute({ limit: DEFAULT_DIGEST_LIMIT });
  const entries: FrontierDigestEntry[] = [];

  for (const [metric, metricEntries] of Object.entries(frontier.byMetric)) {
    for (const entry of metricEntries) {
      entries.push({
        metric,
        value: entry.value,
        cid: entry.cid,
        tags:
          entry.contribution && entry.contribution.tags.length > 0
            ? entry.contribution.tags
            : undefined,
      });
    }
  }

  const addDimension = (dimension: string, items: readonly FrontierEntry[]): void => {
    for (const entry of items.slice(0, DEFAULT_DIGEST_LIMIT)) {
      entries.push({
        metric: `_${dimension}`,
        value: entry.value,
        cid: entry.cid,
      });
    }
  };

  addDimension("adoption", frontier.byAdoption);
  addDimension("recency", frontier.byRecency);
  addDimension("review_score", frontier.byReviewScore);
  addDimension("reproduction", frontier.byReproduction);

  return {
    peerId,
    frontier: entries,
    load: { queueDepth: 0 },
    capabilities: {},
    timestamp: new Date().toISOString(),
  };
}

function urlToPeerInfo(url: string): PeerInfo {
  return {
    peerId: url,
    address: url,
    age: 0,
    lastSeen: new Date().toISOString(),
  };
}

function parseSeedList(seedsStr: string): PeerInfo[] {
  return seedsStr.split(",").map((s) => {
    const trimmed = s.trim();
    const atIndex = trimmed.indexOf("@");
    if (atIndex > 0) {
      return {
        peerId: trimmed.slice(0, atIndex),
        address: trimmed.slice(atIndex + 1),
        age: 0,
        lastSeen: new Date().toISOString(),
      };
    }
    return {
      peerId: trimmed,
      address: trimmed,
      age: 0,
      lastSeen: new Date().toISOString(),
    };
  });
}

function formatStatus(status: string): string {
  switch (status) {
    case "alive":
      return "[alive]";
    case "suspected":
      return "[SUSPECTED]";
    case "failed":
      return "[FAILED]";
    default:
      return `[${status}]`;
  }
}

function parseServerArgs(args: string[]): { server: string; json: boolean } {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    server: values.server ?? process.env.GROVE_SERVER ?? DEFAULT_SERVER,
    json: values.json ?? false,
  };
}

function parseDirectArgs(args: string[]): { peerUrl: string; peerId: string; json: boolean } {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "peer-id": { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const peerUrl = positionals[0];
  if (!peerUrl) {
    throw new Error("Usage: grove gossip <command> <peer-url> [--peer-id id]");
  }

  return {
    peerUrl,
    peerId: values["peer-id"] ?? `cli-${hostname()}-${process.pid}`,
    json: values.json ?? false,
  };
}

function printGossipUsage(writer: Writer = console.log): void {
  writer(`grove gossip — gossip protocol commands

Server query (connects to a running grove-server):
  grove gossip peers    [--server <url>]           List known peers
  grove gossip status   [--server <url>]           Show gossip overview
  grove gossip frontier [--server <url>]           Show merged frontier
  grove gossip watch    [--server <url>]           Stream gossip events (poll)

Direct gossip (CLI participates using local stores):
  grove gossip exchange <peer-url> [--peer-id id]  Push-pull frontier exchange
  grove gossip shuffle  <peer-url> [--peer-id id]  CYCLON peer sampling shuffle
  grove gossip sync     <seeds>    [--peer-id id]  Full round with seed peers

Persistent daemon (runs gossip loop with state persistence):
  grove gossip daemon   <seeds>    [--peer-id id] [--port port] [--interval s]

Peer management (local gossip store):
  grove gossip add-peer    <peerId@address>        Add peer to local store
  grove gossip remove-peer <peerId>                Remove peer from local store

Options:
  --server <url>   Server URL (default: GROVE_SERVER env or http://localhost:4515)
  --peer-id <id>   Local peer identity (default: cli-<hostname>-<pid>)
  --port <n>       Daemon listen port (default: 4516)
  --interval <s>   Gossip/poll interval in seconds (default: 30 daemon, 5 watch)
  --json           JSON output
  -h, --help       Show this help

Seeds format: peer1@http://host1:4515,peer2@http://host2:4515
`);
}
