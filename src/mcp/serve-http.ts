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
import { join } from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { findGroveDir } from "../cli/context.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { FsCas } from "../local/fs-cas.js";
import { initSqliteDb, SqliteClaimStore, SqliteContributionStore } from "../local/sqlite-store.js";
import { LocalWorkspaceManager } from "../local/workspace.js";
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
  const cas = new FsCas(casPath);
  const frontier = new DefaultFrontierCalculator(contributionStore);
  const workspace = new LocalWorkspaceManager({
    groveRoot: groveDir,
    db,
    contributionStore,
    cas,
  });

  deps = { contributionStore, claimStore, cas, frontier, workspace };
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

/** Map of session ID → { server, transport } for active sessions. */
const sessions = new Map<
  string,
  { server: ReturnType<typeof createMcpServer>; transport: StreamableHTTPServerTransport }
>();

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
      await existingSession.transport.handleRequest(req, res, parsed);
      return;
    }

    // New session — create server + transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });
    const server = createMcpServer(deps);

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
