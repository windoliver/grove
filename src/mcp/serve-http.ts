#!/usr/bin/env bun

/**
 * Grove MCP server entry point — HTTP/SSE transport.
 *
 * Exposes the MCP server over HTTP using the Streamable HTTP transport from
 * the MCP SDK. Agents connect via HTTP POST (JSON-RPC requests) and receive
 * responses via Server-Sent Events (SSE).
 *
 * Usage:
 *   grove-mcp-http                          # listen on localhost:4015
 *   PORT=8080 grove-mcp-http                # custom port
 *   GROVE_DIR=/path grove-mcp-http          # explicit grove directory
 *   MCP_HOST=0.0.0.0 GROVE_MCP_ALLOW_REMOTE=true GROVE_MCP_AUTH_TOKEN=... grove-mcp-http
 *
 * Endpoints:
 *   POST /mcp   — JSON-RPC requests (initialize, tool calls, etc.)
 *   GET  /mcp   — SSE stream for server-initiated messages
 *   DELETE /mcp — Close a session
 */

import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { findGroveDir } from "../cli/context.js";
import { StateConflictError } from "../core/errors.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import {
  FrontierRewardService,
  frontierRewardEligibleMetrics,
} from "../core/frontier-reward-service.js";
import { TopologyRouter } from "../core/topology-router.js";
import { WatchHub } from "../core/watch-hub.js";
import { createLocalRuntime } from "../local/runtime.js";
import { parsePort } from "../shared/env.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import { parseCurrentSessionPayload, SessionStateReadError } from "./current-session.js";
import { type McpDeps, sessionToOwnerRef } from "./deps.js";
import { resolveMcpHttpBindPolicy } from "./http-bind-policy.js";
import { guardMutableMethods, type ScopeMutationGuard } from "./scope-guard.js";
import { GOAL_SESSION_MUTATION_METHODS } from "./scope-mutation-methods.js";
import { createMcpServer } from "./server.js";

// --- Security constants -----------------------------------------------------

/** Maximum allowed body size for incoming requests (10 MB). */
const MAX_MCP_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Optional shared-secret for authenticating requests.
 * When set, every request must include `Authorization: Bearer <token>`.
 * When unset, auth is skipped (backward compatible for local-only use).
 */
const AUTH_TOKEN = process.env.GROVE_MCP_AUTH_TOKEN?.trim() || undefined;

// --- Initialization ---------------------------------------------------------

const groveOverride = process.env.GROVE_DIR ?? undefined;
const cwd = process.cwd();
const port = parsePort(process.env.PORT, 4015);
const bindPolicy = resolveMcpHttpBindPolicy({
  host: process.env.MCP_HOST,
  authToken: AUTH_TOKEN,
  allowRemote: process.env.GROVE_MCP_ALLOW_REMOTE,
});

if (!bindPolicy.allowed) {
  process.stderr.write(`grove-mcp-http: FATAL: ${bindPolicy.reason}\n`);
  process.exit(1);
}

if (bindPolicy.remote) {
  process.stderr.write(
    "grove-mcp-http: WARN: binding MCP HTTP to a non-localhost address with bearer auth enabled\n",
  );
}

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
  // Prefer the namespace persisted by `grove init` — stable across branch renames.
  // Fall back to GROVE_ZONE_ID env var, then auto-derive from project-id/worktree-name.
  const { readNamespace } = await import("../core/project-key.js");
  const { readProjectId } = await import("../core/project-id.js");
  const resolvedNs = readNamespace(groveDir) ?? process.env.GROVE_ZONE_ID;
  if (resolvedNs) {
    zoneId = resolvedNs;
  } else {
    const { detectWorktreeName } = await import("../core/project-key.js");
    const projectId = readProjectId(groveDir);
    const worktreeName = await detectWorktreeName();
    zoneId = projectId ? `${projectId}/${worktreeName}` : "default";
  }

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

// --- Background sweep reconciler ------------------------------------------
// Runs at process level using the zone-level bounty store (Nexus when
// available, local SQLite otherwise). Not session-scoped — index repair
// and settlement recovery are zone-wide concerns.

import { BountyIndexSweep } from "../core/bounty-index-sweep.js";
import { SettlementSweep } from "../core/settlement-sweep.js";
import { SweepReconciler } from "../core/sweep-reconciler.js";

let httpSweepReconciler: SweepReconciler | undefined;
{
  // Build a zone-level bounty store for the reconciler. In Nexus mode this
  // is a NexusBountyStore scoped to the zone (not session). In local mode
  // it's the local SQLite bounty store from the runtime.
  let reconcilerBountyStore: import("../core/bounty-store.js").BountyStore = runtime.bountyStore;
  if (nexusClient) {
    const { NexusBountyStore } = await import("../nexus/nexus-bounty-store.js");
    reconcilerBountyStore = new NexusBountyStore({ client: nexusClient, zoneId });
  }

  httpSweepReconciler = new SweepReconciler({
    intervalMs: 60_000,
    onCycle(results) {
      for (const r of results) {
        if (r.found > 0 || r.errors.length > 0) {
          process.stderr.write(
            `[sweep] ${r.strategy}: found=${r.found} repaired=${r.repaired} errors=${r.errors.length}\n`,
          );
        }
      }
    },
  });
  httpSweepReconciler.register(new BountyIndexSweep(reconcilerBountyStore));
  httpSweepReconciler.register(new SettlementSweep(reconcilerBountyStore, runtime.creditsService));
  httpSweepReconciler.start();
  process.stderr.write("grove-mcp-http: sweep-reconciler started\n");
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
  readonly deactivate: () => void;
  /**
   * Cleanup for scoped per-session resources (DeadlineWatcher timers,
   * scoped EventBus, etc.). Must be invoked on cache eviction and session
   * invalidation/reap so timers cannot outlive their session and emit
   * cross-session overdue events.
   */
  readonly close: () => void;
}

interface ScopeEntry {
  readonly key: string;
  readonly scoped: ScopedDeps;
  refCount: number;
  deactivated: boolean;
  closed: boolean;
}

interface AcquiredScopedDeps {
  readonly scoped: ScopedDeps;
  readonly deactivate: () => void;
  readonly release: () => void;
}

function readCurrentSessionIdSyncForMutationGuard(): string | undefined {
  const fromEnv = process.env.GROVE_SESSION_ID;
  if (fromEnv) return fromEnv;
  if (!sessionStateCacheDirty) {
    return lastSessionFileId;
  }
  const sessionFile = `${groveDir}/current-session.json`;
  let sessionFileStat: ReturnType<typeof statSync>;
  try {
    sessionFileStat = statSync(sessionFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      lastSessionFileMtimeMs = -1;
      lastSessionFileSize = -1;
      lastSessionFileId = undefined;
      sessionStateCacheDirty = false;
      return undefined;
    }
    throw new SessionStateReadError(
      `stat ${sessionFile} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    sessionFileStat.mtimeMs === lastSessionFileMtimeMs &&
    sessionFileStat.size === lastSessionFileSize &&
    lastSessionFileMtimeMs > 0
  ) {
    sessionStateCacheDirty = false;
    return lastSessionFileId;
  }
  try {
    const sessionId = parseCurrentSessionPayload(readFileSync(sessionFile, "utf-8"), sessionFile);
    lastSessionFileMtimeMs = sessionFileStat.mtimeMs;
    lastSessionFileSize = sessionFileStat.size;
    lastSessionFileId = sessionId;
    sessionStateCacheDirty = false;
    return sessionId;
  } catch (err) {
    if (err instanceof SessionStateReadError) throw err;
    throw new SessionStateReadError(
      `read/parse ${sessionFile} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function createScopeMutationGuard(expectedSessionId: string | undefined): ScopeMutationGuard {
  let active = true;
  return {
    deactivate() {
      active = false;
    },
    assertMutable(operation: string) {
      if (active) {
        try {
          const currentSessionId = readCurrentSessionIdSyncForMutationGuard();
          if (currentSessionId === expectedSessionId) {
            return;
          }
          active = false;
          throw new StateConflictError({
            resource: "MCP session",
            reason: "session scope changed while the request was still running",
            message:
              `HTTP MCP session is stale for '${operation}' (expected session '${expectedSessionId ?? "__bootstrap__"}', current '${currentSessionId ?? "__bootstrap__"}'). ` +
              "Re-initialize the MCP connection and retry.",
          });
        } catch (error) {
          if (error instanceof StateConflictError) throw error;
          active = false;
          throw new StateConflictError({
            resource: "MCP session",
            reason: "could not confirm current session before mutation",
            message:
              `HTTP MCP session cannot safely run '${operation}' because the current session state could not be read. ` +
              "Re-initialize the MCP connection and retry.",
          });
        }
      }
      throw new StateConflictError({
        resource: "MCP session",
        reason: "session scope changed while the request was still running",
        message:
          `HTTP MCP session is closing; '${operation}' cannot continue against a stale Grove session. ` +
          "Re-initialize the MCP connection and retry.",
      });
    },
  };
}

const scopeEntries = new Map<string, ScopeEntry>();
const pendingScopeEntries = new Map<string, Promise<ScopeEntry>>();
let lastSessionFileMtimeMs = -1;
let lastSessionFileSize = -1;
let lastSessionFileId: string | undefined;
let sessionStateCacheDirty = true;
let sessionFileWatcher: FSWatcher | undefined;

if (!process.env.GROVE_SESSION_ID) {
  try {
    sessionFileWatcher = watch(groveDir, (_eventType, filename) => {
      if (typeof filename === "string" && filename !== "current-session.json") {
        return;
      }
      sessionStateCacheDirty = true;
      void refreshSessionScopes().catch(() => {
        /* best-effort cache refresh */
      });
    });
  } catch {
    // best-effort watcher; sync fallback still protects correctness
  }
}

/**
 * Read the current grove session ID from env or state file.
 *
 * Returns `undefined` ONLY when no session has been created yet (env var is
 * unset AND the state file does not exist). Throws `SessionStateReadError`
 * when the state file is present but unreadable, unparseable, or malformed —
 * callers must decide whether to fail closed (Nexus mode) or tolerate
 * the error.
 *
 * Caching semantics: we only update the cached stat/sessionId after a
 * SUCCESSFUL parse. A parse failure leaves the cache untouched so that
 * every subsequent call re-runs the read against the current stat — the
 * caller keeps seeing errors until the writer either fixes the file or
 * produces new file metadata with valid JSON.
 */
async function readCurrentSessionId(): Promise<string | undefined> {
  const fromEnv = process.env.GROVE_SESSION_ID;
  if (fromEnv) return fromEnv;
  const sessionFile = `${groveDir}/current-session.json`;
  let sessionFileStat: Awaited<ReturnType<typeof stat>>;
  try {
    sessionFileStat = await stat(sessionFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Clear cached stat/id when the file disappears so a subsequent recreate
      // cannot accidentally match stale metadata from the old file.
      lastSessionFileMtimeMs = -1;
      lastSessionFileSize = -1;
      lastSessionFileId = undefined;
      sessionStateCacheDirty = false;
      return undefined;
    }
    throw new SessionStateReadError(
      `stat ${sessionFile} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    sessionFileStat.mtimeMs === lastSessionFileMtimeMs &&
    sessionFileStat.size === lastSessionFileSize &&
    lastSessionFileMtimeMs > 0
  ) {
    return lastSessionFileId;
  }
  let sessionId: string;
  try {
    sessionId = parseCurrentSessionPayload(await readFile(sessionFile, "utf-8"), sessionFile);
  } catch (err) {
    // Do NOT update the cache — leave lastSessionFileMtimeMs/lastSessionFileId
    // untouched so the next call re-reads. Otherwise a single torn-write
    // during a concurrent session switch would poison the cache and every
    // subsequent request would read the stale (or undefined) session id
    // without surfacing the error.
    if (err instanceof SessionStateReadError) throw err;
    throw new SessionStateReadError(
      `read/parse ${sessionFile} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Success — commit to cache.
  lastSessionFileMtimeMs = sessionFileStat.mtimeMs;
  lastSessionFileSize = sessionFileStat.size;
  lastSessionFileId = sessionId;
  sessionStateCacheDirty = false;
  return sessionId;
}

async function buildScopedDeps(sessionId: string | undefined): Promise<ScopedDeps> {
  let contributionStore = runtime.contributionStore as import("../core/store.js").ContributionStore;
  let claimStore = runtime.claimStore as import("../core/store.js").ClaimStore;
  let bountyStore = runtime.bountyStore as import("../core/bounty-store.js").BountyStore;
  let cas = runtime.cas as import("../core/cas.js").ContentStore;
  let goalSessionStore = runtime.goalSessionStore;
  let workspace = runtime.workspace as import("../core/workspace.js").WorkspaceManager;
  let idempotencyStore = runtime.idempotencyStore;
  let nexusHandoffStore: import("../nexus/nexus-handoff-store.js").NexusHandoffStore | undefined;
  let topologyRouter: TopologyRouter | undefined;
  let loadedContract: import("../core/contract.js").GroveContract | undefined = runtime.contract;
  let inboxReadSource: import("../core/operations/inbox-delegation.js").InboxReadSource | undefined;
  let messageDelivery: import("../core/operations/inbox-delegation.js").MessageDelivery | undefined;
  let sessionRecord: import("../core/session.js").Session | undefined;
  const mutationGuard = createScopeMutationGuard(sessionId);

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

    if (sessionId) {
      const { NexusSessionStore } = await import("../nexus/nexus-session-store.js");
      const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);
      // Retry briefly in case the TUI session mirror is still in flight.
      const retryDelaysMs = [0, 100, 250, 500, 1000];
      for (const delay of retryDelaysMs) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        sessionRecord = await nexusSessionStore.getSessionRecord(sessionId).catch(() => undefined);
        if (sessionRecord?.config) break;
      }
    }

    if (sessionId && !loadedContract) {
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

  if (nexusClient && nexusUrl) {
    const { NexusInboxClient, NexusMessageDelivery } = await import("../nexus/index.js");
    const { NexusIpcClient } = await import("../nexus/nexus-ipc-client.js");
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
  }

  const canUseLocalFrontierRewardService = bountyStore === runtime.bountyStore;

  // Build a session-scoped handoff store per request. In Nexus mode, use the
  // already-scoped nexusHandoffStore. In local mode, construct a fresh
  // SqliteHandoffStore bound to THIS request's session ID (not the process-
  // global runtime.handoffStore, which was created at startup before any
  // session existed and would reuse unscoped mode). Without this, local
  // HTTP callers would silently bypass session isolation, grove_ack_handoff
  // would be omitted (isInCurrentSession undefined), and deadline rebuild
  // would skip.
  let activeHandoffStore: import("../core/handoff.js").HandoffStore | undefined;
  if (nexusHandoffStore !== undefined) {
    activeHandoffStore = nexusHandoffStore;
  } else if (sessionId !== undefined) {
    const { SqliteHandoffStore } = await import("../local/sqlite-handoff-store.js");
    activeHandoffStore = new SqliteHandoffStore(runtime.db, sessionId);
  } else {
    // Bootstrap/pre-session: no session to scope to — fall back to unscoped
    activeHandoffStore = runtime.handoffStore;
  }

  const localSession =
    sessionId !== undefined && nexusClient === undefined
      ? await goalSessionStore.getSession(sessionId)
      : undefined;
  const ownerSession = nexusClient !== undefined ? sessionRecord : localSession;
  const sessionOwnerRef = sessionToOwnerRef(ownerSession);

  const contributionMutations = ["put", "putMany", "putWithCowrite"] as const;
  contributionStore = guardMutableMethods(contributionStore, mutationGuard, contributionMutations);
  claimStore = guardMutableMethods(claimStore, mutationGuard, [
    "createClaim",
    "claimOrRenew",
    "heartbeat",
    "release",
    "complete",
    "expireStale",
    "cleanCompleted",
  ]);
  bountyStore = guardMutableMethods(bountyStore, mutationGuard, [
    "createBounty",
    "fundBounty",
    "claimBounty",
    "beginSettlement",
    "completeBounty",
    "settleBounty",
    "expireBounty",
    "cancelBounty",
    "repairIndex",
    "recordReward",
  ]);
  cas = guardMutableMethods(cas, mutationGuard, ["put", "delete", "putFile", "getToFile"]);
  workspace = guardMutableMethods(workspace, mutationGuard, [
    "checkout",
    "cleanWorkspace",
    "markStale",
    "markWorkspaceStale",
    "createBareWorkspace",
    "touchWorkspace",
  ]);
  idempotencyStore = guardMutableMethods(idempotencyStore, mutationGuard, [
    "reserve",
    "store",
    "rollback",
    "clear",
  ]);
  const creditsService = guardMutableMethods(runtime.creditsService, mutationGuard, [
    "reserve",
    "capture",
    "void",
    "transfer",
  ]);
  if (goalSessionStore !== undefined) {
    goalSessionStore = guardMutableMethods(
      goalSessionStore,
      mutationGuard,
      GOAL_SESSION_MUTATION_METHODS,
    );
  }
  if (activeHandoffStore !== undefined) {
    activeHandoffStore = guardMutableMethods(activeHandoffStore, mutationGuard, [
      "create",
      "createMany",
      "insertSync",
      "markDelivered",
      "markProcessed",
      "markReplied",
      "markDeadLettered",
      "markCancelled",
      "markManuallyResolved",
      "setIpcMessageId",
      "markSeen",
      "markAcked",
      "expireStale",
    ]);
  }

  if (loadedContract !== undefined) {
    const { EnforcingContributionStore } = await import("../core/enforcing-store.js");
    contributionStore = guardMutableMethods(
      new EnforcingContributionStore(contributionStore, loadedContract, { cas }),
      mutationGuard,
      contributionMutations,
    );
  }

  // Wire EventBus + TopologyRouter for IPC when topology exists.
  // Mirrors serve.ts: use NexusEventBus when Nexus is available,
  // otherwise fall back to LocalEventBus for local-mode routing.
  let eventBus: import("../core/event-bus.js").EventBus | undefined;
  if (loadedContract?.topology) {
    if (nexusClient) {
      const { NexusEventBus } = await import("../nexus/nexus-event-bus.js");
      const { NexusIpcClient } = await import("../nexus/nexus-ipc-client.js");
      const apiKey = process.env.NEXUS_API_KEY;
      const ipcClient = nexusUrl
        ? new NexusIpcClient({
            nexusUrl,
            ...(apiKey ? { apiKey } : {}),
            sessionId,
            zoneId,
          })
        : undefined;
      eventBus = new NexusEventBus(ipcClient);
    } else {
      const { LocalEventBus } = await import("../core/local-event-bus.js");
      eventBus = new LocalEventBus();
    }
    eventBus = guardMutableMethods(eventBus, mutationGuard, [
      "publish",
      "subscribe",
      "unsubscribe",
    ]);
    topologyRouter = guardMutableMethods(
      new TopologyRouter(loadedContract.topology, eventBus),
      mutationGuard,
      ["route", "broadcastStop"],
    );
  }

  // Wire DeadlineWatcher when any handoff store + event bus are available.
  // Both Nexus and session-scoped SQLite (GROVE_SESSION_ID set) safely
  // support it; unscoped SQLite stores leave listForCurrentSession undefined
  // so rebuildFromStore skips automatically. See serve.ts for more context.
  let deadlineWatcher: import("../core/deadline-watcher.js").DeadlineWatcher | undefined;
  let handoffExpiryManaged = false;
  if (activeHandoffStore !== undefined && eventBus !== undefined) {
    const { DeadlineWatcher } = await import("../core/deadline-watcher.js");
    deadlineWatcher = new DeadlineWatcher({ handoffStore: activeHandoffStore, eventBus });
    try {
      await deadlineWatcher.rebuildFromStore();
      handoffExpiryManaged = true;
    } catch (error) {
      process.stderr.write(
        `grove-mcp-http: WARN: deadline watcher rebuild failed for session ${sessionId ?? "__bootstrap__"}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      deadlineWatcher.close();
      deadlineWatcher = undefined;
    }
  }

  if (eventBus !== undefined) {
    // eventBus already guarded before router/watcher construction.
  }
  if (deadlineWatcher !== undefined) {
    deadlineWatcher = guardMutableMethods(deadlineWatcher, mutationGuard, [
      "watch",
      "cancel",
      "rebuildFromStore",
    ]);
  }

  const operationFrontierRewardService = canUseLocalFrontierRewardService
    ? new FrontierRewardService({
        frontier: new DefaultFrontierCalculator(contributionStore),
        bountyStore,
        creditsService,
        eligibleMetrics: frontierRewardEligibleMetrics(loadedContract),
      })
    : undefined;

  // Cross-process WatchHub bridge: when grove-server is reachable and
  // we hold a namespace key, fire entity-changed events as POSTs to
  // /api/watch/notify. Mirrors src/mcp/serve.ts (stdio MCP).
  let onEntityWrite:
    | ((event: import("../core/watch-events.js").EntityWriteEvent) => void)
    | undefined;
  try {
    const { resolveServicePort } = await import("../shared/service-lifecycle.js");
    const { readClientKey } = await import("../core/project-key.js");
    const apiKey = readClientKey(groveDir);
    if (apiKey) {
      // Use GROVE_SERVER_PORT env when set, else fall back to default 4515.
      // resolveServicePort("server") reads PORT which would echo this MCP
      // process's own port (4015), pointing the bridge at MCP itself.
      // resolveServicePort("server") reads PORT which inside this MCP
      // process is 4015 (MCP's own port), so the bridge URL would point
      // at MCP itself. Strip PORT so resolveServicePort returns the
      // grove-server default (4515).
      const port = process.env.GROVE_SERVER_PORT
        ? Number.parseInt(process.env.GROVE_SERVER_PORT, 10)
        : resolveServicePort("server", { ...process.env, PORT: undefined } as NodeJS.ProcessEnv);
      const url = `http://localhost:${port}/api/watch/notify`;
      // Per-(kind, entityId) ordering: same-entity events serialize via
      // their own promise chain, unrelated entities don't block each
      // other. Without this, one retrying notify (~5s under backoff)
      // would head-of-line-block every other bridge event from this
      // process — including unrelated contributions and claims.
      const bridgeTails: Map<string, Promise<unknown>> = new Map();
      // sessionId here is the scope of this McpDeps instance — agent
      // contributions/claims land under /zones/{zone}/sessions/{sessionId}/.
      // Forward it so /api/watch/notify can hydrate from the matching
      // session-scoped store; without it the unscoped lookup returns []
      // and the route emits DELETED for a brand-new row.
      const bridgeSessionId = sessionId;
      // Bounded retry with backoff (mirrors src/mcp/serve.ts). Best-
      // effort delivery is not enough — informer-backed Nexus views
      // disable polling while the watch path is on, so a single
      // 5xx/timeout would leave the UI stale.
      const RETRIES = 3;
      const BACKOFF_MS = [200, 600, 1500];
      const isTransient = (status: number): boolean =>
        status >= 500 || status === 408 || status === 429;
      onEntityWrite = (event) => {
        const ent = event.entity as { id?: string; metadata?: { generation?: number } } | null;
        const eid = ent?.id;
        if (!eid) {
          process.stderr.write(`[mcp-http.bridge] missing entity.id, skipping\n`);
          return;
        }
        const generation = ent?.metadata?.generation;
        const body = JSON.stringify({
          kind: event.kind,
          op: event.op,
          entityId: eid,
          ...(bridgeSessionId ? { sessionId: bridgeSessionId } : {}),
          ...(generation !== undefined ? { generation } : {}),
        });
        const tryPost = async (): Promise<{ ok: boolean; status?: number; err?: string }> => {
          try {
            const r = await fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body,
              signal: AbortSignal.timeout(2_000),
            });
            return { ok: r.ok, status: r.status };
          } catch (e) {
            return { ok: false, err: e instanceof Error ? e.message : String(e) };
          }
        };
        const tailKey = `${event.kind}:${eid}`;
        const prior = bridgeTails.get(tailKey) ?? Promise.resolve();
        const next = prior
          .catch(() => undefined)
          .then(async () => {
            for (let attempt = 0; attempt <= RETRIES; attempt++) {
              const res = await tryPost();
              if (res.ok) return;
              if (res.status !== undefined && !isTransient(res.status)) {
                process.stderr.write(
                  `[mcp-http.bridge] POST ${url} kind=${event.kind} op=${event.op} id=${eid} → permanent HTTP ${res.status}; not retrying\n`,
                );
                return;
              }
              if (attempt === RETRIES) {
                const reason = res.err ?? `transient HTTP ${res.status}`;
                process.stderr.write(
                  `[mcp-http.bridge] POST ${url} kind=${event.kind} op=${event.op} id=${eid} → ${reason}; giving up after ${attempt + 1} attempts. ` +
                    `WARN: subscribers may be stale until next ${event.kind} write or relist.\n`,
                );
                return;
              }
              await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt] ?? 1500));
            }
          });
        bridgeTails.set(tailKey, next);
        void next.finally(() => {
          if (bridgeTails.get(tailKey) === next) bridgeTails.delete(tailKey);
        });
      };
    }
  } catch {
    // Best-effort: when grove-server port or api-key can't be resolved,
    // the cross-process bridge stays disabled. The TUI feed will fall
    // back to its polling refresh interval.
  }

  const deps: McpDeps = {
    contributionStore,
    claimStore,
    bountyStore,
    creditsService,
    frontierRewardService: operationFrontierRewardService,
    cas,
    frontier:
      nexusClient !== undefined
        ? new DefaultFrontierCalculator(contributionStore)
        : runtime.frontier,
    workspace,
    contract: loadedContract,
    ...(sessionId !== undefined ? { idempotencyKeyScope: sessionId } : {}),
    ...(sessionOwnerRef !== undefined ? { sessionOwnerRef } : {}),
    onContributionWrite: runtime.onContributionWrite,
    workspaceBoundary: runtime.groveRoot,
    goalSessionStore,
    inboxReadSource,
    messageDelivery,
    ...(eventBus ? { eventBus } : {}),
    ...(topologyRouter ? { topologyRouter } : {}),
    // Nexus handoff store when available, falls back to local SQLite
    handoffStore: activeHandoffStore,
    idempotencyStore,
    ...(handoffExpiryManaged ? { handoffExpiryManaged: true } : {}),
    ...(deadlineWatcher ? { deadlineWatcher } : {}),
    ...(onEntityWrite ? { onEntityWrite, namespace: zoneId } : {}),
    watchHub: new WatchHub(),
  };
  const deactivate = () => {
    mutationGuard.deactivate();
  };
  const close = () => {
    deadlineWatcher?.close();
    eventBus?.close();
    if (activeHandoffStore !== undefined && activeHandoffStore !== runtime.handoffStore) {
      activeHandoffStore.close();
    }
    // eventBus is shared with the TUI/other surfaces for Nexus-backed IPC,
    // so don't close it here — only per-scope resources.
  };
  return { deps, sessionId, deactivate, close };
}

function logBootstrapMode(sessionId: string | undefined): void {
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
  if (sessionId === undefined) {
    process.stderr.write(
      `grove-mcp-http: no grove session selected — serving in bootstrap mode ` +
        `(reads work against the zone-global path, writes will be session-less). ` +
        `Start a session via the TUI to enable full routing.\n`,
    );
  }
}

async function getOrCreateScopeEntry(
  key: string,
  sessionId: string | undefined,
): Promise<ScopeEntry> {
  const existing = scopeEntries.get(key);
  if (existing) return existing;

  const pending = pendingScopeEntries.get(key);
  if (pending !== undefined) {
    return pending;
  }

  const buildPromise = buildScopedDeps(sessionId)
    .then((scoped) => {
      const cached = scopeEntries.get(key);
      if (cached !== undefined) {
        scoped.close();
        return cached;
      }
      const created: ScopeEntry = {
        key,
        scoped,
        refCount: 0,
        deactivated: false,
        closed: false,
      };
      scopeEntries.set(key, created);
      return created;
    })
    .finally(() => {
      if (pendingScopeEntries.get(key) === buildPromise) {
        pendingScopeEntries.delete(key);
      }
    });

  pendingScopeEntries.set(key, buildPromise);
  return buildPromise;
}

function deactivateScopeEntry(entry: ScopeEntry): void {
  if (entry.deactivated) return;
  entry.deactivated = true;
  if (scopeEntries.get(entry.key) === entry) {
    scopeEntries.delete(entry.key);
  }
  entry.scoped.deactivate();
}

function releaseScopeEntry(entry: ScopeEntry): void {
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0) return;
  if (entry.closed) return;
  if (scopeEntries.get(entry.key) === entry) {
    scopeEntries.delete(entry.key);
  }
  entry.closed = true;
  try {
    entry.scoped.close();
  } catch {
    // best-effort
  }
}

function retainScopeEntry(entry: ScopeEntry): AcquiredScopedDeps {
  entry.refCount += 1;
  let released = false;
  return {
    scoped: entry.scoped,
    deactivate: () => deactivateScopeEntry(entry),
    release: () => {
      if (released) return;
      released = true;
      releaseScopeEntry(entry);
    },
  };
}

async function acquireScopedDeps(sessionId: string | undefined): Promise<AcquiredScopedDeps> {
  logBootstrapMode(sessionId);
  const key = sessionId ?? "__bootstrap__";
  const cached = scopeEntries.get(key);
  if (cached !== undefined) {
    return retainScopeEntry(cached);
  }
  const entry = await getOrCreateScopeEntry(key, sessionId);
  return retainScopeEntry(entry);
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
const REAP_INTERVAL_MS = Math.max(50, Math.min(60_000, Math.floor(SESSION_TTL_MS / 3)));

interface ManagedSession {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  inFlight: number;
  openResponses: number;
  blockingResponses: number;
  closing: boolean;
  closeFinalized: boolean;
  closeReason?: string;
  sseResponses: Set<ServerResponse>;
  /** The grove session ID these stores are bound to (undefined = bootstrap). */
  groveSessionId: string | undefined;
  /** Deactivates the shared scope so stale mutating calls fail. */
  deactivateScope: () => void;
  /** Releases the session-bound scoped deps when the MCP session ends. */
  releaseScope: () => void;
}

/** Map of MCP-session ID → managed session for active sessions. */
const sessions = new Map<string, ManagedSession>();
let lastInvalidatedGroveSessionId: string | undefined;
let hasInvalidatedGroveSession = false;

async function closeManagedSession(
  id: string,
  session: ManagedSession,
  reason: string,
): Promise<void> {
  if (session.closeFinalized) {
    return;
  }
  session.closing = true;
  session.closeReason = reason;
  if (session.inFlight > 0 || session.openResponses > 0) {
    for (const response of session.sseResponses) {
      response.destroy();
    }
    return;
  }
  sessions.delete(id);
  session.closeFinalized = true;
  session.releaseScope();
  await safeCleanup(session.server.close(), reason, { silent: true });
}

function retainResponse(session: ManagedSession, res: ServerResponse, blockReap: boolean): void {
  session.openResponses += 1;
  if (blockReap) {
    session.blockingResponses += 1;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    res.off("close", release);
    res.off("finish", release);
    session.openResponses = Math.max(0, session.openResponses - 1);
    if (blockReap) {
      session.blockingResponses = Math.max(0, session.blockingResponses - 1);
    }
    if (session.closing) {
      void closeManagedSession(session.id, session, session.closeReason ?? "close MCP session");
    }
  };
  res.on("close", release);
  res.on("finish", release);
}

/**
 * Invalidate all MCP sessions bound to a grove session other than `current`.
 * Called when the grove session selection changes. The
 * McpServer captures its deps at construction, so when the grove session
 * changes we cannot simply swap stores — we must close the old MCP session
 * and force the client to re-initialize against fresh scoped deps.
 */
function invalidateStaleSessions(current: string | undefined): void {
  for (const [id, session] of sessions) {
    if (session.groveSessionId !== current) {
      session.deactivateScope();
      void closeManagedSession(id, session, "invalidate stale-scope MCP session");
    }
  }
}

function maybeInvalidateStaleSessions(current: string | undefined): void {
  if (hasInvalidatedGroveSession && current === lastInvalidatedGroveSessionId) {
    return;
  }
  hasInvalidatedGroveSession = true;
  lastInvalidatedGroveSessionId = current;
  invalidateStaleSessions(current);
}

function sessionNotReadyMessage(err: unknown): string {
  return (
    `grove-mcp-http: refusing to scope session — ${err instanceof Error ? err.message : String(err)}. ` +
    `Fix or remove ${groveDir}/current-session.json and retry.`
  );
}

async function refreshSessionScopes(): Promise<string | undefined> {
  try {
    const currentGroveSessionId = await readCurrentSessionId();
    maybeInvalidateStaleSessions(currentGroveSessionId);
    return currentGroveSessionId;
  } catch (err) {
    throw new Error(sessionNotReadyMessage(err));
  }
}

/** Periodically close sessions that have been idle longer than SESSION_TTL_MS. */
const reapTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.inFlight > 0 || session.blockingResponses > 0) {
      continue;
    }
    if (now - session.lastActivity > SESSION_TTL_MS) {
      void closeManagedSession(id, session, "reap idle MCP session");
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
    let currentGroveSessionId: string | undefined;
    try {
      currentGroveSessionId = await refreshSessionScopes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(httpError("SESSION_NOT_READY", msg));
      return;
    }

    // If we have a session ID and it's still bound to the current grove
    // session, route to the existing MCP session.
    const existingSession = sessionId ? sessions.get(sessionId) : undefined;
    if (existingSession?.closing) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        httpError("INVALID_SESSION", "Session is closing; re-initialize the MCP connection."),
      );
      return;
    }
    if (existingSession) {
      existingSession.lastActivity = Date.now();
      existingSession.inFlight += 1;
      retainResponse(existingSession, res, true);
      try {
        await existingSession.transport.handleRequest(req, res, parsed);
      } finally {
        existingSession.inFlight = Math.max(0, existingSession.inFlight - 1);
        if (existingSession.closing) {
          await closeManagedSession(
            existingSession.id,
            existingSession,
            existingSession.closeReason ?? "close MCP session",
          );
        }
      }
      return;
    }

    // New MCP session — resolve session-scoped deps NOW (not at boot) so the
    // server binds to whatever grove session is current.
    let acquiredScope: AcquiredScopedDeps;
    try {
      acquiredScope = await acquireScopedDeps(currentGroveSessionId);
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
    if (nexusClient && acquiredScope.scoped.sessionId === undefined) {
      acquiredScope.release();
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

    const scopedDeps = acquiredScope.scoped.deps;
    const boundGroveSessionId = acquiredScope.scoped.sessionId;
    let initializedSessionId: string | undefined;
    let initializedSession: ManagedSession | undefined;
    let shouldCloseInitializedSession = false;
    let server!: McpServer;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        initializedSessionId = id;
        const session: ManagedSession = {
          id,
          server,
          transport,
          lastActivity: Date.now(),
          inFlight: 1,
          openResponses: 0,
          blockingResponses: 0,
          closing: false,
          closeFinalized: false,
          sseResponses: new Set(),
          groveSessionId: boundGroveSessionId,
          deactivateScope: acquiredScope.deactivate,
          releaseScope: acquiredScope.release,
        };
        retainResponse(session, res, true);
        initializedSession = session;
        sessions.set(id, session);
        if (hasInvalidatedGroveSession && boundGroveSessionId !== lastInvalidatedGroveSessionId) {
          shouldCloseInitializedSession = true;
        }
      },
    });
    // grove_eval executes arbitrary shell commands. Disable it on the HTTP
    // transport unless the operator has explicitly set auth (AUTH_TOKEN) AND
    // opted in via GROVE_MCP_EVAL_ENABLED=true. Unauthenticated HTTP exposure
    // of shell execution is a remote-code-execution risk.
    const evalEnabled = AUTH_TOKEN !== undefined && process.env.GROVE_MCP_EVAL_ENABLED === "true";
    try {
      // Runtime skill acquisition mutates the caller workspace and requires
      // stdio's per-agent role/cwd binding. HTTP MCP intentionally omits it.
      server = await createMcpServer(scopedDeps, {
        eval: evalEnabled,
        transport: "http",
      });
    } catch (err) {
      acquiredScope.release();
      throw err;
    }

    transport.onclose = () => {
      const sid = initializedSessionId ?? transport.sessionId;
      const session = initializedSession;
      if (sid !== undefined && session !== undefined) {
        void closeManagedSession(
          sid,
          session,
          session.closeReason ?? "transport closed MCP session",
        );
      }
    };

    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      if (initializedSessionId !== undefined && initializedSession !== undefined) {
        await closeManagedSession(
          initializedSessionId,
          initializedSession,
          "failed MCP session setup",
        );
      } else {
        acquiredScope.release();
      }
      throw err;
    } finally {
      if (initializedSession !== undefined) {
        initializedSession.inFlight = Math.max(0, initializedSession.inFlight - 1);
        if (initializedSession.closing) {
          await closeManagedSession(
            initializedSession.id,
            initializedSession,
            initializedSession.closeReason ?? "close MCP session",
          );
        }
      }
    }

    if (initializedSessionId === undefined) {
      acquiredScope.release();
      return;
    }
    if (shouldCloseInitializedSession && initializedSession !== undefined) {
      initializedSession.deactivateScope();
      await closeManagedSession(
        initializedSessionId,
        initializedSession,
        "close stale initialized MCP session",
      );
    }
  } else if (req.method === "GET") {
    // SSE stream for server-initiated messages
    try {
      await refreshSessionScopes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(httpError("SESSION_NOT_READY", msg));
      return;
    }
    const getSession = sessionId ? sessions.get(sessionId) : undefined;
    if (!getSession || getSession.closing) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(httpError("INVALID_SESSION", "Missing or invalid Mcp-Session-Id header"));
      return;
    }
    getSession.lastActivity = Date.now();
    getSession.inFlight += 1;
    retainResponse(getSession, res, false);
    getSession.sseResponses.add(res);
    try {
      await getSession.transport.handleRequest(req, res);
    } finally {
      getSession.sseResponses.delete(res);
      getSession.inFlight = Math.max(0, getSession.inFlight - 1);
      if (getSession.closing) {
        await closeManagedSession(
          getSession.id,
          getSession,
          getSession.closeReason ?? "close MCP session",
        );
      }
    }
  } else if (req.method === "DELETE") {
    // Close session
    try {
      await refreshSessionScopes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(httpError("SESSION_NOT_READY", msg));
      return;
    }
    const delSession = sessionId ? sessions.get(sessionId) : undefined;
    if (!delSession || delSession.closing) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(httpError("NOT_FOUND", "Session not found"));
      return;
    }
    delSession.inFlight += 1;
    retainResponse(delSession, res, true);
    try {
      await delSession.transport.handleRequest(req, res);
    } finally {
      delSession.inFlight = Math.max(0, delSession.inFlight - 1);
      if (delSession.closing) {
        await closeManagedSession(
          delSession.id,
          delSession,
          delSession.closeReason ?? "close MCP session",
        );
      }
    }
    if (sessionId) {
      await closeManagedSession(sessionId, delSession, "delete MCP session");
    }
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

httpServer.listen(port, bindPolicy.host, () => {
  process.stderr.write(`grove-mcp-http: listening on http://${bindPolicy.host}:${port}/mcp\n`);
});

// Graceful shutdown
const shutdown = async (): Promise<void> => {
  httpSweepReconciler?.stop();
  clearInterval(reapTimer);
  sessionFileWatcher?.close();
  // Close all active sessions
  for (const [id, session] of sessions) {
    await closeManagedSession(id, session, "shutdown MCP session");
  }
  sessions.clear();
  for (const entry of scopeEntries.values()) {
    try {
      entry.scoped.close();
    } catch {
      // best-effort
    }
  }
  scopeEntries.clear();
  httpServer.close();
  closeStores();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
