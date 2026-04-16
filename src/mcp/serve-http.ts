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

let groveDir!: string;
let runtime!: ReturnType<typeof createLocalRuntime>;
let nexusUrl: string | undefined;
let nexusApiKey: string | undefined;
let zoneId = "default";
let nexusClient: import("../nexus/nexus-http-client.js").NexusHttpClient | undefined;
// biome-ignore lint/suspicious/noEmptyBlockStatements: default no-op replaced in try block
let closeStores: () => void = () => {};

try {
  const resolvedGroveDir = groveOverride ?? findGroveDir(cwd);
  if (resolvedGroveDir === undefined) {
    throw new Error("Not inside a grove. Run 'grove init' to create one, or set GROVE_DIR.");
  }
  groveDir = resolvedGroveDir;

  // Skip the local contract parse in Nexus mode — the contract lives in the
  // Nexus session record and is loaded per-request inside resolveDeps below.
  nexusUrl = process.env.GROVE_NEXUS_URL;

  runtime = createLocalRuntime({
    groveDir,
    frontierCacheTtlMs: 5_000,
    workspace: true,
    parseContract: !nexusUrl,
  });

  if (!runtime.workspace) {
    throw new Error("Workspace manager failed to initialize");
  }

  nexusApiKey = process.env.NEXUS_API_KEY;
  zoneId = process.env.GROVE_ZONE_ID ?? "default";

  if (nexusUrl) {
    try {
      const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
      nexusClient = new NexusHttpClient({
        url: nexusUrl,
        ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
      });
      const health = await Promise.race([
        fetch(`${nexusUrl}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok),
        new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
      ]).catch(() => false);
      if (!health) {
        // Match serve.ts: fail closed when the operator explicitly pointed us
        // at a Nexus that isn't available. Falling back to local SQLite here
        // would split-brain writes between Nexus (used by the TUI and stdio
        // MCP agents) and this HTTP MCP process, silently bypassing session
        // scoping and handoff routing.
        process.stderr.write(
          `grove-mcp-http: FATAL: GROVE_NEXUS_URL=${nexusUrl} is set but health check failed. ` +
            `Refusing to fall back to local stores. Verify Nexus is reachable and retry.\n`,
        );
        process.exit(1);
      }
      process.stderr.write(`grove-mcp-http: Nexus client ready at ${nexusUrl}\n`);
    } catch (err) {
      // Configured Nexus that throws during setup is a hard failure. Exit so
      // the parent can surface the real error instead of silently downgrading.
      process.stderr.write(
        `grove-mcp-http: FATAL: Nexus setup failed for ${nexusUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  closeStores = () => runtime.close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`grove-mcp-http: ${message}\n`);
  process.exit(1);
}

// --- Dynamic session-scoped deps --------------------------------------------
//
// The HTTP MCP server is spawned before any interactive session exists, so we
// cannot bake a session ID into the stores at startup. We resolve the current
// session ID lazily on each incoming request by re-reading
// `${groveDir}/current-session.json` (written by the TUI on setSessionScope).
// Session-scoped stores (NexusContributionStore, NexusHandoffStore,
// EnforcingContributionStore, TopologyRouter) are built the first time we see
// a given session ID and cached. When the state file advances to a new
// session ID the old cache entry is discarded so a resumed or restarted TUI
// never inherits stale routing state.

interface ScopedDeps {
  readonly deps: McpDeps;
  readonly sessionId: string | undefined;
  /**
   * Cleanup for scoped per-session resources (DeadlineWatcher timers,
   * scoped EventBus, etc.). Must be invoked on cache eviction and session
   * invalidation/reap so timers cannot outlive their session and emit
   * cross-session overdue events.
   */
  readonly close: () => void;
}

/**
 * Error raised when the current-session state file exists but cannot be
 * parsed or read. Distinct from "file absent" (a valid pre-session state)
 * so the caller can fail closed on corrupted state instead of silently
 * falling through to unscoped stores.
 */
class SessionStateReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStateReadError";
  }
}

const depsCache = new Map<string, ScopedDeps>();
let lastSessionFileMtimeMs = -1;
let lastSessionFileId: string | undefined;

/**
 * Read the current grove session ID from env or state file.
 *
 * Returns `undefined` ONLY when no session has been created yet (env var is
 * unset AND the state file does not exist). Throws `SessionStateReadError`
 * when the state file is present but unreadable or unparseable — callers
 * must decide whether to fail closed (Nexus mode) or tolerate the error.
 *
 * Caching semantics: we only update the cached mtime/sessionId after a
 * SUCCESSFUL parse. A parse failure leaves the cache untouched so that
 * every subsequent call re-runs the read against the current mtime — the
 * caller keeps seeing errors until the writer either fixes the file or
 * produces a new mtime with valid JSON.
 */
function readCurrentSessionId(): string | undefined {
  const fromEnv = process.env.GROVE_SESSION_ID;
  if (fromEnv) return fromEnv;
  const { existsSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
  const sessionFile = `${groveDir}/current-session.json`;
  if (!existsSync(sessionFile)) return undefined;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(sessionFile);
  } catch (err) {
    throw new SessionStateReadError(
      `stat ${sessionFile} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (stat.mtimeMs === lastSessionFileMtimeMs && lastSessionFileMtimeMs > 0) {
    return lastSessionFileId;
  }
  let raw: { sessionId?: string };
  try {
    raw = JSON.parse(readFileSync(sessionFile, "utf-8")) as { sessionId?: string };
  } catch (err) {
    // Do NOT update the cache — leave lastSessionFileMtimeMs/lastSessionFileId
    // untouched so the next call re-reads. Otherwise a single torn-write
    // during a concurrent session switch would poison the cache and every
    // subsequent request would read the stale (or undefined) session id
    // without surfacing the error.
    throw new SessionStateReadError(
      `read/parse ${sessionFile} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Success — commit to cache.
  lastSessionFileMtimeMs = stat.mtimeMs;
  lastSessionFileId = raw.sessionId;
  return raw.sessionId;
}

async function buildScopedDeps(sessionId: string | undefined): Promise<ScopedDeps> {
  let contributionStore = runtime.contributionStore as import("../core/store.js").ContributionStore;
  let claimStore = runtime.claimStore as import("../core/store.js").ClaimStore;
  let bountyStore = runtime.bountyStore as import("../core/bounty-store.js").BountyStore;
  let cas = runtime.cas as import("../core/cas.js").ContentStore;
  let nexusHandoffStore: import("../nexus/nexus-handoff-store.js").NexusHandoffStore | undefined;
  let topologyRouter: TopologyRouter | undefined;
  let loadedContract: import("../core/contract.js").GroveContract | undefined = runtime.contract;

  if (nexusClient) {
    const { NexusContributionStore } = await import("../nexus/nexus-contribution-store.js");
    const { NexusClaimStore } = await import("../nexus/nexus-claim-store.js");
    const { NexusBountyStore } = await import("../nexus/nexus-bounty-store.js");
    const { NexusCas } = await import("../nexus/nexus-cas.js");
    const { NexusHandoffStore } = await import("../nexus/nexus-handoff-store.js");

    contributionStore = new NexusContributionStore({ client: nexusClient, zoneId, sessionId });
    claimStore = new NexusClaimStore({ client: nexusClient, zoneId });
    bountyStore = new NexusBountyStore({ client: nexusClient, zoneId });
    cas = new NexusCas({ client: nexusClient, zoneId });
    nexusHandoffStore = new NexusHandoffStore(nexusClient, sessionId, zoneId);

    if (sessionId && !loadedContract) {
      const { NexusSessionStore } = await import("../nexus/nexus-session-store.js");
      const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);
      // Retry briefly in case the TUI session mirror is still in flight.
      const retryDelaysMs = [0, 100, 250, 500, 1000];
      let sessionRecord: import("../core/session.js").Session | undefined;
      for (const delay of retryDelaysMs) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        sessionRecord = await nexusSessionStore.getSession(sessionId).catch(() => undefined);
        if (sessionRecord?.config) break;
      }
      // Policy matches serve.ts: default to weak (compatible) fallback,
      // opt into strict via GROVE_MCP_STRICT_CONTRACT=1. See serve.ts for
      // rationale — legacy sessions created without a frozen contract
      // must still work, while operators can tighten the policy once
      // every session-creation path is emitting config.
      const strictContract = process.env.GROVE_MCP_STRICT_CONTRACT === "1";

      if (sessionRecord?.config) {
        loadedContract = sessionRecord.config;
        process.stderr.write(
          `grove-mcp-http: loaded full contract from Nexus session ${sessionId}\n`,
        );
      } else if (sessionRecord?.topology && !strictContract) {
        loadedContract = {
          contractVersion: 1,
          name: sessionRecord.presetName ?? "nexus-session",
          mode: "exploration",
          topology: sessionRecord.topology,
        };
        process.stderr.write(
          `grove-mcp-http: WARN: Nexus session ${sessionId} has no frozen config — ` +
            `using topology-only contract (enforcement NOT applied). Set ` +
            `GROVE_MCP_STRICT_CONTRACT=1 to fail closed here.\n`,
        );
      } else if (sessionRecord?.topology) {
        throw new Error(
          `grove-mcp-http: GROVE_MCP_STRICT_CONTRACT=1 and Nexus session ${sessionId} ` +
            `has no frozen config. Recreate the session with the current TUI.`,
        );
      } else {
        // Session ID set but no record found in Nexus. Fail closed — the
        // Nexus store adapters would happily create VFS paths under the
        // bogus ID (see vfs-paths.ts contributionPath/sessionPath) and
        // orphan writes under /zones/.../sessions/<bogus>/... without
        // matching session metadata. That's strictly worse than refusing
        // to handle the request, which the HTTP layer converts into a
        // SESSION_NOT_READY 503.
        throw new Error(
          `grove-mcp-http: cannot scope to session ${sessionId} — no record in Nexus. ` +
            `Ensure the TUI session mirror has completed (it is awaited by ` +
            `nexus-provider.createSession) or remove the stale session id from ` +
            `${groveDir}/current-session.json.`,
        );
      }
    }
  }

  if (loadedContract !== undefined) {
    const { EnforcingContributionStore } = await import("../core/enforcing-store.js");
    contributionStore = new EnforcingContributionStore(contributionStore, loadedContract, { cas });
  }

  // Wire EventBus + TopologyRouter for IPC when topology exists.
  // Mirrors serve.ts: use NexusEventBus when Nexus is available,
  // otherwise fall back to LocalEventBus for local-mode routing.
  let eventBus: import("../core/event-bus.js").EventBus | undefined;
  if (loadedContract?.topology) {
    if (nexusClient) {
      const { NexusEventBus } = await import("../nexus/nexus-event-bus.js");
      eventBus = new NexusEventBus(nexusClient, zoneId);
    } else {
      const { LocalEventBus } = await import("../core/local-event-bus.js");
      eventBus = new LocalEventBus();
    }
    topologyRouter = new TopologyRouter(loadedContract.topology, eventBus);
  }

  // Wire DeadlineWatcher for proactive overdue detection when both
  // a handoff store and event bus are available.
  let deadlineWatcher: import("../core/deadline-watcher.js").DeadlineWatcher | undefined;
  const activeHandoffStore = nexusHandoffStore ?? runtime.handoffStore;
  if (activeHandoffStore !== undefined && eventBus !== undefined) {
    const { DeadlineWatcher } = await import("../core/deadline-watcher.js");
    deadlineWatcher = new DeadlineWatcher({ handoffStore: activeHandoffStore, eventBus });
    void deadlineWatcher.rebuildFromStore().catch(() => {
      /* non-fatal */
    });
  }

  const deps: McpDeps = {
    contributionStore,
    claimStore,
    bountyStore,
    cas,
    frontier: runtime.frontier,
    // biome-ignore lint/style/noNonNullAssertion: checked above (workspace guard throws if undefined)
    workspace: runtime.workspace!,
    contract: loadedContract,
    onContributionWrite: runtime.onContributionWrite,
    workspaceBoundary: runtime.groveRoot,
    goalSessionStore: runtime.goalSessionStore,
    ...(eventBus ? { eventBus } : {}),
    ...(topologyRouter ? { topologyRouter } : {}),
    // Nexus handoff store when available, falls back to local SQLite
    handoffStore: activeHandoffStore,
    idempotencyStore: runtime.idempotencyStore,
    ...(deadlineWatcher ? { deadlineWatcher } : {}),
  };
  const close = () => {
    deadlineWatcher?.close();
    // eventBus is shared with the TUI/other surfaces for Nexus-backed IPC,
    // so don't close it here — only per-scope resources.
  };
  return { deps, sessionId, close };
}

async function resolveDeps(): Promise<ScopedDeps> {
  let sessionId: string | undefined;
  try {
    sessionId = readCurrentSessionId();
  } catch (err) {
    // The state file EXISTS but is corrupted. Refuse to continue in Nexus
    // mode — silently building unscoped stores would accept writes that
    // bypass contract enforcement and leak across sessions. In local mode
    // we still fail hard because a malformed state file is a bug, not a
    // normal bootstrap state.
    throw new Error(
      `grove-mcp-http: refusing to scope session — ${err instanceof Error ? err.message : String(err)}. ` +
        `Fix or remove ${groveDir}/current-session.json and retry.`,
    );
  }

  // When no session exists yet (sessionId === undefined), fall into a
  // degraded "bootstrap" mode that serves read-only tools against the
  // zone-global path. The HTTP MCP server is started by `grove up` before
  // any interactive session is created, and external MCP clients
  // (Cursor, Claude Desktop) may connect for tool introspection during
  // that window. Returning 503 for the entire server would break that
  // use case.
  //
  // Mutating grove_submit_work / grove_cas_put calls will still fail at
  // the store layer in Nexus mode (no session id → wrong path), which is
  // the correct failure mode for "did not select a session yet". The
  // coder→reviewer loop is unaffected because the TUI spawns agents via
  // stdio MCP (serve.ts) which has GROVE_SESSION_ID in its env, not via
  // this HTTP endpoint.
  if (!sessionId) {
    process.stderr.write(
      `grove-mcp-http: no grove session selected — serving in bootstrap mode ` +
        `(reads work against the zone-global path, writes will be session-less). ` +
        `Start a session via the TUI to enable full routing.\n`,
    );
  }

  const key = sessionId ?? "__bootstrap__";
  const cached = depsCache.get(key);
  if (cached) return cached;
  // A new session id invalidates the entire cache so we never mix scopes.
  // Close each evicted entry's scoped resources (timers, watchers) so
  // they cannot outlive the session they were bound to.
  for (const prev of depsCache.values()) {
    try {
      prev.close();
    } catch {
      // best-effort
    }
  }
  depsCache.clear();
  const scoped = await buildScopedDeps(sessionId);
  depsCache.set(key, scoped);
  return scoped;
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
  /** The grove session ID these stores are bound to (undefined = bootstrap). */
  groveSessionId: string | undefined;
}

/** Map of MCP-session ID → managed session for active sessions. */
const sessions = new Map<string, ManagedSession>();

/**
 * Invalidate all MCP sessions bound to a grove session other than `current`.
 * Called on every POST before routing to catch a grove session switch. The
 * McpServer captures its deps at construction, so when the grove session
 * changes we cannot simply swap stores — we must close the old MCP session
 * and force the client to re-initialize against fresh scoped deps.
 */
function invalidateStaleSessions(current: string | undefined): void {
  for (const [id, session] of sessions) {
    if (session.groveSessionId !== current) {
      void safeCleanup(session.server.close(), "invalidate stale-scope MCP session", {
        silent: true,
      });
      sessions.delete(id);
    }
  }
}

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

/** Format an HTTP-level JSON error response body. */
function httpError(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";

  // Only handle /mcp endpoint
  if (url !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(httpError("NOT_FOUND", "Not found. Use /mcp endpoint."));
    return;
  }

  // Shared-secret authentication (when configured)
  if (AUTH_TOKEN !== undefined) {
    const authHeader = req.headers.authorization ?? "";
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(httpError("UNAUTHORIZED", "Unauthorized"));
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
        res.end(httpError("BODY_TOO_LARGE", "Request body too large"));
        return;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(httpError("INVALID_JSON", "Invalid JSON"));
      return;
    }

    // Peek the current grove session ID up front. If it has changed since
    // an existing MCP session was created, invalidate those stale sessions
    // so they can't keep writing to the prior grove session's VFS paths.
    //
    // Only invalidate when we successfully READ the session file. A read
    // error here (truncated JSON during a concurrent session-switch write,
    // temporary file-system hiccup) must NOT tear down in-flight sessions:
    // the TUI writes this file atomically via tmp+rename, so any transient
    // read failure is a bug on the writer side or a disk blip, and killing
    // live connections would be strictly worse than leaving them alone for
    // this one request. The corrupted-state path is caught below in
    // resolveDeps() where it's turned into a 503 for this specific request.
    let sessionReadFailed = false;
    let currentGroveSessionId: string | undefined;
    try {
      currentGroveSessionId = readCurrentSessionId();
    } catch {
      sessionReadFailed = true;
    }
    if (!sessionReadFailed) {
      invalidateStaleSessions(currentGroveSessionId);
    }

    // If we have a session ID and it's still bound to the current grove
    // session, route to the existing MCP session.
    const existingSession = sessionId ? sessions.get(sessionId) : undefined;
    if (existingSession) {
      existingSession.lastActivity = Date.now();
      await existingSession.transport.handleRequest(req, res, parsed);
      return;
    }

    // New MCP session — resolve session-scoped deps NOW (not at boot) so the
    // server binds to whatever grove session is current.
    let scoped: ScopedDeps;
    try {
      scoped = await resolveDeps();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(httpError("SESSION_NOT_READY", msg));
      return;
    }

    // Reject new MCP session initialization in bootstrap mode under Nexus:
    // a bootstrap-scoped McpServer would capture unscoped stores for its
    // entire lifetime and silently write to the zone-global path even after
    // a grove session appears. Clients must retry after `grove up` selects
    // a session. Local mode can initialize freely since there is no Nexus
    // scoping at all.
    if (nexusClient && scoped.sessionId === undefined) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        httpError(
          "SESSION_NOT_READY",
          "grove-mcp-http: no grove session selected — initialize the HTTP MCP " +
            "after starting a session via the TUI. Mutations in bootstrap mode " +
            "would land outside session scope and are refused.",
        ),
      );
      return;
    }

    const scopedDeps = scoped.deps;
    const boundGroveSessionId = scoped.sessionId;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          server,
          transport,
          lastActivity: Date.now(),
          groveSessionId: boundGroveSessionId,
        });
      },
    });
    // grove_eval executes arbitrary shell commands. Disable it on the HTTP
    // transport unless the operator has explicitly set auth (AUTH_TOKEN) AND
    // opted in via GROVE_MCP_EVAL_ENABLED=true. Unauthenticated HTTP exposure
    // of shell execution is a remote-code-execution risk.
    const evalEnabled = AUTH_TOKEN !== undefined && process.env.GROVE_MCP_EVAL_ENABLED === "true";
    const server = await createMcpServer(scopedDeps, {
      eval: evalEnabled,
      transport: "http",
    });

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
      res.end(httpError("INVALID_SESSION", "Missing or invalid Mcp-Session-Id header"));
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
      res.end(httpError("NOT_FOUND", "Session not found"));
      return;
    }
    await delSession.transport.handleRequest(req, res);
    await delSession.server.close();
    if (sessionId) sessions.delete(sessionId);
  } else {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(httpError("METHOD_NOT_ALLOWED", "Method not allowed"));
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
      res.end(httpError("INTERNAL_ERROR", "Internal server error"));
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
