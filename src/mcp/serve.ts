#!/usr/bin/env bun
/**
 * Grove MCP server entry point — stdio transport.
 *
 * Discovers the .grove directory, initializes stores, creates the MCP server,
 * and connects it to a StdioServerTransport. Designed to be spawned by
 * Claude Code, Codex, Cline, Goose, Copilot, or any MCP-compatible agent.
 *
 * Usage:
 *   grove-mcp                    # auto-discover .grove in cwd or parent dirs
 *   GROVE_DIR=/path grove-mcp    # explicit grove directory
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { findGroveDir } from "../cli/context.js";
import { TopologyRouter } from "../core/topology-router.js";
import { createLocalRuntime } from "../local/runtime.js";
import type { McpDeps } from "./deps.js";
import { createMcpServer } from "./server.js";

// --- Initialization (eager — catches config errors at startup) ------------

const groveOverride = process.env.GROVE_DIR ?? undefined;
const cwd = process.cwd();

let deps: McpDeps;
let close: () => void;

try {
  const groveDir = groveOverride ?? findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error("Not inside a grove. Run 'grove init' to create one, or set GROVE_DIR.");
  }

  const nexusUrl = process.env.GROVE_NEXUS_URL;
  const nexusApiKey = process.env.NEXUS_API_KEY;

  // Always create local runtime for workspace, contract, frontier, CAS
  const runtime = createLocalRuntime({
    groveDir,
    frontierCacheTtlMs: 5_000,
    workspace: true,
    parseContract: true,
  });

  if (!runtime.workspace) {
    throw new Error("Workspace manager failed to initialize");
  }

  // When Nexus URL is set, use ALL Nexus stores so everything flows through Nexus VFS
  let contributionStore = runtime.contributionStore as import("../core/store.js").ContributionStore;
  let claimStore = runtime.claimStore as import("../core/store.js").ClaimStore;
  let bountyStore = runtime.bountyStore as import("../core/bounty-store.js").BountyStore;
  let outcomeStore: import("../core/outcome.js").OutcomeStore | undefined;
  let cas = runtime.cas as import("../core/cas.js").ContentStore;
  let nexusClient: import("../nexus/nexus-http-client.js").NexusHttpClient | undefined;
  const zoneId = process.env.GROVE_ZONE_ID ?? "default";

  if (nexusUrl) {
    const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
    const { NexusContributionStore } = await import("../nexus/nexus-contribution-store.js");
    const { NexusClaimStore } = await import("../nexus/nexus-claim-store.js");
    const { NexusBountyStore } = await import("../nexus/nexus-bounty-store.js");
    const { NexusOutcomeStore } = await import("../nexus/nexus-outcome-store.js");
    const { NexusCas } = await import("../nexus/nexus-cas.js");

    nexusClient = new NexusHttpClient({
      url: nexusUrl,
      ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
    });

    contributionStore = new NexusContributionStore({ client: nexusClient, zoneId });
    claimStore = new NexusClaimStore({ client: nexusClient, zoneId });
    bountyStore = new NexusBountyStore({ client: nexusClient, zoneId });
    outcomeStore = new NexusOutcomeStore({ client: nexusClient, zoneId });
    cas = new NexusCas({ client: nexusClient, zoneId });
    process.stderr.write(`grove-mcp: using Nexus stores at ${nexusUrl} (zone: ${zoneId})\n`);
  }

  // Wire EventBus + TopologyRouter for IPC when topology exists
  let eventBus: import("../core/event-bus.js").EventBus | undefined;
  let topologyRouter: TopologyRouter | undefined;

  if (runtime.contract?.topology) {
    if (nexusClient) {
      const { NexusEventBus } = await import("../nexus/nexus-event-bus.js");
      eventBus = new NexusEventBus(nexusClient, zoneId);
    } else {
      const { LocalEventBus } = await import("../core/local-event-bus.js");
      eventBus = new LocalEventBus();
    }
    topologyRouter = new TopologyRouter(runtime.contract.topology, eventBus);
  }

  deps = {
    contributionStore,
    claimStore,
    bountyStore,
    cas,
    frontier: runtime.frontier,
    workspace: runtime.workspace,
    contract: runtime.contract,
    onContributionWrite: runtime.onContributionWrite,
    workspaceBoundary: runtime.groveRoot,
    ...(outcomeStore ? { outcomeStore } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(topologyRouter ? { topologyRouter } : {}),
  };
  close = () => {
    eventBus?.close();
    nexusClient?.close();
    runtime.close();
  };
} catch (error) {
  // Write to stderr (stdout is reserved for MCP JSON-RPC)
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`grove-mcp: ${message}\n`);
  process.exit(1);
}

// --- Server setup ---------------------------------------------------------

const server = await createMcpServer(deps);
const transport = new StdioServerTransport();

await server.connect(transport);

// Graceful shutdown
const shutdown = async (): Promise<void> => {
  await server.close();
  close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
