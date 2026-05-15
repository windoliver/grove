/**
 * Service lifecycle management — shared between `grove up` and the TUI.
 *
 * Handles starting HTTP server, MCP server, and managed Nexus,
 * plus graceful shutdown of all spawned processes.
 */

import type { ChildProcess as NodeChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parsePort } from "./env.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManagedChildProcess {
  readonly name: string;
  readonly pid: number;
  readonly proc: ReturnType<typeof Bun.spawn>;
  /**
   * "spawned" → this call started the process; rollback may SIGTERM it.
   * "adopted" → the process was already running and we attached to it
   *   for shutdown bookkeeping. Rollback must NOT kill an adopted child
   *   on unrelated sibling failure (other concurrent work may depend on it).
   */
  readonly acquired: "spawned" | "adopted";
}

/** Options for starting services. */
export interface ServiceStartOptions {
  /** Path to the .grove directory. */
  readonly groveDir: string;
  /** Pass --build to nexus up for local source builds. */
  readonly build?: boolean | undefined;
  /** Path to local nexus source checkout. */
  readonly nexusSource?: string | undefined;
  /** Optional progress callback — captures status messages for TUI display instead of stderr. */
  readonly onProgress?: ((step: string) => void) | undefined;
  /** Force re-init nexus.yaml (e.g. "New grove" — get fresh ports). */
  readonly force?: boolean | undefined;
}

/** Running service state — returned by startServices, passed to stopServices. */
export interface RunningServices {
  readonly children: ManagedChildProcess[];
  readonly nexusManaged: boolean;
  /**
   * True only when THIS startServices invocation transitioned Nexus from
   * stopped→running. False when Nexus was already healthy and we reused it.
   * stopServices uses this to gate `nexusDown` — a routine shutdown of a
   * process that only reused Nexus must not stop a Nexus other concurrent
   * work depends on.
   */
  readonly nexusStartedThisCall: boolean;
  readonly projectRoot: string;
  readonly pidFilePath: string;
  /**
   * Resolved Nexus URL after successful startup. Present when nexusManaged
   * is true and Nexus started successfully. Callers should persist this to
   * grove.json via persistNexusUrlToConfig so Resume can skip re-discovery.
   */
  readonly resolvedNexusUrl?: string | undefined;
}

/**
 * Process-local registry of RunningServices keyed by groveDir. Lets a
 * same-process re-entry return the ORIGINAL handle (with its real child
 * shutdown surfaces) instead of an empty children[] that would orphan the
 * services on cleanup. Cleared by stopServices.
 */
const SAME_PROCESS_REGISTRY = new Map<string, RunningServices>();

// ---------------------------------------------------------------------------
// Config persistence helper (caller responsibility, not startServices)
// ---------------------------------------------------------------------------

/**
 * Persist the resolved Nexus URL to grove.json.
 *
 * Call this after startServices() returns when resolvedNexusUrl is set.
 * Keeping this out of startServices() makes the side effect explicit and
 * the lifecycle function easier to test.
 *
 * Best-effort — failures are logged but do not throw.
 */
export function persistNexusUrlToConfig(groveDir: string, url: string): void {
  try {
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) return;
    const current = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    if (current.nexusUrl === url) return; // already correct — skip write
    current.nexusUrl = url;
    writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort — don't crash startup over config persistence
  }
}

// ---------------------------------------------------------------------------
// Start services
// ---------------------------------------------------------------------------

/**
 * Start all configured services (HTTP server, MCP server, managed Nexus).
 *
 * Reads grove.json to determine which services to start. Returns a handle
 * for stopping services later, including the resolved Nexus URL when managed.
 *
 * Does NOT persist nexusUrl to grove.json — call persistNexusUrlToConfig
 * with resolvedNexusUrl after this returns if you want Resume to skip
 * re-discovery.
 *
 * If grove.json doesn't exist or has no services configured, returns
 * an empty RunningServices (no-op shutdown).
 */
export async function startServices(options: ServiceStartOptions): Promise<RunningServices> {
  const { groveDir } = options;
  const report = options.onProgress ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const configPath = join(groveDir, "grove.json");
  const projectRoot = join(groveDir, "..");
  const pidFilePath = join(groveDir, "grove.pid");
  const children: ManagedChildProcess[] = [];
  let nexusManaged = false;
  let resolvedNexusUrl: string | undefined;

  // Make GROVE_SERVER_PORT visible to this process so the cross-process
  // bridge in stdio MCPs (spawned later via AcpRuntime — they inherit
  // parent env, not serviceEnv) can target the right port. Without this,
  // stdio MCPs for agents fall back to the 4515 default and miss any
  // non-default deployment.
  if (!process.env.GROVE_SERVER_PORT) {
    process.env.GROVE_SERVER_PORT = String(resolveServicePort("server"));
  }

  report(
    `[startServices] groveDir=${groveDir} configExists=${existsSync(configPath)} GROVE_NEXUS_URL=${process.env.GROVE_NEXUS_URL ?? "unset"} GROVE_SERVER_PORT=${process.env.GROVE_SERVER_PORT}`,
  );

  if (!existsSync(configPath)) {
    return {
      children,
      nexusManaged,
      nexusStartedThisCall: false,
      projectRoot,
      pidFilePath,
    };
  }

  const raw = readFileSync(configPath, "utf-8");
  const { parseGroveConfig } = await import("../core/config.js");
  const config = parseGroveConfig(raw);

  // Reuse path: if grove.pid exists and EITHER the parent is the current
  // process (we already spawned children in this same TUI flow) OR an
  // external parent is still alive, services are already running for this
  // groveDir. Without this, a session-start callback inside a `grove up`
  // flow re-spawns the HTTP/MCP servers and fails on EADDRINUSE — leaving
  // the TUI hung at "Starting session...".
  //
  // We return an empty `children` array because we do NOT take ownership
  // of the existing processes — stopServices on this RunningServices is a
  // no-op, leaving teardown to whoever holds the original handles.
  if (existsSync(pidFilePath)) {
    // Read + parse + liveness in a narrow try (only file/JSON errors get
    // treated as malformed-pidfile and fall through). Ownership errors
    // are intentionally NOT caught — they must surface to the caller.
    let pidData:
      | {
          parentPid?: number;
          children?: ReadonlyArray<{ name?: string; pid?: number }>;
          nexusManaged?: boolean;
        }
      | undefined;
    try {
      const pidRaw = readFileSync(pidFilePath, "utf-8");
      pidData = JSON.parse(pidRaw);
    } catch {
      // Malformed pidfile — fall through and start fresh.
      pidData = undefined;
    }
    if (pidData) {
      const parentPid = pidData.parentPid;
      const parentAlive = (() => {
        if (!parentPid) return false;
        if (parentPid === process.pid) return true;
        try {
          process.kill(parentPid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      // Verify at least one configured child is also live — guards against
      // a stale pidfile where the parent survived but the spawned services
      // exited (e.g. crashed grove-server). Treat that as "no reuse" so
      // the spawn path runs.
      const someChildAlive = (pidData.children ?? []).some((c) => {
        if (!c.pid) return false;
        try {
          process.kill(c.pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      // Same-process re-entry fast path: this same TUI process already
      // ran startServices and pidfile records itself as parent. ALL
      // configured children must be alive — partial death (e.g. server
      // crashed while mcp lives) means we need to spawn the missing one,
      // not silently report success. Fall through to spawnService loop
      // (each invocation handles identity-match adoption per service).
      const sameParent = parentPid === process.pid;
      const allConfiguredChildrenAlive = (() => {
        const recordedAlive = new Set(
          (pidData.children ?? [])
            .filter((c) => {
              if (!c.pid || !c.name) return false;
              try {
                process.kill(c.pid, 0);
                return true;
              } catch {
                return false;
              }
            })
            .map((c) => c.name as string),
        );
        if (config.services?.server && !recordedAlive.has("server")) return false;
        if (config.services?.mcp && !recordedAlive.has("mcp")) return false;
        return true;
      })();
      if (sameParent && allConfiguredChildrenAlive) {
        // Already running in this same process. Return the ORIGINAL
        // RunningServices handle from the process-local registry so
        // shutdown still has live child references. Returning a fresh
        // empty handle here would let the caller overwrite the original
        // owner reference and orphan the children on cleanup.
        const cached = SAME_PROCESS_REGISTRY.get(groveDir);
        if (cached) {
          report(
            `[startServices] same-process re-entry: returning cached RunningServices for PID ${parentPid}`,
          );
          if (!process.env.GROVE_NEXUS_URL && config.nexusUrl) {
            process.env.GROVE_NEXUS_URL = config.nexusUrl;
          }
          if (!process.env.NEXUS_API_KEY) {
            try {
              const { readNexusApiKey } = await import("../cli/nexus-lifecycle.js");
              const apiKey = readNexusApiKey(projectRoot);
              if (apiKey) process.env.NEXUS_API_KEY = apiKey;
            } catch {
              /* best-effort */
            }
          }
          return cached;
        }
        // Pidfile says same parent but registry is empty (e.g. an older
        // process wrote the pidfile, then we re-launched). Fall through
        // to per-service spawn check — adoption path will reattach.
        report(
          `[startServices] same-process pidfile but no in-process registry entry; falling through to per-service check`,
        );
      }
      // Else: fall through. spawnService handles per-service identity
      // adoption (configured-but-bound: adopt; configured-but-unbound:
      // spawn fresh). Crashed siblings auto-restart; foreign listeners
      // throw with remediation. No early return — every configured
      // service goes through verification independently.
      if (parentAlive && !sameParent) {
        report(
          `[startServices] pidfile present (parent PID ${parentPid} alive, different process); per-service identity check will adopt or spawn each.`,
        );
      } else if (parentPid && !parentAlive) {
        report(
          `[startServices] pidfile points to dead PID ${parentPid}; per-service check follows.`,
        );
      }
      // someChildAlive is no longer used as a gate; the per-service
      // spawnService path uses isPortBound + identity to decide adopt-vs-spawn.
      void someChildAlive;
    }
  }

  // Always read API key from .grove/api-key when nexus.yaml-derived
  // credentials are present, so downstream code (checkNexusHealth,
  // NexusDataProvider) can authenticate even when the env was not pre-set.
  // Best-effort: when there's no .grove/api-key, env stays unset.
  if (!process.env.NEXUS_API_KEY) {
    try {
      const { readNexusApiKey } = await import("../cli/nexus-lifecycle.js");
      const apiKey = readNexusApiKey(projectRoot);
      if (apiKey) process.env.NEXUS_API_KEY = apiKey;
    } catch {
      // best-effort
    }
  }

  // Track whether THIS startServices invocation actually started Nexus
  // (vs. found one already healthy and reused it). Rollback on partial
  // failure must only tear down what this call acquired — taking down a
  // pre-existing Nexus that other work depends on would be a regression.
  let nexusStartedThisCall = false;

  // Start managed Nexus if configured — skip if GROVE_NEXUS_URL already set (reuse existing)
  // Fire when:
  //   • config has nexusManaged=true (explicit lifecycle ownership), OR
  //   • config.mode === "nexus" (whether or not nexusUrl is set — a stale
  //     URL pointing at a stopped container needs to be brought back up).
  // This ensures `grove init` configs that record nexusUrl from a previous
  // session still trigger Nexus startup on subsequent `grove up` calls.
  if (!process.env.GROVE_NEXUS_URL && (config.nexusManaged || config.mode === "nexus")) {
    // Fast path: if grove.json has nexusUrl, check health before running ensureNexusRunning.
    if (config.nexusUrl) {
      try {
        const { readNexusApiKey } = await import("../cli/nexus-lifecycle.js");
        const res = await fetch(`${config.nexusUrl}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUTS.nexusHealthFetchMs),
        });
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        if (body.status === "healthy" || body.status === "starting") {
          const apiKey = readNexusApiKey(projectRoot);
          if (body.status === "starting") {
            const { waitForNexusHealth } = await import("../cli/nexus-lifecycle.js");
            await waitForNexusHealth(config.nexusUrl, 60_000);
          }
          process.env.GROVE_NEXUS_URL = config.nexusUrl;
          if (apiKey) process.env.NEXUS_API_KEY = apiKey;
          nexusManaged = true;
          // NOT setting nexusStartedThisCall — we just reused a healthy
          // existing Nexus; rollback on partial spawn failure must NOT
          // stop it.
          resolvedNexusUrl = config.nexusUrl;
          options.onProgress?.("Nexus is ready (from grove.json)");
        }
      } catch {
        // Not reachable — fall through to ensureNexusRunning
      }
    }

    if (!nexusManaged)
      try {
        const { ensureNexusRunning } = await import("../cli/nexus-lifecycle.js");
        const nexusInfo = await ensureNexusRunning(projectRoot, config, {
          build: options.build ?? false,
          nexusSource: options.nexusSource,
          onProgress: report,
        });
        nexusManaged = true;
        // Honor ensureNexusRunning's explicit ownership flag instead of
        // assuming success implies we started it. Fast paths reuse a
        // healthy/starting container without invoking `nexus up`; rollback
        // must not stop a Nexus we only reused.
        nexusStartedThisCall = nexusInfo.startedThisCall;
        resolvedNexusUrl = nexusInfo.url;
        if (!process.env.GROVE_NEXUS_URL) {
          process.env.GROVE_NEXUS_URL = nexusInfo.url;
        }
        if (!process.env.NEXUS_API_KEY && nexusInfo.apiKey) {
          process.env.NEXUS_API_KEY = nexusInfo.apiKey;
        }
      } catch (err) {
        // If user explicitly asked for --build, don't silently fall back — surface the error
        if (options.build) {
          throw err;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        report(`Nexus unavailable (${errMsg}), using local mode`);
      }
  }

  // Spawn services in parallel
  const spawnPromises: Promise<ManagedChildProcess | null>[] = [];

  const { dirname } = await import("node:path");
  const entryPoint = process.argv[1] ?? "";
  const groveSourceRoot = dirname(dirname(dirname(entryPoint)));
  const resolveEntry = (rel: string) => {
    const distPath = join(groveSourceRoot, "dist", rel.replace("src/", "").replace(".ts", ".js"));
    if (existsSync(distPath)) return distPath;
    return join(groveSourceRoot, rel);
  };

  if (config.services?.server) {
    options.onProgress?.("Starting HTTP server...");
    const serverEntry = resolveEntry("src/server/serve.ts");
    report(`[startServices] spawning HTTP server: ${serverEntry} groveDir=${groveDir}`);
    spawnPromises.push(spawnService("server", serverEntry, groveDir));
  } else {
    report(
      `[startServices] HTTP server NOT configured (services.server=${String(config.services?.server)})`,
    );
  }

  if (config.services?.mcp) {
    options.onProgress?.("Starting MCP server...");
    spawnPromises.push(spawnService("mcp", resolveEntry("src/mcp/serve-http.ts"), groveDir));
  }

  // Use allSettled so a single failed spawn doesn't abandon successfully
  // started siblings as detached orphans. On any rejection we kill the
  // children that did start before re-raising the first error.
  const settled = await Promise.allSettled(spawnPromises);
  const errors: Error[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      if (result.value) children.push(result.value);
    } else {
      errors.push(
        result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
      );
    }
  }
  if (errors.length > 0) {
    // Roll back ONLY children this call spawned. Adopted children
    // (existing PIDs we attached to via verifyPortIdentity) were already
    // running before this invocation; killing them on unrelated sibling
    // failure would mirror the round-5 Nexus-tear-down regression.
    const toKill = children.filter((c) => c.acquired === "spawned");
    const ROLLBACK_DEADLINE_MS = 5_000;
    const deadline = Date.now() + ROLLBACK_DEADLINE_MS;
    await Promise.all(
      toKill.map(async (child) => {
        try {
          child.proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
        const remaining = Math.max(0, deadline - Date.now());
        const exited = await Promise.race([
          child.proc.exited,
          new Promise<false>((resolve) => setTimeout(() => resolve(false), remaining)),
        ]);
        if (exited === false) {
          try {
            child.proc.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }),
    );
    // Only tear down Nexus if THIS call started it. Reusing a healthy
    // pre-existing Nexus must not get torn down because the HTTP server
    // failed to bind — other work may depend on it.
    if (nexusStartedThisCall) {
      try {
        const { nexusDown } = await import("../cli/nexus-lifecycle.js");
        await nexusDown(projectRoot);
      } catch {
        /* best-effort */
      }
    }
    // Re-raise the first error with all reasons attached.
    const composite = new Error(
      errors.length === 1
        ? errors[0]?.message
        : `${errors.length} services failed to start:\n${errors.map((e) => `  - ${e.message}`).join("\n")}`,
    );
    if (errors[0]?.stack) composite.stack = errors[0].stack;
    throw composite;
  }

  // Write PID file
  if (children.length > 0 || nexusManaged) {
    const pidData = {
      parentPid: process.pid,
      children: children.map((c) => ({ name: c.name, pid: c.pid })),
      startedAt: new Date().toISOString(),
      nexusManaged,
    };
    writeFileSync(pidFilePath, `${JSON.stringify(pidData, null, 2)}\n`, "utf-8");
  }

  const result: RunningServices = {
    children,
    nexusManaged,
    nexusStartedThisCall,
    projectRoot,
    pidFilePath,
    ...(resolvedNexusUrl !== undefined ? { resolvedNexusUrl } : {}),
  };
  // Cache for same-process re-entry so a second startServices(groveDir)
  // call from the same TUI returns this same handle instead of an empty
  // shell that would orphan the children on cleanup.
  SAME_PROCESS_REGISTRY.set(groveDir, result);
  return result;
}

// ---------------------------------------------------------------------------
// Stop services
// ---------------------------------------------------------------------------

/**
 * Gracefully stop all running services.
 *
 * Sends SIGTERM, waits up to 5 seconds, then SIGKILL.
 * Also stops managed Nexus and cleans up the PID file.
 */
export async function stopServices(services: RunningServices): Promise<void> {
  const { children, nexusManaged, nexusStartedThisCall, projectRoot, pidFilePath } = services;

  // Only stop children THIS startServices invocation actually spawned.
  // Adopted children belong to a prior owner (e.g. another TUI process
  // that is still using them); killing them on our routine cleanup
  // would silently disrupt that owner's session. Same for nexusDown:
  // gated on nexusStartedThisCall, not nexusManaged.
  const ownedChildren = children.filter((c) => c.acquired === "spawned");

  // SIGTERM owned children
  for (const child of ownedChildren) {
    try {
      child.proc.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }
  }

  // Wait for graceful shutdown (max 5s), then SIGKILL
  const deadline = Date.now() + 5_000;
  for (const child of ownedChildren) {
    const remaining = Math.max(0, deadline - Date.now());
    const exited = await Promise.race([
      child.proc.exited,
      new Promise((resolve) => setTimeout(() => resolve(false), remaining)),
    ]);
    if (exited === false) {
      try {
        child.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  // Stop managed Nexus only if we actually started it this call.
  if (nexusManaged && nexusStartedThisCall) {
    try {
      const { nexusDown } = await import("../cli/nexus-lifecycle.js");
      await nexusDown(projectRoot);
    } catch {
      /* ignore — nexus down is best-effort */
    }
  }

  // Pidfile policy under mixed ownership:
  //   - If adopted children remain live: rewrite the pidfile with ONLY
  //     the adopted entries so subsequent identity checks + `grove down`
  //     can still find them. Unlinking would orphan the adopted services
  //     with no record.
  //   - If we acquired anything (spawned or started Nexus) AND no
  //     adopted children remain: unlink (we cleaned up everything we
  //     owned).
  //   - Pure-borrower call (no spawned, no nexusStartedThisCall): leave
  //     the original owner's pidfile alone.
  const adoptedLive = children.filter((c) => {
    if (c.acquired !== "adopted") return false;
    try {
      process.kill(c.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const owned = ownedChildren.length > 0 || (nexusManaged && nexusStartedThisCall);
  if (adoptedLive.length > 0) {
    try {
      const existing = (() => {
        try {
          return JSON.parse(readFileSync(pidFilePath, "utf-8")) as Record<string, unknown>;
        } catch {
          return {} as Record<string, unknown>;
        }
      })();
      const rewritten = {
        ...existing,
        children: adoptedLive.map((c) => ({ name: c.name, pid: c.pid })),
        startedAt: existing.startedAt ?? new Date().toISOString(),
      };
      writeFileSync(pidFilePath, `${JSON.stringify(rewritten, null, 2)}\n`, "utf-8");
    } catch {
      /* best-effort */
    }
  } else if (owned) {
    try {
      unlinkSync(pidFilePath);
    } catch {
      /* ignore */
    }
  }
  // else: pure borrower — leave the pidfile untouched.

  // Drop the same-process registry entry so re-entry can spawn afresh.
  // Keyed by groveDir; we stored under that key during startServices.
  for (const [dir, cached] of SAME_PROCESS_REGISTRY) {
    if (cached === services) {
      SAME_PROCESS_REGISTRY.delete(dir);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Service spawning with health check
// ---------------------------------------------------------------------------

/** Default service ports. */
const DEFAULT_SERVICE_PORTS = { server: 4515, mcp: 4015 } as const;

/** Service health-check timeout (ms). */
const SERVICE_HEALTH_TIMEOUT_MS = 10_000;

/**
 * Per-probe ceilings for adoption-path checks. Split into two tiers:
 *
 * **Cheap transport probes** (tight): TCP connect, lsof — these are kernel-
 *   speed on localhost. Tight ceilings let an unbound port fall through to
 *   the spawn path immediately (issue #219).
 * **Semantic probes** (looser): authenticated HTTP that hits a DB / external
 *   Nexus that can be slow under load. A tight ceiling here would mis-
 *   classify a valid-but-slow listener as foreign (review round 1).
 *
 * Treat timeout on semantic probes as INDETERMINATE — not a definitive
 * "foreign" verdict.
 */
const PROBE_TIMEOUTS = {
  /** TCP connect probe against localhost in isPortBound. */
  portBindSocketMs: 300,
  /** lsof spawnSync timeout in getListeningPid + describePortOwner. */
  lsofMs: 800,
  /**
   * HTTP fetch against localhost grove-server in verifyServerOwnership.
   * This is a semantic probe: /api/list?kind=Claim enumerates store state
   * and can be slow under load. Keep generous to avoid declaring a valid
   * but slow same-project server foreign.
   */
  ownershipFetchMs: 2_000,
  /**
   * HTTP fetch against Nexus /health on the reuse fast path. config.nexusUrl
   * may point at an externally-managed Nexus that responds slower than a
   * local container; treat sub-3s timeout as failure-to-confirm, not proof
   * of absence (caller falls through to ensureNexusRunning).
   */
  nexusHealthFetchMs: 3_000,
} as const;

/** Resolve the port a managed service should bind to. */
export function resolveServicePort(name: string, env: NodeJS.ProcessEnv = process.env): number {
  if (name === "server") return parsePort(env.PORT, DEFAULT_SERVICE_PORTS.server);
  if (name === "mcp") return parsePort(env.MCP_PORT, DEFAULT_SERVICE_PORTS.mcp);
  return 0;
}

/** Resolve the Bun executable used to spawn managed services. */
export function resolveBunExecutable(execPath: string = process.execPath): string {
  return basename(execPath) === "bun" ? execPath : "bun";
}

function serviceEnv(name: string, groveDir: string): NodeJS.ProcessEnv {
  const port = resolveServicePort(name);
  // Propagate the server's bound port (as resolved by the parent — the same
  // value the server child receives via PORT) so siblings like the MCP
  // child can target grove-server even on non-default deployments. Without
  // this the cross-process WatchHub bridge in mcp/serve*.ts hard-codes the
  // 4515 default and silently misses any custom-port server.
  const serverPort = resolveServicePort("server");
  return {
    ...process.env,
    GROVE_DIR: groveDir,
    PORT: String(port),
    GROVE_SERVER_PORT: String(serverPort),
  };
}

/** Verdict from waitForOwnedReadiness — see function doc. */
type OwnedReadiness =
  | { ok: true }
  | { ok: false; kind: "no-listener" }
  | { ok: false; kind: "child-exited" }
  | { ok: false; kind: "owned-by-foreign"; foreignPid: number; owner: string }
  | { ok: false; kind: "owned-but-unhealthy"; lastStatus: number; lastBody: string };

/**
 * Race-free readiness check for a spawned service (issue #219, review rounds 2-3).
 *
 * Uses the `Grove-Server-Pid` header that grove-server + grove-mcp-http now
 * include on every /health response. This is strictly stronger than the
 * round-2 lsof bracketing: the response itself proves WHICH process answered.
 *
 * Verdicts:
 *   - ok                    header PID matches spawnedPid AND status is 2xx
 *   - child-exited          spawnedPid no longer alive
 *   - owned-but-unhealthy   header PID matches BUT /health returned non-2xx
 *                           across `OWNED_UNHEALTHY_REPEATS` polls — the
 *                           process is ours, the service is degraded; do NOT
 *                           classify as bind-race
 *   - owned-by-foreign      header PID stayed different across
 *                           `FOREIGN_STABILITY_REPEATS` consecutive polls
 *   - no-listener           deadline exceeded without any /health response
 *
 * Falls back to lsof ONLY when the header is missing (older child build).
 * Closes the round-3 finding that hot-path lsof failures (ENOENT, permission,
 * 800ms timeout under load) silently misclassified healthy children.
 */
async function waitForOwnedReadiness(opts: {
  port: number;
  spawnedPid: number;
  spawnedExit: Promise<number>;
  url: string;
  timeoutMs: number;
}): Promise<OwnedReadiness> {
  const { spawnedPid, spawnedExit, url, timeoutMs, port } = opts;
  const deadline = Date.now() + timeoutMs;
  const FOREIGN_STABILITY_REPEATS = 3;
  const OWNED_UNHEALTHY_REPEATS = 4;
  let foreignSeen = 0;
  let lastForeignPid = 0;
  let ownedUnhealthySeen = 0;
  let lastStatus = 0;
  let lastBody = "";
  let exited = false;
  spawnedExit.then(() => {
    exited = true;
  });
  let delay = 250;
  while (Date.now() < deadline) {
    if (exited) return { ok: false, kind: "child-exited" };
    let resp: Response | undefined;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    } catch {
      // not reachable yet — listener not bound, or transient
      await sleep(delay);
      delay = Math.min(delay * 1.5, 2_000);
      continue;
    }
    const headerPid = parseHeaderPid(resp.headers.get("Grove-Server-Pid"));
    // Path A: response carried Grove-Server-Pid — authoritative.
    if (headerPid !== undefined) {
      if (headerPid !== spawnedPid) {
        if (headerPid === lastForeignPid) {
          foreignSeen += 1;
        } else {
          lastForeignPid = headerPid;
          foreignSeen = 1;
        }
        if (foreignSeen >= FOREIGN_STABILITY_REPEATS) {
          const owner = await describePortOwner(port);
          return { ok: false, kind: "owned-by-foreign", foreignPid: headerPid, owner };
        }
      } else {
        foreignSeen = 0;
        lastForeignPid = 0;
        if (resp.ok) return { ok: true };
        // Owned by us BUT degraded (e.g. grove-server 503 from store error).
        // Don't conflate with bind-race; track distinctly.
        lastStatus = resp.status;
        try {
          lastBody = (await resp.text()).slice(0, 500);
        } catch {
          lastBody = "";
        }
        ownedUnhealthySeen += 1;
        if (ownedUnhealthySeen >= OWNED_UNHEALTHY_REPEATS) {
          return { ok: false, kind: "owned-but-unhealthy", lastStatus, lastBody };
        }
      }
    } else {
      // Path B: response without Grove-Server-Pid header (older child, or
      // probe served by a foreign listener that doesn't speak our protocol).
      // Fall back to lsof, but only as a hint: lsof failure here is NOT
      // treated as authoritative.
      if (!resp.ok) {
        await sleep(delay);
        delay = Math.min(delay * 1.5, 2_000);
        continue;
      }
      const probe = await probeListenerPid(port);
      if (probe.kind === "pid") {
        if (probe.pid === spawnedPid) return { ok: true };
        if (probe.pid === lastForeignPid) foreignSeen += 1;
        else {
          lastForeignPid = probe.pid;
          foreignSeen = 1;
        }
        if (foreignSeen >= FOREIGN_STABILITY_REPEATS) {
          const owner = await describePortOwner(port);
          return { ok: false, kind: "owned-by-foreign", foreignPid: probe.pid, owner };
        }
      }
      // probe.kind === "no-listener" | "unavailable" → indeterminate, keep polling
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 2_000);
  }
  // Deadline exceeded.
  if (exited) return { ok: false, kind: "child-exited" };
  if (ownedUnhealthySeen > 0) {
    return { ok: false, kind: "owned-but-unhealthy", lastStatus, lastBody };
  }
  const probe = await probeListenerPid(port);
  if (probe.kind === "pid" && probe.pid !== spawnedPid) {
    const owner = await describePortOwner(port);
    return { ok: false, kind: "owned-by-foreign", foreignPid: probe.pid, owner };
  }
  return { ok: false, kind: "no-listener" };
}

function parseHeaderPid(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Typed listener probe — distinguishes "no listener" from "lsof failed". */
type ListenerProbe =
  | { kind: "pid"; pid: number }
  | { kind: "no-listener" }
  | { kind: "unavailable"; reason: string };

async function probeListenerPid(port: number): Promise<ListenerProbe> {
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUTS.lsofMs,
    });
    if (r.error) return { kind: "unavailable", reason: r.error.message };
    if (r.signal) return { kind: "unavailable", reason: `lsof killed by ${r.signal}` };
    if (r.status === null) return { kind: "unavailable", reason: "lsof timeout" };
    const first = (r.stdout ?? "").trim().split(/\s+/)[0];
    if (!first) {
      // lsof exit code 1 + empty stdout = no listener (normal). Any other
      // non-zero exit = probe failure.
      if (r.status === 1) return { kind: "no-listener" };
      if (r.status !== 0) return { kind: "unavailable", reason: `lsof exit ${r.status}` };
      return { kind: "no-listener" };
    }
    const pid = Number.parseInt(first, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { kind: "unavailable", reason: `lsof stdout parse failed: ${first}` };
    }
    return { kind: "pid", pid };
  } catch (err) {
    return { kind: "unavailable", reason: (err as Error).message };
  }
}

/**
 * Bounded SIGTERM → wait → SIGKILL of a child we spawned. Uses the actual
 * `exited` promise to stop signalling once the child reaps, so a PID reuse
 * (OS recycling the spawned PID before our SIGKILL fires) cannot signal an
 * unrelated user process — round-3 finding.
 */
async function terminateChild(
  pid: number,
  exited: Promise<number>,
  deadlineMs: number = 3_000,
): Promise<void> {
  let isExited = false;
  exited.then(() => {
    isExited = true;
  });
  if (isExited) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  const winner = await Promise.race([
    exited.then(() => "exited" as const),
    sleep(deadlineMs).then(() => "timeout" as const),
  ]);
  if (winner === "exited") return;
  // Re-check the exit flag after the race — Promise.race resolves on the
  // first settle but our `.then(() => isExited=true)` above may have run
  // microseconds later; avoid signalling an exited+reaped child by reuse.
  if (isExited) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Poll a /health endpoint until it returns 200 OK or the timeout expires.
 *
 * Uses exponential backoff starting at 250ms. Does not throw on timeout —
 * the caller checks process liveness separately.
 */
async function waitForServiceHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 2_000);
  }
  // Timeout — caller will check process.kill(pid, 0) to determine liveness
}

function waitForChildExit(child: NodeChildProcess): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("exit", (code) => finish(code ?? 0));
    child.once("error", () => finish(1));
  });
}

/**
 * Probe a running grove-server to confirm it's the same project's namespace
 * we belong to. Fails closed against:
 *   1. No project api-key on disk → can't prove ownership.
 *   2. Listener returns 2xx for a bogus bearer → not enforcing auth, foreign.
 *   3. Listener rejects (401/403/4xx/5xx) our project key → foreign registry.
 *   4. Listener accepts our key but the response shape isn't Grove's
 *      ListResponse → not grove-server.
 * Only an authenticated request that returns the expected Grove list shape
 * counts as ownership-proven.
 */
export async function verifyServerOwnership(
  port: number,
  groveDir: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let apiKey: string | undefined;
  try {
    const { readClientKey } = await import("../core/project-key.js");
    apiKey = readClientKey(groveDir);
  } catch {
    /* fall through */
  }
  if (!apiKey) {
    return { ok: false, reason: `No api-key in ${groveDir} to verify ownership.` };
  }

  const url = `http://localhost:${port}/api/list?kind=Claim`;

  // Step 1: bogus-key probe. A correctly-auth-enforcing grove-server must
  // reject this with 401 (NamespaceUnauthorizedError). If the listener
  // accepts a random key with 2xx, it's not enforcing auth — almost
  // certainly a different service squatting on the port.
  try {
    const bogus = await fetch(url, {
      headers: { Authorization: "Bearer grv_NOT_A_REAL_KEY_ownership_probe" },
      signal: AbortSignal.timeout(PROBE_TIMEOUTS.ownershipFetchMs),
    });
    if (bogus.ok) {
      return {
        ok: false,
        reason: `Listener returned ${bogus.status} for a bogus bearer token — auth is not enforced; this is not a grove-server.`,
      };
    }
  } catch (err) {
    return { ok: false, reason: `Bogus-key probe failed: ${(err as Error).message ?? err}` };
  }

  // Step 2: real-key probe. Must succeed AND return the Grove ListResponse
  // shape ({items: array, listResourceVersion: string}). Anything else is
  // a foreign listener that happens to 401 strangers but doesn't speak
  // our protocol.
  let resp: Response | null = null;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUTS.ownershipFetchMs),
    });
  } catch (err) {
    return { ok: false, reason: `Auth probe failed: ${(err as Error).message ?? err}` };
  }
  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      reason: `Listener returned ${resp.status} for our API key — its key registry doesn't include us.`,
    };
  }
  if (!resp.ok) {
    return { ok: false, reason: `Auth probe got HTTP ${resp.status}.` };
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return { ok: false, reason: "Auth probe response was not JSON; not a grove-server." };
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { items?: unknown }).items) ||
    typeof (body as { listResourceVersion?: unknown }).listResourceVersion !== "string"
  ) {
    return {
      ok: false,
      reason: "Auth probe response shape doesn't match Grove ListResponse; not a grove-server.",
    };
  }
  return { ok: true };
}

/**
 * Best-effort: identify the process holding a TCP port via `lsof`. Returns
 * a human-readable string for error messages; never throws.
 */
async function describePortOwner(port: number): Promise<string> {
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN", "-Pn"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUTS.lsofMs,
    });
    const out = (r.stdout ?? "").trim();
    if (!out) return "(lsof returned no listeners)";
    const lines = out.split("\n").slice(0, 3); // header + first match
    return lines.join(" | ");
  } catch (err) {
    return `(lsof unavailable: ${(err as Error).message ?? err})`;
  }
}

/**
 * Get the PID of the process listening on a TCP port via `lsof -ti`.
 * Returns undefined if no listener or lsof unavailable.
 */
async function getListeningPid(port: number): Promise<number | undefined> {
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUTS.lsofMs,
    });
    const first = (r.stdout ?? "").trim().split(/\s+/)[0];
    const pid = first ? Number.parseInt(first, 10) : Number.NaN;
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identity-based ownership check: compare the PID listening on `port` to
 * the PID recorded in our pidfile for the named service. Fails closed when
 * the pidfile is absent (fresh startup, but the port is bound = foreign by
 * definition) or when PIDs don't match.
 *
 * Crucially: this check sends NO credentials. The credentialed
 * verifyServerOwnership check is reserved for the pidfile-reuse path,
 * where PID identity has already been confirmed by the parent-alive +
 * child-alive guards in startServices.
 */
export async function verifyPortIdentity(
  port: number,
  pidFilePath: string,
  serviceName: string,
): Promise<{ ok: true; pid: number } | { ok: false; reason: string }> {
  const listeningPid = await getListeningPid(port);
  if (!listeningPid) {
    return { ok: false, reason: `Could not identify the process on port ${port}.` };
  }
  let pidData: { children?: ReadonlyArray<{ name?: string; pid?: number }> } | undefined;
  try {
    const text = readFileSync(pidFilePath, "utf-8");
    pidData = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: `No pidfile record at ${pidFilePath}; the listener wasn't spawned by this grove project.`,
    };
  }
  const recorded = pidData?.children?.find((c) => c.name === serviceName);
  if (!recorded?.pid) {
    return {
      ok: false,
      reason: `Pidfile has no record of "${serviceName}"; the listener on port ${port} (PID ${listeningPid}) is foreign.`,
    };
  }
  if (recorded.pid !== listeningPid) {
    return {
      ok: false,
      reason: `Pidfile records ${serviceName} PID=${recorded.pid} but port ${port} is held by PID ${listeningPid}; foreign listener.`,
    };
  }
  return { ok: true, pid: listeningPid };
}

/**
 * Detect whether a TCP port has any listener. Returns true on a successful
 * connection, false on ECONNREFUSED/timeout. Independent of HTTP — covers
 * the case where a process is bound but its /health returns 404/500 or
 * isn't HTTP at all.
 */
async function isPortBound(port: number): Promise<boolean> {
  const { Socket } = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const sock = new Socket();
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    sock.setTimeout(PROBE_TIMEOUTS.portBindSocketMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
}

/**
 * Wrap an already-running PID we adopted as ours into the same shape as a
 * Bun.spawn return so stopServices / rollback can kill it via the standard
 * SIGTERM → wait → SIGKILL flow. Bun.spawn isn't available for arbitrary
 * PIDs, so we synthesize the necessary surface (kill, exited).
 */
function adoptExistingChild(
  name: string,
  pid: number,
): ManagedChildProcess & { acquired: "adopted" } {
  const exited = new Promise<number>((resolve) => {
    // Poll-based exit detection: probe with signal 0 every 250ms until
    // process.kill throws. Cheap and accurate for our shutdown timing
    // (we only need it during stopServices/rollback).
    const tick = () => {
      try {
        process.kill(pid, 0);
        setTimeout(tick, 250);
      } catch {
        resolve(0);
      }
    };
    setTimeout(tick, 250);
  });
  const proc = {
    pid,
    kill: (signal?: string) => {
      try {
        process.kill(pid, (signal ?? "SIGTERM") as NodeJS.Signals);
      } catch {
        /* already dead */
      }
    },
    exited,
  } as unknown as ReturnType<typeof Bun.spawn>;
  return { name, pid, proc, acquired: "adopted" };
}

async function spawnService(
  name: string,
  entryPoint: string,
  groveDir: string,
): Promise<ManagedChildProcess | null> {
  const port = resolveServicePort(name);
  if (port) {
    // Identity gate (NO credentials): if the port is bound, the listening
    // PID must match a record in our pidfile for this service name. Any
    // mismatch — including no pidfile at all — is treated as foreign.
    // We deliberately do NOT send the project's API key to an unverified
    // listener; a port squatter that returns 401 to a bogus token would
    // otherwise receive the real key on the second probe.
    const bound = await isPortBound(port);
    if (bound) {
      const pidFilePath = join(groveDir, "grove.pid");
      const identity = await verifyPortIdentity(port, pidFilePath, name);
      if (!identity.ok) {
        const owner = await describePortOwner(port);
        throw new Error(
          `Port ${port} is bound by a process that this grove project did not spawn.\n` +
            `${identity.reason}\n` +
            `Owner: ${owner}\n` +
            `Free the port with: \`lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill\`,\n` +
            `or set PORT to an unused port and retry.`,
        );
      }
      // PID identity matches our pidfile record — but a detached child
      // can survive a crashed parent, and `grove init --force` rotates
      // .grove/api-key without removing grove.pid. After identity is
      // proven, also confirm the live server still accepts the current
      // api-key; if not, the recorded child is stale relative to the
      // current credentials and must be restarted.
      if (name === "server") {
        const ownership = await verifyServerOwnership(port, groveDir);
        if (!ownership.ok) {
          throw new Error(
            `Recorded grove-server (PID ${identity.pid}) on port ${port} no longer accepts this project's API key.\n` +
              `${ownership.reason}\n` +
              `This usually means .grove/api-key was rotated (e.g. \`grove init --force\`) while the server kept running.\n` +
              `Stop the server (\`kill ${identity.pid}\`) and retry, or rotate the running server with the new key.`,
          );
        }
      }
      // Identity + ownership both verified — adopt the existing PID into
      // our managed-child set so the rewritten pidfile records it AND
      // stopServices/grove-down can kill it. Returning null here would
      // drop the live process from RunningServices: a subsequent
      // pidfile rewrite (other children may still spawn fresh) would
      // forget the server PID, breaking shutdown.
      return adoptExistingChild(name, identity.pid);
    }
  }

  try {
    const { spawn: nodeSpawn } = await import("node:child_process");
    const { openSync } = await import("node:fs");
    const logPath = join(groveDir, `${name}.log`);
    const logFd = openSync(logPath, "a");
    const child = nodeSpawn(resolveBunExecutable(), [entryPoint], {
      cwd: join(groveDir, ".."),
      stdio: ["ignore", logFd, logFd],
      env: serviceEnv(name, groveDir),
      detached: true,
    });
    const pid = child.pid ?? 0;
    const exited = waitForChildExit(child);
    child.unref();

    // Unified readiness predicate (issue #219 review rounds 2-3). Reads
    // the Grove-Server-Pid header from /health to confirm the response
    // came from OUR spawned child, distinguishes owned-but-unhealthy from
    // bind-race, and uses the child's exit event (not raw PID polling)
    // for teardown.
    if (port) {
      const readiness = await waitForOwnedReadiness({
        port,
        spawnedPid: pid,
        spawnedExit: exited,
        url: `http://localhost:${port}/health`,
        timeoutMs: SERVICE_HEALTH_TIMEOUT_MS,
      });
      if (!readiness.ok) {
        await terminateChild(pid, exited);
        const tail = await readLogTail(join(groveDir, `${name}.log`)).catch(() => "");
        const detail = (() => {
          switch (readiness.kind) {
            case "owned-by-foreign":
              return `port held by PID ${readiness.foreignPid}; owner=${readiness.owner}`;
            case "child-exited":
              return `spawned PID ${pid} exited before binding. Last log lines:\n${tail || "(empty)"}`;
            case "owned-but-unhealthy":
              return (
                `${name} bound the port but /health returned ${readiness.lastStatus}; ` +
                `service is dependency-degraded (not a bind-race). Body: ${readiness.lastBody}`
              );
            case "no-listener":
              return `no listener bound within ${SERVICE_HEALTH_TIMEOUT_MS}ms`;
          }
        })();
        throw new Error(
          `${name} did not reach readiness on port ${port}: ${detail}\n` +
            `Diagnose with: lsof -iTCP:${port} -sTCP:LISTEN`,
        );
      }
    } else {
      // No port to verify (e.g. test/stub service). Fall back to the
      // pre-round-2 liveness check.
      try {
        process.kill(pid, 0);
      } catch {
        const tail = await readLogTail(join(groveDir, `${name}.log`)).catch(() => "");
        throw new Error(`${name} exited during startup. Last log lines:\n${tail || "(empty)"}`);
      }
    }

    const proc = {
      pid,
      kill: (signal?: string) => {
        try {
          process.kill(pid, (signal ?? "SIGTERM") as NodeJS.Signals);
        } catch {
          /* already dead */
        }
      },
      exited,
    } as unknown as ReturnType<typeof Bun.spawn>;

    return { name, pid, proc, acquired: "spawned" };
  } catch (err) {
    // Re-raise foreign-port and startup-death errors so callers see them;
    // only swallow truly transient spawn errors (already covered above by
    // the broad fetch.catch for /health probes).
    if (err instanceof Error) throw err;
    throw new Error(`spawn ${name} failed: ${String(err)}`);
  }
}

/** Read the last ~20 lines of a log file for diagnostic context. */
async function readLogTail(path: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(-20).join("\n");
  } catch {
    return "";
  }
}
