#!/usr/bin/env bun

/**
 * Grove MCP server entry point — HTTP/SSE transport.
 *
 * Exposes the MCP server over HTTP using the Streamable HTTP transport from
 * the MCP SDK. Agents connect via HTTP POST (JSON-RPC requests) and receive
 * responses via Server-Sent Events (SSE).
 *
 * Usage:
 *   grove-mcp-http                          # listen on 0.0.0.0:4015
 *   PORT=8080 grove-mcp-http                # custom port
 *   GROVE_DIR=/path grove-mcp-http          # explicit grove directory
 *
 * Endpoints:
 *   POST /mcp   — JSON-RPC requests (initialize, tool calls, etc.)
 *   GET  /mcp   — SSE stream for server-initiated messages
 *   DELETE /mcp — Close a session
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { findGroveDir } from "../cli/context.js";
import { TopologyRouter } from "../core/topology-router.js";
import { createLocalRuntime } from "../local/runtime.js";
import { parsePort } from "../shared/env.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { McpDeps } from "./deps.js";
import { createMcpServer } from "./server.js";

// --- Security constants -----------------------------------------------------

/** Maximum allowed body size for incoming requests (10 MB). */
const MAX_MCP_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Optional shared-secret for authenticating requests.
 * When set, every request must include `Authorization: Bearer <token>`.
 * When unset, auth is skipped (backward compatible for local-only use).
 */
const AUTH_TOKEN = process.env.GROVE_MCP_AUTH_TOKEN ?? undefined;

// --- Initialization ---------------------------------------------------------

const groveOverride = process.env.GROVE_DIR ?? undefined;
const cwd = process.cwd();
const port = parsePort(process.env.PORT, 4015);

let deps: McpDeps;
let closeStores: () => void;

try {
  const groveDir = groveOverride ?? findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error("Not inside a grove. Run 'grove init' to create one, or set GROVE_DIR.");
  }

  // Skip the local contract parse in Nexus mode — the contract lives in the
  // Nexus session record and is loaded below. In local mode, createLocalRuntime
  // reads GROVE.md + local SQLite session config as usual.
  const nexusUrl = process.env.GROVE_NEXUS_URL;

  const runtime = createLocalRuntime({
    groveDir,
    frontierCacheTtlMs: 5_000,
    workspace: true,
    parseContract: !nexusUrl,
  });

  if (!runtime.workspace) {
    throw new Error("Workspace manager failed to initialize");
  }

  // Try Nexus stores when GROVE_NEXUS_URL is set — mirrors serve.ts setup.
  const nexusApiKey = process.env.NEXUS_API_KEY;
  const zoneId = process.env.GROVE_ZONE_ID ?? "default";
  // Read session ID from env first (set by parent TUI if available), then fall
  // back to a state file that the TUI writes when setSessionScope is called.
  // serve-http.ts is typically spawned before the session exists, so the state
  // file is the usual source of truth.
  const sessionId = (() => {
    const fromEnv = process.env.GROVE_SESSION_ID;
    if (fromEnv) return fromEnv;
    try {
      const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
      const sessionFile = `${groveDir}/current-session.json`;
      if (existsSync(sessionFile)) {
        const raw = JSON.parse(readFileSync(sessionFile, "utf-8")) as { sessionId?: string };
        return raw.sessionId;
      }
    } catch {
      /* ignore — fall through to undefined */
    }
    return undefined;
  })();

  let contributionStore = runtime.contributionStore as import("../core/store.js").ContributionStore;
  let claimStore = runtime.claimStore as import("../core/store.js").ClaimStore;
  let bountyStore = runtime.bountyStore as import("../core/bounty-store.js").BountyStore;
  let cas = runtime.cas as import("../core/cas.js").ContentStore;
  let nexusClient: import("../nexus/nexus-http-client.js").NexusHttpClient | undefined;
  let nexusHandoffStore: import("../nexus/nexus-handoff-store.js").NexusHandoffStore | undefined;
  let topologyRouter: TopologyRouter | undefined;

  if (nexusUrl) {
    try {
      const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
      const { NexusContributionStore } = await import("../nexus/nexus-contribution-store.js");
      const { NexusClaimStore } = await import("../nexus/nexus-claim-store.js");
      const { NexusBountyStore } = await import("../nexus/nexus-bounty-store.js");
      const { NexusCas } = await import("../nexus/nexus-cas.js");

      nexusClient = new NexusHttpClient({
        url: nexusUrl,
        ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
      });

      const health = await Promise.race([
        fetch(`${nexusUrl}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok),
        new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
      ]).catch(() => false);

      if (health) {
        contributionStore = new NexusContributionStore({
          client: nexusClient,
          zoneId,
          sessionId,
        });
        claimStore = new NexusClaimStore({ client: nexusClient, zoneId });
        bountyStore = new NexusBountyStore({ client: nexusClient, zoneId });
        cas = new NexusCas({ client: nexusClient, zoneId });
        const { NexusHandoffStore } = await import("../nexus/nexus-handoff-store.js");
        nexusHandoffStore = new NexusHandoffStore(nexusClient, sessionId, zoneId);
        process.stderr.write(`grove-mcp-http: using Nexus stores at ${nexusUrl}\n`);
      } else {
        process.stderr.write(`grove-mcp-http: Nexus unreachable, using local stores\n`);
        nexusClient = undefined;
      }
    } catch (err) {
      process.stderr.write(`grove-mcp-http: Nexus setup failed, using local stores: ${err}\n`);
    }
  }

  // Load contract: in Nexus mode, from the Nexus session record. In local mode,
  // createLocalRuntime already populated runtime.contract from GROVE.md + local DB.
  let loadedContract: import("../core/contract.js").GroveContract | undefined = runtime.contract;
  if (nexusClient && !loadedContract && sessionId) {
    try {
      const { NexusSessionStore } = await import("../nexus/nexus-session-store.js");
      const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);
      const session = await nexusSessionStore.getSession(sessionId);
      if (session?.config) {
        loadedContract = session.config;
        process.stderr.write(
          `grove-mcp-http: loaded full contract from Nexus session ${sessionId}\n`,
        );
      } else if (session?.topology) {
        // Backwards-compat: older session records have only topology.
        loadedContract = {
          contractVersion: 1,
          name: session.presetName ?? "nexus-session",
          mode: "exploration",
          topology: session.topology,
        };
        process.stderr.write(
          `grove-mcp-http: Nexus session ${sessionId} missing config; ` +
            `reconstructed minimal contract from topology (rate limits NOT enforced)\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `grove-mcp-http: failed to load Nexus session config: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (loadedContract !== undefined) {
    const { EnforcingContributionStore } = await import("../core/enforcing-store.js");
    contributionStore = new EnforcingContributionStore(contributionStore, loadedContract, { cas });
  }

  if (loadedContract?.topology && nexusClient) {
    const { NexusEventBus } = await import("../nexus/nexus-event-bus.js");
    const eventBus = new NexusEventBus(nexusClient, zoneId);
    topologyRouter = new TopologyRouter(loadedContract.topology, eventBus);
    process.stderr.write(`grove-mcp-http: IPC via Nexus EventBus at ${nexusUrl}\n`);
  }

  deps = {
    contributionStore,
    claimStore,
    bountyStore,
    cas,
    frontier: runtime.frontier,
    workspace: runtime.workspace,
    contract: loadedContract,
    onContributionWrite: runtime.onContributionWrite,
    workspaceBoundary: runtime.groveRoot,
    ...(nexusHandoffStore ? { handoffStore: nexusHandoffStore } : {}),
    ...(topologyRouter ? { topologyRouter } : {}),
  };
  closeStores = () => runtime.close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`grove-mcp-http: ${message}\n`);
  process.exit(1);
}

// --- Session management -----------------------------------------------------

/** Idle timeout before a session is reaped (default 30 min). */
const SESSION_TTL_MS = (() => {
  const raw = Number.parseInt(process.env.MCP_SESSION_TTL_MS ?? "1800000", 10);
  if (Number.isNaN(raw) || raw <= 0) {
    process.stderr.write(
      `grove-mcp-http: invalid MCP_SESSION_TTL_MS '${process.env.MCP_SESSION_TTL_MS}', using default 1800000\n`,
    );
    return 1_800_000;
  }
  return raw;
})();

/** How often the reaper sweeps for stale sessions. Adapts to low TTLs. */
const REAP_INTERVAL_MS = Math.min(60_000, Math.floor(SESSION_TTL_MS / 3));

interface ManagedSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

/** Map of session ID → managed session for active sessions. */
const sessions = new Map<string, ManagedSession>();

/** Periodically close sessions that have been idle longer than SESSION_TTL_MS. */
const reapTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      void safeCleanup(session.server.close(), "reap idle MCP session", { silent: true });
      sessions.delete(id);
    }
  }
}, REAP_INTERVAL_MS);

// --- HTTP server ------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";

  // Only handle /mcp endpoint
  if (url !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use /mcp endpoint." }));
    return;
  }

  // Shared-secret authentication (when configured)
  if (AUTH_TOKEN !== undefined) {
    const authHeader = req.headers.authorization ?? "";
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // Parse session ID from header
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    // Read body (with size limit to prevent DoS)
    let body: string;
    try {
      body = await readBody(req, MAX_MCP_BODY_SIZE);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // If we have a session ID, route to existing session
    const existingSession = sessionId ? sessions.get(sessionId) : undefined;
    if (existingSession) {
      existingSession.lastActivity = Date.now();
      await existingSession.transport.handleRequest(req, res, parsed);
      return;
    }

    // New session — create server + transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, lastActivity: Date.now() });
      },
    });
    const server = await createMcpServer(deps);

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
      }
    };

    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, parsed);
  } else if (req.method === "GET") {
    // SSE stream for server-initiated messages
    const getSession = sessionId ? sessions.get(sessionId) : undefined;
    if (!getSession) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid Mcp-Session-Id header" }));
      return;
    }
    getSession.lastActivity = Date.now();
    // Keep the session alive while the SSE stream is open. Without this,
    // long-lived GET streams would be reaped as "idle" even though the
    // client is actively waiting for server-initiated messages.
    const keepAlive = setInterval(() => {
      getSession.lastActivity = Date.now();
    }, REAP_INTERVAL_MS / 2);
    res.on("close", () => clearInterval(keepAlive));
    await getSession.transport.handleRequest(req, res);
  } else if (req.method === "DELETE") {
    // Close session
    const delSession = sessionId ? sessions.get(sessionId) : undefined;
    if (!delSession) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
    await delSession.transport.handleRequest(req, res);
    await delSession.server.close();
    if (sessionId) sessions.delete(sessionId);
  } else {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  }
}

class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage, maxBytes: number = MAX_MCP_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejected = true;
        // Drain remaining data without accumulating it, so the
        // socket stays open long enough for us to send a 413 response.
        req.resume();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    process.stderr.write(`grove-mcp-http: ${String(error)}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});

httpServer.listen(port, () => {
  process.stderr.write(`grove-mcp-http: listening on http://0.0.0.0:${port}/mcp\n`);
});

// Graceful shutdown
const shutdown = async (): Promise<void> => {
  clearInterval(reapTimer);
  // Close all active sessions
  for (const [, session] of sessions) {
    await session.server.close();
  }
  sessions.clear();
  httpServer.close();
  closeStores();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
