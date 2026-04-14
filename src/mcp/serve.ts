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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const groveOverride = process.env.GROVE_DIR ?? undefined;
const cwd = process.cwd();

// Auto-detect GROVE_AGENT_ROLE from workspace .grove-role file if not set in env.
// This allows per-workspace role identity when the MCP server is registered globally.
// The MCP server inherits CWD from the agent that spawned it (codex/claude).
if (!process.env.GROVE_AGENT_ROLE) {
  const roleFile = join(cwd, ".grove-role");
  if (existsSync(roleFile)) {
    process.env.GROVE_AGENT_ROLE = readFileSync(roleFile, "utf-8").trim();
    process.stderr.write(
      `grove-mcp: detected role "${process.env.GROVE_AGENT_ROLE}" from ${roleFile}\n`,
    );
  }
}
process.stderr.write(`grove-mcp: cwd=${cwd} role=${process.env.GROVE_AGENT_ROLE ?? "unset"}\n`);

let deps: McpDeps;
let close: () => void;
let preset: import("./server.js").McpPresetConfig | undefined;

try {
  const groveDir = groveOverride ?? findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error("Not inside a grove. Run 'grove init' to create one, or set GROVE_DIR.");
  }

  const nexusUrl = process.env.GROVE_NEXUS_URL;
  const nexusApiKey = process.env.NEXUS_API_KEY;

  // Always create local runtime for workspace, frontier, CAS.
  //
  // Contract loading: in local mode we read the session config from the local
  // SQLite goalSessionStore. In Nexus mode, the session config lives only in
  // the Nexus VFS (see NexusProvider.createSession → nexusSessionStore.putSession),
  // so we skip the SQLite session-config lookup here and reconstruct the
  // contract from the Nexus session record further down.
  const runtime = createLocalRuntime({
    groveDir,
    frontierCacheTtlMs: 5_000,
    workspace: true,
    parseContract: !nexusUrl,
  });

  if (!runtime.workspace) {
    throw new Error("Workspace manager failed to initialize");
  }

  // Try Nexus stores (source of truth), fall back to local SQLite if unavailable.
  let contributionStore = runtime.contributionStore as import("../core/store.js").ContributionStore;
  let claimStore = runtime.claimStore as import("../core/store.js").ClaimStore;
  let bountyStore = runtime.bountyStore as import("../core/bounty-store.js").BountyStore;
  let outcomeStore: import("../core/outcome.js").OutcomeStore | undefined;
  let cas = runtime.cas as import("../core/cas.js").ContentStore;
  const zoneId = process.env.GROVE_ZONE_ID ?? "default";
  let nexusClient: import("../nexus/nexus-http-client.js").NexusHttpClient | undefined;
  let nexusHandoffStore: import("../nexus/nexus-handoff-store.js").NexusHandoffStore | undefined;

  if (nexusUrl) {
    try {
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

      // Quick health check — don't block if Nexus is down
      const health = await Promise.race([
        fetch(`${nexusUrl}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok),
        new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
      ]).catch(() => false);

      if (health) {
        contributionStore = new NexusContributionStore({
          client: nexusClient,
          zoneId,
          sessionId: process.env.GROVE_SESSION_ID,
        });
        claimStore = new NexusClaimStore({ client: nexusClient, zoneId });
        bountyStore = new NexusBountyStore({ client: nexusClient, zoneId });
        outcomeStore = new NexusOutcomeStore({ client: nexusClient, zoneId });
        cas = new NexusCas({ client: nexusClient, zoneId });
        const { NexusHandoffStore } = await import("../nexus/nexus-handoff-store.js");
        nexusHandoffStore = new NexusHandoffStore(
          nexusClient,
          process.env.GROVE_SESSION_ID,
          zoneId,
        );
        process.stderr.write(`grove-mcp: using Nexus stores at ${nexusUrl}\n`);
      } else {
        // Fail closed: GROVE_NEXUS_URL was explicitly set, so the caller wants
        // Nexus semantics (session scoping, handoff routing, cross-process
        // IPC). Falling back to local SQLite here would silently split writes
        // between Nexus and the session-scoped path the TUI subscribes to,
        // leaving the coder→reviewer loop deadlocked without any error. We
        // cannot know if this is a transient health blip or a real outage,
        // so we crash and let the parent process retry / surface the error.
        process.stderr.write(
          `grove-mcp: FATAL: GROVE_NEXUS_URL=${nexusUrl} is set but health check failed. ` +
            `Refusing to fall back to local stores — that would silently bypass Nexus ` +
            `routing and handoff creation. Verify Nexus is reachable and retry.\n`,
        );
        process.exit(1);
      }
    } catch (err) {
      // Same reasoning: a configured Nexus that throws during setup is a hard
      // failure, not a soft downgrade. Exit so the parent can retry with the
      // full error visible instead of corrupting subsequent writes.
      process.stderr.write(
        `grove-mcp: FATAL: Nexus setup failed for ${nexusUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  } else {
    process.stderr.write(`grove-mcp: using local stores at ${groveDir}\n`);
  }

  // In Nexus mode we skipped the local contract parse; load the authoritative
  // contract from the Nexus session record instead. The TUI mirrors every
  // session to Nexus via NexusSessionStore.putSession with the frozen
  // GroveContract snapshot, so we pull it from there.
  //
  // This path fails CLOSED: if GROVE_SESSION_ID is set but no full contract
  // is available (session missing, record has only topology, Nexus is
  // unreachable, or the write race hasn't settled), we exit the process.
  // Without a full contract, EnforcingContributionStore is never wired, so
  // agent writes would bypass rate limits, cost caps, gates, and per-kind
  // policies — a silent fail-open here corrupts every contribution until
  // the next restart. Callers must ensure the Nexus session mirror has
  // completed before spawning agents (nexus-provider awaits putSession).
  //
  // Note: the stdio serve.ts process is spawned per agent by acpx, after
  // setSessionScope has mirrored the session. If the mirror is still in
  // flight we retry with exponential backoff before failing.
  let loadedContract: import("../core/contract.js").GroveContract | undefined = runtime.contract;
  if (nexusClient && !loadedContract && process.env.GROVE_SESSION_ID) {
    const sessionId = process.env.GROVE_SESSION_ID;
    const { NexusSessionStore } = await import("../nexus/nexus-session-store.js");
    const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);

    const retryDelaysMs = [0, 100, 250, 500, 1000, 2000];
    let lastErr: unknown;
    let sessionRecord: import("../core/session.js").Session | undefined;
    for (const delay of retryDelaysMs) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        sessionRecord = await nexusSessionStore.getSession(sessionId);
        if (sessionRecord?.config) break;
      } catch (err) {
        lastErr = err;
      }
    }

    // Policy: by default we PREFER a full frozen contract but fall back to
    // topology-only with a loud warning when the session record was
    // created without one. This preserves backwards compatibility with
    // legacy sessions and session-creation paths (e.g. the
    // `grove_create_session` MCP tool) that don't ship a contract.
    //
    // Operators who need strict enforcement can set
    // `GROVE_MCP_STRICT_CONTRACT=1` to invert the default and fail closed
    // on any session without a frozen contract — recommended once every
    // session-creation path in the deployment is persisting config.
    const strictContract = process.env.GROVE_MCP_STRICT_CONTRACT === "1";

    if (sessionRecord?.config) {
      // Happy path: full frozen contract mirrored from the TUI's createSession.
      loadedContract = sessionRecord.config;
      process.stderr.write(`grove-mcp: loaded full contract from Nexus session ${sessionId}\n`);
    } else if (sessionRecord?.topology && !strictContract) {
      // Default degraded path: the session record exists but lacks a frozen
      // config. Reconstruct a minimal contract so topology routing and
      // per-kind tool presets still work. Rate limits / enforcement / gates
      // are NOT honored; log a loud WARN so operators see the gap.
      loadedContract = {
        contractVersion: 1,
        name: sessionRecord.presetName ?? "nexus-session",
        mode: "exploration",
        topology: sessionRecord.topology,
      };
      process.stderr.write(
        `grove-mcp: WARN: Nexus session ${sessionId} has no frozen config — ` +
          `using topology-only contract (rate limits / gates / cost caps NOT ` +
          `applied). Recreate the session with the current TUI to get full ` +
          `enforcement, or set GROVE_MCP_STRICT_CONTRACT=1 to fail closed here.\n`,
      );
    } else if (sessionRecord?.topology) {
      // Strict mode explicitly enabled: refuse to proceed without a full
      // contract even though the session record exists.
      process.stderr.write(
        `grove-mcp: FATAL: GROVE_MCP_STRICT_CONTRACT=1 is set and Nexus session ` +
          `${sessionId} has no frozen config. Recreate the session with the ` +
          `current TUI.\n`,
      );
      process.exit(1);
    } else {
      // No session record at all in Nexus — the agent cannot do useful work.
      // This is distinct from "session exists without config"; here we exit
      // because there is no topology to route with either, so spawning an
      // agent would produce zero progress.
      const reason = lastErr
        ? `Nexus lookup failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
        : "session not found in Nexus";
      process.stderr.write(
        `grove-mcp: FATAL: cannot find Nexus session ${sessionId} — ${reason}. ` +
          `Ensure the TUI session mirror has completed before spawning agents.\n`,
      );
      process.exit(1);
    }
  }

  // Wrap the contribution store with rate-limit / clock-skew enforcement
  // when a contract is loaded. Mirrors the CLI path in
  // src/cli/commands/contribute.ts:353. Without this wrap, MCP-served
  // contributions bypass the rate limits configured in GROVE.md (Issue 2A
  // in the #228 review).
  if (loadedContract !== undefined) {
    const { EnforcingContributionStore } = await import("../core/enforcing-store.js");
    contributionStore = new EnforcingContributionStore(contributionStore, loadedContract, {
      cas,
    });
  }

  // Wire EventBus + TopologyRouter for IPC when topology exists.
  let eventBus: import("../core/event-bus.js").EventBus | undefined;
  let topologyRouter: TopologyRouter | undefined;

  if (loadedContract?.topology) {
    if (nexusClient) {
      const { NexusEventBus } = await import("../nexus/nexus-event-bus.js");
      eventBus = new NexusEventBus(nexusClient, zoneId);
      process.stderr.write(`grove-mcp: IPC via Nexus EventBus at ${nexusUrl}\n`);
    } else {
      const { LocalEventBus } = await import("../core/local-event-bus.js");
      eventBus = new LocalEventBus();
    }
    topologyRouter = new TopologyRouter(loadedContract.topology, eventBus);
  }

  // When running with a local SQLite store and GROVE_SESSION_ID is set,
  // tag every contribution write against the session at the MCP layer.
  // Nexus handles this via path-scoped stores; local SQLite needs the junction table.
  const envSessionId = process.env.GROVE_SESSION_ID;
  const onContributionWritten =
    envSessionId && !nexusClient
      ? (cid: string) => {
          // biome-ignore lint/suspicious/noEmptyBlockStatements: fire-and-forget, errors intentionally swallowed
          void runtime.goalSessionStore.addContributionToSession(envSessionId, cid).catch(() => {});
        }
      : undefined;

  deps = {
    contributionStore,
    claimStore,
    bountyStore,
    cas,
    frontier: runtime.frontier,
    workspace: runtime.workspace,
    contract: loadedContract,
    onContributionWrite: runtime.onContributionWrite,
    ...(onContributionWritten ? { onContributionWritten } : {}),
    workspaceBoundary: runtime.groveRoot,
    goalSessionStore: runtime.goalSessionStore,
    ...(outcomeStore ? { outcomeStore } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(topologyRouter ? { topologyRouter } : {}),
    // Nexus handoff store when available, falls back to local SQLite
    handoffStore: nexusHandoffStore ?? runtime.handoffStore,
    idempotencyStore: runtime.idempotencyStore,
  };
  // Derive MCP tool preset from contract mode — #11 MCP Tool Surface + #12 Concept Usage
  const contractMode = loadedContract?.mode ?? "exploration";
  const hasMetrics =
    loadedContract?.metrics !== undefined && Object.keys(loadedContract.metrics).length > 0;

  // grove_eval executes arbitrary sh -c. Disabled by default on all transports;
  // enable with GROVE_MCP_EVAL_ENABLED=true (stdio) or AUTH_TOKEN +
  // GROVE_MCP_EVAL_ENABLED=true (HTTP — enforced in serve-http.ts).
  const evalEnabled = process.env.GROVE_MCP_EVAL_ENABLED === "true";
  preset =
    contractMode === "evaluation"
      ? {
          queries: true,
          claims: true,
          bounties: true,
          outcomes: true,
          workspace: true,
          stop: true,
          ingest: true,
          messaging: false,
          plans: true,
          goals: true,
          eval: evalEnabled,
        }
      : {
          queries: true,
          claims: true,
          bounties: false,
          outcomes: hasMetrics,
          workspace: false,
          stop: false,
          ingest: true, // Required: grove_submit_work needs grove_cas_put for artifact ingestion
          messaging: false,
          plans: false,
          goals: true,
          eval: evalEnabled,
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

const server = await createMcpServer(deps, preset);
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
