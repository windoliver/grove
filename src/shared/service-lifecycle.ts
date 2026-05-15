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

function serviceEnv(name: string, groveDir: string, readinessToken: string): NodeJS.ProcessEnv {
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
    // Per-spawn unforgeable readiness proof — child echoes on /health, parent
    // checks. Foreign listener cannot guess this value (round-4 finding).
    GROVE_HEALTH_TOKEN: readinessToken,
  };
}

/** Verdict from waitForOwnedReadiness — see function doc. */
type OwnedReadiness =
  | { ok: true }
  | { ok: false; kind: "no-listener" }
  | { ok: false; kind: "child-exited" }
  | { ok: false; kind: "owned-by-foreign"; foreignPid: number; owner: string }
  | { ok: false; kind: "owned-but-unhealthy"; lastStatus: number; lastBody: string }
  | { ok: false; kind: "owned-but-unresponsive"; lastError: string };

/**
 * Race-free readiness check for a spawned service (issue #219, review rounds 2-5).
 *
 * **Authority model** (round 5): lsof PID attribution is the FOUNDATION.
 * /health's Grove-Health-Token is a secondary signal — useful on lsof-blind
 * hosts but never trusted on its own when lsof can speak. The env-injected
 * token can be read out of /proc/<pid>/environ by a same-UID process; a
 * spoof attempt nonetheless cannot also bind a port already held by our
 * spawned child, so requiring lsof PID match closes the leak.
 *
 * When lsof is unavailable on the host (`probe.kind === "unavailable"`),
 * the predicate degrades to token-only. Documented limitation.
 *
 * Verdicts:
 *   - ok                       lsof confirms our PID owns the port AND
 *                              /health returned 2xx (token-bearing
 *                              preferred; legacy 2xx-without-token is
 *                              accepted on PID-confirmed listener so
 *                              older child builds without /health-token
 *                              still spawn)
 *   - child-exited             spawnedExit resolved
 *   - owned-but-unhealthy      lsof confirms our PID, /health returned non-2xx
 *                              across OWNED_UNHEALTHY_REPEATS polls
 *   - owned-but-unresponsive   lsof confirms our PID but /health never
 *                              answered — dependency stall; spawnService
 *                              leaves the child running for inspection
 *   - owned-by-foreign         lsof showed a different stable PID across
 *                              FOREIGN_STABILITY_REPEATS samples
 *   - no-listener              deadline with no listener at all
 */
async function waitForOwnedReadiness(opts: {
  port: number;
  spawnedPid: number;
  spawnedExit: Promise<number>;
  readinessToken: string;
  url: string;
  timeoutMs: number;
}): Promise<OwnedReadiness> {
  const { spawnedPid, spawnedExit, readinessToken, url, timeoutMs, port } = opts;
  const deadline = Date.now() + timeoutMs;
  const FOREIGN_STABILITY_REPEATS = 3;
  const OWNED_UNHEALTHY_REPEATS = 4;
  let foreignSeen = 0;
  let lastForeignPid = 0;
  let ownedUnhealthySeen = 0;
  let lastStatus = 0;
  let lastBody = "";
  let lastFetchError = "";
  let exitCode: number | undefined;
  spawnedExit.then((code) => {
    exitCode = code;
  });
  let delay = 250;
  while (Date.now() < deadline) {
    await Promise.resolve();
    if (exitCode !== undefined) return { ok: false, kind: "child-exited" };

    // Step 1 — lsof attribution comes first. A foreign PID that holds the
    // port is the only authoritative signal that we lost the bind race;
    // accept it before doing any HTTP work that could be spoofed.
    const probe = await probeListenerPid(port);
    if (probe.kind === "pid" && probe.pid !== spawnedPid) {
      if (probe.pid === lastForeignPid) foreignSeen += 1;
      else {
        lastForeignPid = probe.pid;
        foreignSeen = 1;
      }
      if (foreignSeen >= FOREIGN_STABILITY_REPEATS) {
        const owner = await describePortOwner(port);
        return { ok: false, kind: "owned-by-foreign", foreignPid: probe.pid, owner };
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, 2_000);
      continue;
    }
    // probe is one of: pid==spawnedPid, no-listener, unavailable. Any of
    // these reset the foreign-stability counter.
    foreignSeen = 0;
    lastForeignPid = 0;

    let resp: Response | undefined;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    } catch (err) {
      lastFetchError = (err as Error).message ?? String(err);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 2_000);
      continue;
    }
    await Promise.resolve();
    if (exitCode !== undefined) return { ok: false, kind: "child-exited" };

    const responseToken = resp.headers.get("Grove-Health-Token");
    const tokenMatch = responseToken !== null && timingSafeEq(responseToken, readinessToken);
    const pidConfirmed = probe.kind === "pid" && probe.pid === spawnedPid;
    const lsofUnavailable = probe.kind === "unavailable";

    if (resp.ok) {
      // Token match + pre-fetch PID confirmation is sufficient — a spoof
      // that learned the token cannot also be the spawnedPid AND have
      // re-bound the port during the fetch window.
      if (pidConfirmed && tokenMatch) return { ok: true };
      // Tokenless legacy path (old child build): require POST-fetch lsof to
      // STILL show our PID. Without this re-check, a TOCTOU between the
      // pre-fetch sample and the response can let a foreign listener that
      // bound the port mid-fetch satisfy readiness with a generic 2xx.
      if (pidConfirmed && !tokenMatch) {
        const postProbe = await probeListenerPid(port);
        if (postProbe.kind === "pid" && postProbe.pid === spawnedPid) {
          return { ok: true };
        }
        // PID moved while we were fetching; treat as a foreign-listener
        // swap and let the next iteration's primary probe classify it.
      }
      // lsof-blind host + token match: degraded acceptance, documented
      // weakness on same-UID hosts.
      if (lsofUnavailable && tokenMatch) return { ok: true };
    } else if (pidConfirmed) {
      // Our listener BUT degraded (e.g. grove-server 503 from store error).
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
    // Else: indeterminate, keep polling.
    await sleep(delay);
    delay = Math.min(delay * 1.5, 2_000);
  }

  // Deadline exceeded. Classify based on the most recent evidence.
  await Promise.resolve();
  if (exitCode !== undefined) return { ok: false, kind: "child-exited" };
  if (ownedUnhealthySeen > 0) {
    return { ok: false, kind: "owned-but-unhealthy", lastStatus, lastBody };
  }
  const finalProbe = await probeListenerPid(port);
  if (finalProbe.kind === "pid") {
    if (finalProbe.pid === spawnedPid) {
      return {
        ok: false,
        kind: "owned-but-unresponsive",
        lastError: lastFetchError || "no /health response within deadline",
      };
    }
    const owner = await describePortOwner(port);
    return { ok: false, kind: "owned-by-foreign", foreignPid: finalProbe.pid, owner };
  }
  return { ok: false, kind: "no-listener" };
}

/** Constant-time string comparison — see waitForOwnedReadiness. */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
 * unrelated user process — round-3 finding, hardened in round 4.
 *
 * Both signal sites flush microtasks via `await Promise.resolve()` before
 * checking the exit flag, so an already-settled `exited` promise reliably
 * inhibits the signal.
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
  // Flush microtask queue so an ALREADY-settled exit promise lights up the
  // flag before we read it (round 4: .then callbacks aren't synchronous
  // even when the promise was settled at await-entry).
  await Promise.resolve();
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
  await Promise.resolve();
  if (isExited) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
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
    const { randomUUID } = await import("node:crypto");
    const logPath = join(groveDir, `${name}.log`);
    const logFd = openSync(logPath, "a");
    // Per-spawn unforgeable readiness token. Injected via env, echoed by
    // child on /health, checked by parent in waitForOwnedReadiness. A
    // foreign listener cannot guess this value, closing the round-4 finding
    // that a public Pid header alone is spoofable on an unauthenticated
    // endpoint.
    const readinessToken = randomUUID();
    const child = nodeSpawn(resolveBunExecutable(), [entryPoint], {
      cwd: join(groveDir, ".."),
      stdio: ["ignore", logFd, logFd],
      env: serviceEnv(name, groveDir, readinessToken),
      detached: true,
    });
    const pid = child.pid ?? 0;
    const exited = waitForChildExit(child);
    child.unref();

    // Unified readiness predicate (issue #219 review rounds 2-4). Token in
    // /health header is authoritative; lsof is fallback for legacy builds;
    // owned-but-unhealthy / owned-but-unresponsive distinguish dependency
    // problems from bind-races so we don't kill our own healthy child.
    if (port) {
      const readiness = await waitForOwnedReadiness({
        port,
        spawnedPid: pid,
        spawnedExit: exited,
        readinessToken,
        url: `http://localhost:${port}/health`,
        timeoutMs: SERVICE_HEALTH_TIMEOUT_MS,
      });
      if (!readiness.ok) {
        // Teardown policy (round 6): every non-ok verdict EXCEPT
        // child-exited gets terminated. Round 5 tried to preserve
        // owned-but-* children for operator inspection, but spawnService
        // throws and startServices' rollback only sees fulfilled spawn
        // promises — leaving a non-tracked child running would (a) keep
        // the port bound and (b) trigger "foreign listener" on the next
        // grove tui run. The startup log file (`${groveDir}/${name}.log`)
        // is preserved on disk for post-mortem.
        if (readiness.kind !== "child-exited") {
          await terminateChild(pid, exited);
        }
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
            case "owned-but-unresponsive":
              return (
                `${name} bound the port (PID ${pid}) but /health never responded within ` +
                `${SERVICE_HEALTH_TIMEOUT_MS}ms — dependency stall, not a bind-race. ` +
                `Last fetch error: ${readiness.lastError}`
              );
            case "no-listener":
              return `no listener bound within ${SERVICE_HEALTH_TIMEOUT_MS}ms`;
          }
        })();
        throw new Error(
          `${name} did not reach readiness on port ${port}: ${detail}\n` +
            `Startup log preserved at: ${join(groveDir, `${name}.log`)}\n` +
            `Diagnose live state with: lsof -iTCP:${port} -sTCP:LISTEN`,
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
