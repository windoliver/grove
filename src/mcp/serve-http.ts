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

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { findGroveDir } from "../cli/context.js";
import { parseGroveContract } from "../core/contract.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { CachedFrontierCalculator } from "../gossip/cached-frontier.js";
import { FsCas } from "../local/fs-cas.js";
import { SqliteBountyStore } from "../local/sqlite-bounty-store.js";
import { initSqliteDb, SqliteClaimStore, SqliteContributionStore } from "../local/sqlite-store.js";
import { LocalWorkspaceManager } from "../local/workspace.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { McpDeps } from "./deps.js";
import { createMcpServer } from "./server.js";

// --- Initialization ---------------------------------------------------------

const groveOverride = process.env.GROVE_DIR ?? undefined;
const cwd = process.cwd();
const port = Number.parseInt(process.env.PORT ?? "4015", 10);

let deps: McpDeps;
let closeStores: () => void;

try {
  const groveDir = groveOverride ?? findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error("Not inside a grove. Run 'grove init' to create one, or set GROVE_DIR.");
  }

  const dbPath = join(groveDir, "grove.db");
  const casPath = join(groveDir, "cas");

  const db = initSqliteDb(dbPath);
  const contributionStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const bountyStore = new SqliteBountyStore(db);
  const cas = new FsCas(casPath);
  const baseFrontier = new DefaultFrontierCalculator(contributionStore);
  const frontier = new CachedFrontierCalculator(baseFrontier, 5_000);
  const workspace = new LocalWorkspaceManager({
    groveRoot: groveDir,
    db,
    contributionStore,
    cas,
  });

  // Parse GROVE.md contract if it exists — fail on malformed contracts
  const groveContractPath = join(groveDir, "..", "GROVE.md");
  const contract = existsSync(groveContractPath)
    ? parseGroveContract(readFileSync(groveContractPath, "utf-8"))
    : undefined;

  // Note: creditsService is intentionally omitted — see serve.ts for rationale.
  deps = {
    contributionStore,
    claimStore,
    bountyStore,
    cas,
    frontier,
    workspace,
    contract,
    onContributionWrite: () => frontier.invalidate(),
  };
  closeStores = () => {
    workspace.close();
    db.close();
  };
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

  // Parse session ID from header
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    // Read body
    const body = await readBody(req);
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
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
