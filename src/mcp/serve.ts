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
import { parseGroveConfig } from "../core/config.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { resolveBundledSkillsRoot } from "../core/resolve-mcp-serve-path.js";
import { DefaultRuntimeSkillAcquisitionService } from "../core/runtime-skill-acquisition.js";
import { TopologyRouter } from "../core/topology-router.js";
import { WatchHub } from "../core/watch-hub.js";
import { createLocalRuntime } from "../local/runtime.js";
import { resolveConfiguredNexusUrl } from "../shared/nexus-url.js";
import type { McpDeps } from "./deps.js";
import { createMcpServer } from "./server.js";

// --- Initialization (eager — catches config errors at startup) ------------

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const DEADLINE_WATCHER_LOCK_HEARTBEAT_MS = 30_000;
const DEADLINE_WATCHER_LOCK_STALE_MS = 90_000;

function isGroveMcpProcess(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
    }).trim();
    return command.includes("grove-mcp") || command.includes("src/mcp/serve.ts");
  } catch {
    return true;
  }
}

function lockPayload(token: string): string {
  return JSON.stringify({
    pid: process.pid,
    token,
    heartbeatAt: new Date().toISOString(),
    acquiredAt: new Date().toISOString(),
  });
}

function writeDeadlineWatcherLock(lockPath: string, token: string): void {
  const tmpPath = `${lockPath}.${process.pid}.${token}.tmp`;
  writeFileSync(tmpPath, lockPayload(token));
  renameSync(tmpPath, lockPath);
}

function readDeadlineWatcherLock(
  lockPath: string,
): { pid?: number; token?: string; heartbeatAt?: number; mtimeMs?: number } | undefined {
  try {
    const stat = statSync(lockPath);
    const existing = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid?: unknown;
      token?: unknown;
      heartbeatAt?: unknown;
    };
    const pid =
      typeof existing.pid === "number" && Number.isInteger(existing.pid) ? existing.pid : undefined;
    const token = typeof existing.token === "string" ? existing.token : undefined;
    const heartbeatAt =
      typeof existing.heartbeatAt === "string" ? Date.parse(existing.heartbeatAt) : undefined;
    return {
      ...(pid !== undefined ? { pid } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

function tryAcquireDeadlineWatcherLock(lockPath: string, token: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, lockPayload(token), { flag: "wx" });
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return false;
      const existing = readDeadlineWatcherLock(lockPath);
      if (
        existing?.pid !== undefined &&
        isProcessAlive(existing.pid) &&
        isGroveMcpProcess(existing.pid)
      ) {
        return false;
      }
      const lockFresh =
        existing?.mtimeMs !== undefined &&
        Date.now() - existing.mtimeMs < DEADLINE_WATCHER_LOCK_STALE_MS;
      if (lockFresh) {
        return false;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseDeadlineWatcherLock(lockPath: string | undefined, token: string | undefined): void {
  if (lockPath === undefined || token === undefined) return;
  try {
    const existing = readDeadlineWatcherLock(lockPath);
    if (existing?.token !== undefined && existing.token !== token) {
      return;
    }
    unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

let deps: McpDeps;
let close: () => void;
let preset: import("./server.js").McpPresetConfig | undefined;
let deadlineWatcherLockPath: string | undefined;
let deadlineWatcherLockToken: string | undefined;
let deadlineWatcherLockHeartbeat: ReturnType<typeof setInterval> | undefined;
let deadlineWatcherRebuildTimer: ReturnType<typeof setInterval> | undefined;
let deadlineWatcherRebuildInFlight = false;
let sweepReconciler: import("../core/sweep-reconciler.js").SweepReconciler | undefined;
let sweepLockPath: string | undefined;
let sweepLockToken: string | undefined;
let sweepLockHeartbeat: ReturnType<typeof setInterval> | undefined;

try {
  const groveDir = groveOverride ?? findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error("Not inside a grove. Run 'grove init' to create one, or set GROVE_DIR.");
  }
  const projectRoot = join(groveDir, "..");

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
  // Prefer the namespace persisted by `grove init` — stable across branch renames.
  // Fall back to GROVE_ZONE_ID env var, then auto-derive from project-id/branch.
  const { readNamespace } = await import("../core/project-key.js");
  const { readProjectId } = await import("../core/project-id.js");
  let zoneId = readNamespace(groveDir) ?? process.env.GROVE_ZONE_ID;
  if (!zoneId) {
    const { detectWorktreeName } = await import("../core/project-key.js");
    const projectId = readProjectId(groveDir);
    const worktreeName = await detectWorktreeName();
    zoneId = projectId ? `${projectId}/${worktreeName}` : "default";
  }
  let nexusClient: import("../nexus/nexus-http-client.js").NexusHttpClient | undefined;
  let nexusHandoffStore: import("../nexus/nexus-handoff-store.js").NexusHandoffStore | undefined;
  let admissionPermissionResolver = runtime.admissionPermissionResolver;
  let admissionGovernanceEvaluator = runtime.admissionGovernanceEvaluator;

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
      // Retry health check — during TUI boot Nexus may briefly appear down
      // (e.g. container restart between `grove up` phases). A single-shot
      // check here killed the whole agent session, leaving the coder
      // without grove_* tools and silently blocking the handoff chain.
      let health = false;
      for (let attempt = 1; attempt <= 5 && !health; attempt++) {
        health = await Promise.race([
          fetch(`${nexusUrl}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok),
          new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
        ]).catch(() => false);
        if (!health && attempt < 5) {
          process.stderr.write(
            `grove-mcp: Nexus health attempt ${attempt}/5 failed — retrying in ${attempt}s\n`,
          );
          await new Promise((r) => setTimeout(r, attempt * 1000));
        }
      }

      if (health) {
        const { createNexusAdmissionAdapters } = await import(
          "../nexus/nexus-admission-adapters.js"
        );
        const nexusAdmission = createNexusAdmissionAdapters({
          url: nexusUrl,
          ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
        });
        admissionPermissionResolver = nexusAdmission.admissionPermissionResolver;
        admissionGovernanceEvaluator = nexusAdmission.admissionGovernanceEvaluator;

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

  const operationFrontierRewardService =
    bountyStore === runtime.bountyStore ? runtime.frontierRewardService : undefined;

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
        sessionRecord = await nexusSessionStore.getSessionRecord(sessionId);
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
  let inboxReadSource: import("../core/operations/inbox-delegation.js").InboxReadSource | undefined;
  let messageDelivery: import("../core/operations/inbox-delegation.js").MessageDelivery | undefined;

  if (nexusClient && nexusUrl) {
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
  }

  if (loadedContract?.topology) {
    if (nexusClient) {
      const { NexusEventBus } = await import("../nexus/nexus-event-bus.js");
      const { NexusIpcClient } = await import("../nexus/nexus-ipc-client.js");
      const apiKey = process.env.NEXUS_API_KEY;
      const ipcClient = nexusUrl
        ? new NexusIpcClient({
            nexusUrl,
            ...(apiKey ? { apiKey } : {}),
            sessionId: process.env.GROVE_SESSION_ID,
            zoneId,
          })
        : undefined;
      eventBus = new NexusEventBus(ipcClient);
      process.stderr.write(`grove-mcp: IPC via Nexus EventBus at ${nexusUrl}\n`);
    } else {
      const { LocalEventBus } = await import("../core/local-event-bus.js");
      eventBus = new LocalEventBus();
    }
    topologyRouter = new TopologyRouter(loadedContract.topology, eventBus);
  }

  // When GROVE_SESSION_ID is set, tag every contribution write against the
  // session at the MCP layer. Contribution stores are session-scoped in Nexus,
  // but session rows still keep a contribution index for list/detail counts.
  const envSessionId = process.env.GROVE_SESSION_ID;
  let onContributionWritten: ((cid: string) => void) | undefined;
  if (envSessionId && nexusClient) {
    const { NexusSessionStore } = await import("../nexus/nexus-session-store.js");
    const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);
    onContributionWritten = (cid: string) => {
      void nexusSessionStore.addContribution(envSessionId, cid).catch(() => undefined);
    };
  } else if (envSessionId) {
    onContributionWritten = (cid: string) => {
      void runtime.goalSessionStore
        .addContributionToSession(envSessionId, cid)
        .catch(() => undefined);
    };
  }

  // Wire DeadlineWatcher for proactive overdue detection. Both Nexus and
  // SQLite (session-scoped via GROVE_SESSION_ID) safely support it: every
  // query filters by session, so session A's timers cannot touch session B.
  // Stores that don't implement listForCurrentSession (e.g. unscoped SQLite
  // when GROVE_SESSION_ID is unset) are detected by rebuildFromStore and
  // skip the startup rebuild automatically.
  let deadlineWatcher: import("../core/deadline-watcher.js").DeadlineWatcher | undefined;
  let handoffExpiryManaged = false;
  const activeHandoffStore = nexusHandoffStore ?? runtime.handoffStore;
  if (activeHandoffStore !== undefined && eventBus !== undefined) {
    const { DeadlineWatcher } = await import("../core/deadline-watcher.js");
    deadlineWatcher = new DeadlineWatcher({ handoffStore: activeHandoffStore, eventBus });
    handoffExpiryManaged = true;
    const deadlineWatcherSessionKey = process.env.GROVE_SESSION_ID ?? "bootstrap";
    const lockPath = join(groveDir, `.grove-deadline-watcher.${deadlineWatcherSessionKey}.lock`);
    const lockToken = crypto.randomUUID();
    const ownsDeadlineWatcher = tryAcquireDeadlineWatcherLock(lockPath, lockToken);
    if (!ownsDeadlineWatcher) {
      process.stderr.write(
        `grove-mcp: deadline watcher already owned for session ${deadlineWatcherSessionKey}; keeping local watcher without rebuild\n`,
      );
    } else {
      deadlineWatcherLockPath = lockPath;
      deadlineWatcherLockToken = lockToken;
      deadlineWatcherLockHeartbeat = setInterval(() => {
        try {
          const existing = readDeadlineWatcherLock(lockPath);
          if (existing?.token !== lockToken) {
            clearInterval(deadlineWatcherLockHeartbeat);
            deadlineWatcherLockHeartbeat = undefined;
            clearInterval(deadlineWatcherRebuildTimer);
            deadlineWatcherRebuildTimer = undefined;
            deadlineWatcher?.close();
            deadlineWatcher = undefined;
            handoffExpiryManaged = false;
            return;
          }
          writeDeadlineWatcherLock(lockPath, lockToken);
        } catch {
          // best-effort heartbeat; lock takeover falls back to staleness TTL
        }
      }, DEADLINE_WATCHER_LOCK_HEARTBEAT_MS);
      deadlineWatcherLockHeartbeat.unref?.();
      const backend = nexusHandoffStore !== undefined ? "Nexus" : "SQLite";
      process.stderr.write(`grove-mcp: DeadlineWatcher created (${backend} backend)\n`);
      try {
        const rebuiltCount = await deadlineWatcher.rebuildFromStore();
        if (rebuiltCount > 0) {
          process.stderr.write(
            `grove-mcp: DeadlineWatcher rebuilt ${rebuiltCount} timer(s) from store\n`,
          );
        }
        deadlineWatcherRebuildTimer = setInterval(() => {
          if (deadlineWatcherRebuildInFlight) return;
          deadlineWatcherRebuildInFlight = true;
          void deadlineWatcher
            ?.rebuildFromStore()
            .catch(() => {
              /* best-effort periodic catch-up for deadlines created by peer processes */
            })
            .finally(() => {
              deadlineWatcherRebuildInFlight = false;
            });
        }, DEADLINE_WATCHER_LOCK_HEARTBEAT_MS);
        deadlineWatcherRebuildTimer.unref?.();
      } catch (error) {
        process.stderr.write(
          `grove-mcp: WARN: deadline watcher rebuild failed for session ${deadlineWatcherSessionKey}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        deadlineWatcher.close();
        deadlineWatcher = undefined;
        handoffExpiryManaged = false;
        if (deadlineWatcherLockHeartbeat !== undefined) {
          clearInterval(deadlineWatcherLockHeartbeat);
          deadlineWatcherLockHeartbeat = undefined;
        }
        if (deadlineWatcherRebuildTimer !== undefined) {
          clearInterval(deadlineWatcherRebuildTimer);
          deadlineWatcherRebuildTimer = undefined;
        }
        deadlineWatcherRebuildInFlight = false;
        releaseDeadlineWatcherLock(deadlineWatcherLockPath, deadlineWatcherLockToken);
        deadlineWatcherLockPath = undefined;
        deadlineWatcherLockToken = undefined;
      }
    }
  }

  // Run settlement recovery from stdio MCP without multiplying zone-wide
  // sweep load by agent count. Every agent process tries to acquire the same
  // process lock; only the owner starts the reconciler.
  {
    const sweepZoneKey = zoneId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const lockPath = join(groveDir, `.grove-mcp-sweep.${sweepZoneKey}.lock`);
    const lockToken = crypto.randomUUID();
    const ownsSweep = tryAcquireDeadlineWatcherLock(lockPath, lockToken);
    if (ownsSweep) {
      const { BountyIndexSweep } = await import("../core/bounty-index-sweep.js");
      const { SettlementSweep } = await import("../core/settlement-sweep.js");
      const { SweepReconciler } = await import("../core/sweep-reconciler.js");
      sweepLockPath = lockPath;
      sweepLockToken = lockToken;
      sweepReconciler = new SweepReconciler({
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
      sweepReconciler.register(new BountyIndexSweep(bountyStore));
      sweepReconciler.register(new SettlementSweep(bountyStore, runtime.creditsService));
      sweepReconciler.start();
      sweepLockHeartbeat = setInterval(() => {
        try {
          const existing = readDeadlineWatcherLock(lockPath);
          if (existing?.token !== lockToken) {
            sweepReconciler?.stop();
            sweepReconciler = undefined;
            clearInterval(sweepLockHeartbeat);
            sweepLockHeartbeat = undefined;
            return;
          }
          writeDeadlineWatcherLock(lockPath, lockToken);
        } catch {
          // best-effort heartbeat; lock takeover falls back to staleness TTL
        }
      }, DEADLINE_WATCHER_LOCK_HEARTBEAT_MS);
      sweepLockHeartbeat.unref?.();
      process.stderr.write("grove-mcp: sweep-reconciler started (singleton owner)\n");
    } else {
      process.stderr.write("grove-mcp: sweep-reconciler already owned by another MCP process\n");
    }
  }

  // Cross-process WatchHub bridge: when grove-server is reachable on its
  // standard service port and we hold a namespace key, fire entity-changed
  // events as POSTs to /api/watch/notify. Without this, agent-driven
  // contributions land in Nexus VFS but the TUI's grove-server-mediated
  // EntityStore feed never sees them — handoff still routes through
  // Nexus IPC, but the TUI-side feed stays empty.
  let onEntityWrite:
    | ((event: import("../core/watch-events.js").EntityWriteEvent) => void)
    | undefined;
  try {
    const { resolveServicePort } = await import("../shared/service-lifecycle.js");
    const { readClientKey } = await import("../core/project-key.js");
    const groveDir = process.env.GROVE_DIR ?? groveOverride;
    const apiKey = groveDir ? readClientKey(groveDir) : undefined;
    if (apiKey) {
      // resolveServicePort("server") reads PORT which inside this MCP
      // process is 4015 (MCP's own port), so the bridge URL would point
      // at MCP itself. Strip PORT so resolveServicePort returns the
      // grove-server default (4515).
      const port = process.env.GROVE_SERVER_PORT
        ? Number.parseInt(process.env.GROVE_SERVER_PORT, 10)
        : resolveServicePort("server", { ...process.env, PORT: undefined } as NodeJS.ProcessEnv);
      const url = `http://localhost:${port}/api/watch/notify`;
      // Per-(kind, entityId) ordering: each entity's events serialize
      // through their own promise chain, but unrelated entities are
      // independent. Without this, one retrying notify (up to ~5s under
      // backoff) would head-of-line-block every other bridge event from
      // this process — including unrelated contributions and claims for
      // a different agent. Tails are removed once they settle so the
      // map doesn't accumulate state for one-shot entities.
      const bridgeTails: Map<string, Promise<unknown>> = new Map();
      // GROVE_SESSION_ID is set by the parent (TUI / acpx) when the agent
      // is bound to a Grove session — its writes land in the session-
      // scoped VFS tree. The watch route needs this id to hydrate from the
      // matching scoped store; without it the unscoped listEntities scan
      // returns [] and the route emits DELETED for a brand-new row.
      const bridgeSessionId = process.env.GROVE_SESSION_ID;
      // Bounded retry with backoff: a single timeout/5xx leaves
      // informer-backed Nexus views stale (those views disable their
      // poller while the watch path is enabled), so deliver-once-best-
      // effort is not enough for UI correctness. We retry transient
      // failures (network errors, 5xx) up to RETRIES times with
      // exponential backoff. Permanent failures (4xx that aren't 408,
      // 429) and final exhaustion log and surrender — at that point
      // the next contribute → notify either repairs the gap, or the
      // user-visible relist on reconnect does.
      const RETRIES = 3;
      const BACKOFF_MS = [200, 600, 1500];
      const isTransient = (status: number): boolean =>
        status >= 500 || status === 408 || status === 429;
      onEntityWrite = (event) => {
        const ent = event.entity as { id?: string; metadata?: { generation?: number } } | null;
        const eid = ent?.id;
        if (!eid) {
          process.stderr.write(`[mcp.bridge] missing entity.id, skipping\n`);
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
                  `[mcp.bridge] POST ${url} kind=${event.kind} op=${event.op} id=${eid} → permanent HTTP ${res.status}; not retrying\n`,
                );
                return;
              }
              if (attempt === RETRIES) {
                const reason = res.err ?? `transient HTTP ${res.status}`;
                process.stderr.write(
                  `[mcp.bridge] POST ${url} kind=${event.kind} op=${event.op} id=${eid} → ${reason}; giving up after ${attempt + 1} attempts. ` +
                    `WARN: subscribers may be stale until next ${event.kind} write or relist.\n`,
                );
                return;
              }
              await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt] ?? 1500));
            }
          });
        bridgeTails.set(tailKey, next);
        // Drop the tail once settled so one-shot entities don't pin map state.
        void next.finally(() => {
          if (bridgeTails.get(tailKey) === next) bridgeTails.delete(tailKey);
        });
      };
    }
  } catch {
    // Best-effort: when groveDir/apiKey/port can't be resolved, the cross-
    // process bridge stays disabled. Agents still write to Nexus, but the
    // TUI feed will only update via polling.
  }

  const readRuntimeSkillsConfig = async () => {
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) return undefined;
    const config = parseGroveConfig(await readFile(configPath, "utf-8"));
    return config.runtimeSkills;
  };

  let runtimeSkillSessionStore: import("../core/session.js").RuntimeSkillSessionStore =
    runtime.goalSessionStore;
  if (nexusClient !== undefined) {
    const { NexusSessionStore } = await import("../nexus/nexus-session-store.js");
    runtimeSkillSessionStore = new NexusSessionStore(nexusClient, zoneId);
  }

  const runtimeSkillService = new DefaultRuntimeSkillAcquisitionService({
    readRuntimeSkillsConfig,
    bundledSkillsRoot: resolveBundledSkillsRoot(projectRoot),
    workspaceOverrideRoot: join(groveDir, "skills"),
    sessionStore: runtimeSkillSessionStore,
    resolveSkillRoot: async (skills) => {
      const configPath = join(groveDir, "grove.json");
      if (!existsSync(configPath)) return undefined;
      const config = parseGroveConfig(await readFile(configPath, "utf-8"));
      if (
        config.mode !== "nexus" ||
        config.skillCatalog === undefined ||
        nexusClient === undefined
      ) {
        return undefined;
      }
      const nexusUrlForSkills = resolveConfiguredNexusUrl({
        projectRoot,
        config,
        env: process.env,
      });
      if (!nexusUrlForSkills) return undefined;
      const { resolveNexusSkillCatalogRoot } = await import("../nexus/nexus-skill-catalog.js");
      return resolveNexusSkillCatalogRoot({
        client: nexusClient,
        zoneId,
        cacheRoot: join(groveDir, "cache", "skills"),
        skills,
        policy: config.skillCatalog.policy,
        trustedKeys: config.skillCatalog.trustedKeys,
        localFallbackRoots: [join(groveDir, "skills"), resolveBundledSkillsRoot(projectRoot)],
      });
    },
  });

  deps = {
    contributionStore,
    claimStore,
    bountyStore,
    creditsService: runtime.creditsService,
    frontierRewardService: operationFrontierRewardService,
    cas,
    frontier:
      nexusClient !== undefined
        ? new DefaultFrontierCalculator(contributionStore)
        : runtime.frontier,
    workspace: runtime.workspace,
    contract: loadedContract,
    onContributionWrite: runtime.onContributionWrite,
    ...(onContributionWritten ? { onContributionWritten } : {}),
    ...(onEntityWrite ? { onEntityWrite, namespace: zoneId } : {}),
    hookRunner: runtime.hookRunner,
    hookCwd: runtime.hookCwd,
    zoneId,
    workspaceBoundary: runtime.groveRoot,
    goalSessionStore: runtime.goalSessionStore,
    runtimeSkillService,
    inboxReadSource,
    messageDelivery,
    ...(admissionPermissionResolver !== undefined ? { admissionPermissionResolver } : {}),
    ...(admissionGovernanceEvaluator !== undefined ? { admissionGovernanceEvaluator } : {}),
    ...(outcomeStore ? { outcomeStore } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(topologyRouter ? { topologyRouter } : {}),
    // Nexus handoff store when available, falls back to local SQLite
    handoffStore: activeHandoffStore,
    idempotencyStore: runtime.idempotencyStore,
    ...(handoffExpiryManaged ? { handoffExpiryManaged: true } : {}),
    ...(deadlineWatcher ? { deadlineWatcher } : {}),
    watchHub: new WatchHub(),
    // Thread GROVE_AGENT_TASK_ID so the claim tool can stamp context.agentTaskId
    // on every new claim, enabling the supervisor to release leases on task death (#273).
    ...(process.env.GROVE_AGENT_TASK_ID ? { agentTaskId: process.env.GROVE_AGENT_TASK_ID } : {}),
  };
  // Derive MCP tool preset from contract mode — #11 MCP Tool Surface + #12 Concept Usage
  const contractMode = loadedContract?.mode ?? "exploration";
  const hasMetrics =
    loadedContract?.metrics !== undefined && Object.keys(loadedContract.metrics).length > 0;

  // grove_eval executes arbitrary sh -c. Disabled by default on all transports;
  // enable with GROVE_MCP_EVAL_ENABLED=true (stdio) or AUTH_TOKEN +
  // GROVE_MCP_EVAL_ENABLED=true (HTTP — enforced in serve-http.ts).
  const evalEnabled = process.env.GROVE_MCP_EVAL_ENABLED === "true";
  // Repo-root prompts/ dir, relative to this file (src/mcp/serve.ts). Registers
  // bundled prompt templates for prompts/list; degrades to [] on a missing dir.
  const promptsDir = new URL("../../prompts/", import.meta.url).pathname;
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
          promptsDir,
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
          promptsDir,
        };

  close = () => {
    sweepReconciler?.stop();
    if (sweepLockHeartbeat !== undefined) {
      clearInterval(sweepLockHeartbeat);
      sweepLockHeartbeat = undefined;
    }
    releaseDeadlineWatcherLock(sweepLockPath, sweepLockToken);
    deadlineWatcher?.close();
    if (deadlineWatcherRebuildTimer !== undefined) {
      clearInterval(deadlineWatcherRebuildTimer);
      deadlineWatcherRebuildTimer = undefined;
    }
    deadlineWatcherRebuildInFlight = false;
    if (deadlineWatcherLockHeartbeat !== undefined) {
      clearInterval(deadlineWatcherLockHeartbeat);
      deadlineWatcherLockHeartbeat = undefined;
    }
    releaseDeadlineWatcherLock(deadlineWatcherLockPath, deadlineWatcherLockToken);
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
// Zone-wide sweeps are lock-owned above so per-agent stdio MCP processes do
// not all run the same reconciler.

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
