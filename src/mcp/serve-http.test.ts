/**
 * Tests for MCP HTTP session management.
 *
 * Spins up a real HTTP server using the same session management logic as
 * serve-http.ts, backed by test deps. Exercises HTTP routing, session
 * creation/reuse/deletion, TTL-based reaping, and error responses.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpDeps } from "./deps.js";
import { createMcpServer } from "./server.js";
import type { TestMcpDeps } from "./test-helpers.js";
import { createTestMcpDeps } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Session management (mirrors serve-http.ts logic)
// ---------------------------------------------------------------------------

interface ManagedSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

interface TestServerContext {
  httpServer: Server;
  baseUrl: string;
  sessions: Map<string, ManagedSession>;
  reapTimer: ReturnType<typeof setInterval> | undefined;
  deps: McpDeps;
}

/**
 * Build a minimal HTTP server that reproduces the session management logic
 * from serve-http.ts so we can test it in isolation.
 */
function buildTestServer(deps: McpDeps, sessionTtlMs: number): TestServerContext {
  const sessions = new Map<string, ManagedSession>();

  // Mirror production: reap interval = min(60s, TTL/3).
  const reapIntervalMs = Math.min(60_000, Math.floor(sessionTtlMs / 3));

  const reapTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > sessionTtlMs) {
        session.server.close().catch(() => {});
        sessions.delete(id);
      }
    }
  }, reapIntervalMs);

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";

    if (url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use /mcp endpoint." }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const existingSession = sessionId ? sessions.get(sessionId) : undefined;
      if (existingSession) {
        existingSession.lastActivity = Date.now();
        await existingSession.transport.handleRequest(req, res, parsed);
        return;
      }

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
      const getSession = sessionId ? sessions.get(sessionId) : undefined;
      if (!getSession) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid Mcp-Session-Id header" }));
        return;
      }
      getSession.lastActivity = Date.now();
      // Mirror production: keep SSE sessions alive while stream is open.
      const keepAlive = setInterval(() => {
        getSession.lastActivity = Date.now();
      }, reapIntervalMs / 2);
      res.on("close", () => clearInterval(keepAlive));
      await getSession.transport.handleRequest(req, res);
    } else if (req.method === "DELETE") {
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

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((_error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  return { httpServer, baseUrl: "", sessions, reapTimer, deps };
}

/** Start server on port 0 (OS picks a free port) and return the base URL. */
function startServer(ctx: TestServerContext): Promise<string> {
  return new Promise((resolve) => {
    ctx.httpServer.listen(0, "127.0.0.1", () => {
      const addr = ctx.httpServer.address();
      if (addr && typeof addr === "object") {
        ctx.baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve(ctx.baseUrl);
    });
  });
}

/** Gracefully stop the server and clean up sessions. */
async function stopServer(ctx: TestServerContext): Promise<void> {
  if (ctx.reapTimer) clearInterval(ctx.reapTimer);
  for (const [, session] of ctx.sessions) {
    await session.server.close().catch(() => {});
  }
  ctx.sessions.clear();
  await new Promise<void>((resolve) => ctx.httpServer.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

const INIT_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP HTTP session management", () => {
  let testDeps: TestMcpDeps;
  let ctx: TestServerContext;

  beforeAll(async () => {
    testDeps = await createTestMcpDeps();
    ctx = buildTestServer(testDeps.deps, 30 * 60 * 1000); // 30 min TTL (won't fire during tests)
    await startServer(ctx);
  });

  afterAll(async () => {
    await stopServer(ctx);
    await testDeps.cleanup();
  });

  // ---- Session creation ---------------------------------------------------

  test("POST /mcp with initialize request creates a session and returns Mcp-Session-Id", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT_REQUEST),
    });

    // The StreamableHTTPServerTransport returns 200 for successful initialize
    expect(res.status).toBe(200);

    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");

    // Session should now exist in the sessions map
    expect(ctx.sessions.has(sessionId as string)).toBe(true);
  });

  // ---- Session reuse ------------------------------------------------------

  test("POST /mcp with existing Mcp-Session-Id reuses the session", async () => {
    // Create a session first
    const initRes = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT_REQUEST),
    });

    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const sessionCountBefore = ctx.sessions.size;

    // Send a tools/list request using the same session
    const listToolsRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };

    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId as string,
      },
      body: JSON.stringify(listToolsRequest),
    });

    expect(res.status).toBe(200);
    // No new session created — count should be unchanged
    expect(ctx.sessions.size).toBe(sessionCountBefore);
  });

  // ---- 404 on wrong endpoint ----------------------------------------------

  test("GET /foo returns 404", async () => {
    const res = await fetch(`${ctx.baseUrl}/foo`, { method: "GET" });
    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Not found");
  });

  test("POST /unknown returns 404", async () => {
    const res = await fetch(`${ctx.baseUrl}/unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INIT_REQUEST),
    });
    expect(res.status).toBe(404);
  });

  // ---- 405 on unsupported methods -----------------------------------------

  test("PUT /mcp returns 405", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Method not allowed");
  });

  test("PATCH /mcp returns 405", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Method not allowed");
  });

  // ---- Invalid JSON -------------------------------------------------------

  test("POST /mcp with invalid JSON returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Invalid JSON");
  });

  // ---- DELETE session -----------------------------------------------------

  test("DELETE /mcp with valid session ID removes the session", async () => {
    // Create a session
    const initRes = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT_REQUEST),
    });

    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(ctx.sessions.has(sessionId as string)).toBe(true);

    // Delete the session
    const deleteRes = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionId as string },
    });

    // StreamableHTTPServerTransport handles DELETE and returns a response
    expect(deleteRes.status).toBeLessThan(500);

    // Session should be removed from the map
    expect(ctx.sessions.has(sessionId as string)).toBe(false);
  });

  test("DELETE /mcp without session ID returns 404", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Session not found");
  });

  test("DELETE /mcp with non-existent session ID returns 404", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": "non-existent-session-id" },
    });
    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Session not found");
  });

  // ---- GET /mcp without session -------------------------------------------

  test("GET /mcp without session ID returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, { method: "GET" });
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Missing or invalid Mcp-Session-Id");
  });

  test("GET /mcp with non-existent session ID returns 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "GET",
      headers: { "Mcp-Session-Id": "bogus-id" },
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Missing or invalid Mcp-Session-Id");
  });

  // ---- Invalid session ID on POST ----------------------------------------

  test("POST /mcp with non-existent session ID creates a new session", async () => {
    const countBefore = ctx.sessions.size;

    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "does-not-exist",
      },
      body: JSON.stringify(INIT_REQUEST),
    });

    expect(res.status).toBe(200);

    const newSessionId = res.headers.get("mcp-session-id");
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe("does-not-exist");
    // A new session should have been created
    expect(ctx.sessions.size).toBeGreaterThan(countBefore);
  });
});

// ---------------------------------------------------------------------------
// TTL reaping tests — use a very short TTL to test cleanup
// ---------------------------------------------------------------------------

describe("MCP HTTP session TTL reaping", () => {
  let testDeps: TestMcpDeps;
  let ctx: TestServerContext;

  beforeAll(async () => {
    testDeps = await createTestMcpDeps();
    // Use a very short TTL (100ms) so sessions expire quickly
    ctx = buildTestServer(testDeps.deps, 100);
    await startServer(ctx);
  });

  afterAll(async () => {
    await stopServer(ctx);
    await testDeps.cleanup();
  });

  test("idle sessions are reaped after TTL expires", async () => {
    // Create a session
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT_REQUEST),
    });

    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(ctx.sessions.has(sessionId as string)).toBe(true);

    // Wait for the TTL + reap interval to pass (TTL=100ms, reap interval=50ms)
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Session should have been reaped
    expect(ctx.sessions.has(sessionId as string)).toBe(false);
  });

  test("active sessions are NOT reaped if they have recent activity", async () => {
    // Create a session
    const initRes = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT_REQUEST),
    });

    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // Keep the session alive by sending activity within the TTL
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Send activity to refresh lastActivity
    const listRequest = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId as string,
      },
      body: JSON.stringify(listRequest),
    });

    // Wait a little more (but less than TTL from last activity)
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Session should still be alive since we refreshed it
    expect(ctx.sessions.has(sessionId as string)).toBe(true);

    // Now wait long enough for it to expire (TTL=100ms from last activity)
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Now it should be reaped
    expect(ctx.sessions.has(sessionId as string)).toBe(false);
  });
});
