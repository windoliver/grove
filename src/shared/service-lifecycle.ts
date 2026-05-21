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

/**
 * In-flight startServices promises keyed by groveDir. Two concurrent
 * callers in the same process for the same grove would otherwise both
 * see "no pidfile" and double-spawn. By awaiting the same promise, the
 * second caller gets the first caller's settled RunningServices.
 * Cleared once startServices fully resolves. (#191 round 5.)
 */
const SAME_PROCESS_IN_FLIGHT = new Map<string, Promise<RunningServices>>();

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

  // In-flight de-dup: two concurrent callers for the same groveDir must
  // not both pre-resolve+spawn — they'd race on `pickFreePort` and one
  // would lose the bind race. Pin the first call's promise here; the
  // second caller awaits it and gets the same RunningServices.
  const inFlight = SAME_PROCESS_IN_FLIGHT.get(groveDir);
  if (inFlight) return inFlight;
  const work = startServicesUnlocked(options);
  SAME_PROCESS_IN_FLIGHT.set(groveDir, work);
  try {
    return await work;
  } finally {
    SAME_PROCESS_IN_FLIGHT.delete(groveDir);
  }
}

async function startServicesUnlocked(options: ServiceStartOptions): Promise<RunningServices> {
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

  // Pre-resolve each service's port BEFORE the parallel spawn. Without this,
  // server+MCP race: MCP can read GROVE_SERVER_PORT before server's own
  // foreign-port fallback writes the new value, leaving MCP pointing at the
  // old default port (held by a foreign process). Resolving sequentially
  // here mutates process.env so every subsequent serviceEnv() call sees
  // the settled values. (#191 follow-up.)
  let serverPortShifted = false;
  if (config.services?.server) {
    const before = resolveServicePort("server");
    const after = await preResolvePort("server", groveDir);
    serverPortShifted = before !== after;
  }
  if (config.services?.mcp) {
    await preResolvePort("mcp", groveDir);
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
    // If the server was rebound to a fallback port, an adopted MCP from a
    // prior run still points its bridge at the old GROVE_SERVER_PORT
    // (set in its env at start). Force-restart MCP in that case so its
    // bridge URL matches the freshly-resolved server port.
    spawnPromises.push(
      spawnService("mcp", resolveEntry("src/mcp/serve-http.ts"), groveDir, {
        forceFreshSpawn: serverPortShifted,
      }),
    );
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
    // Route through the verified terminateChild helper (round 9): the old
    // raw-kill loop swallowed delivery errors and never confirmed the
    // SIGKILL postcondition, so a sandboxed/D-state sibling that survived
    // would be silently leaked.
    const rollbackSurvivors: ManagedChildProcess[] = [];
    await Promise.all(
      toKill.map(async (child) => {
        const result = await terminateChild(
          {
            pid: child.pid,
            kill: (sig: NodeJS.Signals) => child.proc.kill(sig),
            exited: child.proc.exited,
          },
          ROLLBACK_DEADLINE_MS,
        );
        if (!result.ok) {
          rollbackSurvivors.push(child);
          report(
            `[startServices] rollback: ${child.name} (PID ${child.pid}) survived teardown: ${result.reason}`,
          );
        }
      }),
    );
    // Persist any rollback survivors to grove.pid so the next grove
    // up/down can target them, instead of leaving them as untracked
    // orphan listeners.
    if (rollbackSurvivors.length > 0) {
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
          children: rollbackSurvivors.map((c) => ({ name: c.name, pid: c.pid })),
          startedAt: existing.startedAt ?? new Date().toISOString(),
        };
        writeFileSync(pidFilePath, `${JSON.stringify(rewritten, null, 2)}\n`, "utf-8");
      } catch {
        /* best-effort */
      }
    }
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

  // Write PID file ONLY if this call actually spawned something new (a
  // child or Nexus). Pure-adoption callers (every service was already
  // running and we just attached) must not rewrite parentPid — doing so
  // steals ownership from the original live owner, and the force-fresh
  // classifier later trusts parentPid liveness to decide whether to
  // preserve a sibling's MCP. (#191 round 6.)
  const spawnedSomething = children.some((c) => c.acquired === "spawned");
  if (spawnedSomething || nexusStartedThisCall) {
    const resolvedServerPort = resolveServicePort("server");
    // Read existing pidfile to merge metadata for adopted entries —
    // preserve their original port / serverPort so the schema doesn't
    // downgrade when we add a freshly-spawned sibling alongside them.
    let existing: Record<string, unknown> = {};
    let existingChildren: ReadonlyArray<Record<string, unknown>> = [];
    if (existsSync(pidFilePath)) {
      try {
        existing = JSON.parse(readFileSync(pidFilePath, "utf-8")) as Record<string, unknown>;
        if (Array.isArray(existing.children)) {
          existingChildren = existing.children as ReadonlyArray<Record<string, unknown>>;
        }
      } catch {
        /* malformed pidfile — fall through and write fresh */
      }
    }
    // Per-child parentPid: spawned children belong to this process;
    // adopted children retain their original owner from the prior
    // pidfile (or the prior top-level parentPid when no per-child owner
    // is recorded yet — older pidfile schema). The classifier reads the
    // CHILD's recorded parentPid, so a later run can't mistake an
    // adopted-from-sibling MCP for one orphaned by this process's exit.
    // (#191 round 9.)
    const priorTopParent = typeof existing.parentPid === "number" ? existing.parentPid : undefined;
    const pidData = {
      parentPid: process.pid,
      children: children.map((c) => {
        if (c.acquired === "adopted") {
          const prior = existingChildren.find((x) => x.name === c.name && x.pid === c.pid);
          if (prior) {
            const ownerPid = typeof prior.parentPid === "number" ? prior.parentPid : priorTopParent;
            return {
              ...prior,
              name: c.name,
              pid: c.pid,
              ...(ownerPid ? { parentPid: ownerPid } : {}),
            };
          }
        }
        return {
          name: c.name,
          pid: c.pid,
          parentPid: process.pid,
          port: resolveServicePort(c.name) || undefined,
          ...(c.name === "mcp" && resolvedServerPort ? { serverPort: resolvedServerPort } : {}),
        };
      }),
      startedAt: existing.startedAt ?? new Date().toISOString(),
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

  // Verified termination (round 8): route routine shutdown through the
  // same terminateChild helper as readiness-failure cleanup so SIGKILL
  // post-conditions are checked and survivors are surfaced. Without this,
  // a sandboxed/D-state child that ignores SIGKILL would have its pidfile
  // entry deleted while still bound to its port, orphaning the listener.
  const stopSurvivors: ManagedChildProcess[] = [];
  await Promise.all(
    ownedChildren.map(async (child) => {
      const result = await terminateChild(
        {
          pid: child.pid,
          kill: (sig: NodeJS.Signals) => child.proc.kill(sig),
          exited: child.proc.exited,
        },
        5_000,
      );
      if (!result.ok) {
        process.stderr.write(
          `stopServices: ${child.name} (PID ${child.pid}) survived teardown: ${result.reason}\n`,
        );
        stopSurvivors.push(child);
      }
    }),
  );

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
  //   - Adopted-live children OR spawned-children-that-survived-teardown:
  //     rewrite the pidfile with those entries. Unlinking would orphan
  //     listeners with no record (round 8: stopServices survivors had
  //     no recovery path).
  //   - If we acquired anything (spawned or started Nexus) AND no live
  //     adopted/survivor entries: unlink (we cleaned up everything we
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
  // Merge both branches' preserve sets:
  //   - adoptedLive: live children we attached to but did not spawn (#191)
  //   - stopSurvivors: spawned children that survived our verified teardown
  //     and would otherwise become untracked orphan listeners (#219 round 9)
  // Pure borrowers (owned=false) must NOT touch grove.pid — it belongs
  // to the live owner (#191 round 7).
  const preserveEntries = [
    ...adoptedLive.map((c) => ({ name: c.name, pid: c.pid })),
    ...stopSurvivors.map((c) => ({ name: c.name, pid: c.pid })),
  ];
  if (owned && preserveEntries.length > 0) {
    try {
      const existing = (() => {
        try {
          return JSON.parse(readFileSync(pidFilePath, "utf-8")) as Record<string, unknown>;
        } catch {
          return {} as Record<string, unknown>;
        }
      })();
      // Preserve per-child metadata (port, serverPort) from the prior
      // pidfile so the next force-fresh classification can still tell
      // whether an adopted MCP is bridged to the right server. Without
      // this, the schema downgrade would push the classifier into the
      // older-pidfile killable path on subsequent runs. (#191 round 5.)
      const existingChildren = Array.isArray(existing.children)
        ? (existing.children as ReadonlyArray<Record<string, unknown>>)
        : [];
      const rewritten = {
        ...existing,
        children: preserveEntries.map((c) => {
          const prior = existingChildren.find((x) => x.name === c.name && x.pid === c.pid);
          return prior ? { ...prior, name: c.name, pid: c.pid } : { name: c.name, pid: c.pid };
        }),
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
/** Result returned by terminateChild — see function docs. */
type TerminateResult =
  | { ok: true; how: "already-exited" | "sigterm" | "sigkill" }
  | { ok: false; reason: string; stillAlive: boolean };

/** Process surface terminateChild operates on — pluggable for tests. */
interface TerminationTarget {
  readonly pid: number;
  /** Signal delivery — mirrors child_process kill / process.kill. */
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly exited: Promise<number>;
}

async function terminateChild(
  target: TerminationTarget,
  deadlineMs: number = 3_000,
): Promise<TerminateResult> {
  const { pid, kill, exited } = target;
  let isExited = false;
  exited.then(() => {
    isExited = true;
  });
  await Promise.resolve();
  if (isExited) return { ok: true, how: "already-exited" };

  try {
    kill("SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: true, how: "already-exited" };
    return { ok: false, reason: `SIGTERM failed: ${code ?? String(err)}`, stillAlive: true };
  }

  const winner = await Promise.race([
    exited.then(() => "exited" as const),
    sleep(deadlineMs).then(() => "timeout" as const),
  ]);
  if (winner === "exited") return { ok: true, how: "sigterm" };

  await Promise.resolve();
  if (isExited) return { ok: true, how: "sigterm" };

  try {
    kill("SIGKILL");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: true, how: "already-exited" };
    return { ok: false, reason: `SIGKILL failed: ${code ?? String(err)}`, stillAlive: true };
  }

  // Round 7 postcondition: confirm the child actually exited. SIGKILL
  // delivery is asynchronous on macOS/Linux; a sandboxed/D-state process
  // can survive the signal call and orphan the listener.
  const sigkillDeadline = Date.now() + 1_500;
  while (Date.now() < sigkillDeadline) {
    await Promise.resolve();
    if (isExited) return { ok: true, how: "sigkill" };
    if (pid > 0) {
      try {
        process.kill(pid, 0);
      } catch {
        return { ok: true, how: "sigkill" };
      }
    }
    await sleep(50);
  }
  return {
    ok: false,
    reason: `process ${pid} still alive 1.5s after SIGKILL`,
    stillAlive: true,
  };
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
    const r = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
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
/**
 * Ask the OS for an unused TCP port.
 *
 * Used as the auto-fallback when the configured service port (PORT for
 * server, MCP_PORT for mcp) is held by a foreign process — typically
 * another grove worktree on the same host. Without this, `grove up`
 * would fail with "Port X is bound by a process that this grove project
 * did not spawn"; concurrent worktrees need to coexist.
 *
 * Implementation: bind a server to port 0 (let kernel assign), read the
 * assigned port, close. Race window between close and the caller's bind
 * exists but is small in practice.
 */
export async function pickFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        srv.close();
        reject(new Error("pickFreePort: no address from listener"));
        return;
      }
      const port = addr.port;
      srv.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

/**
 * Resolve the port a service should spawn on, with foreign-owner fallback.
 *
 * Called BEFORE the parallel-spawn phase so all ports are settled (and
 * `process.env` is mutated) before any child reads serviceEnv(). Without
 * this, server and MCP race: MCP can read `GROVE_SERVER_PORT=4515` (the
 * default) and target a foreign-owned server because the server's own
 * fallback didn't write the new value to env in time. (#191 follow-up)
 *
 * Sequence:
 *   1. Read configured port (PORT for server, MCP_PORT for mcp).
 *   2. If port is free → return as-is.
 *   3. If port is bound and pidfile identity matches → return as-is (adopt).
 *   4. Otherwise → pick a free port, mutate env, return new port.
 */
async function preResolvePort(name: string, groveDir: string): Promise<number> {
  const port = resolveServicePort(name);
  if (!port) return port;
  const bound = await isPortBound(port);
  if (!bound) return port;
  const pidFilePath = join(groveDir, "grove.pid");
  const identity = await verifyPortIdentity(port, pidFilePath, name);
  if (identity.ok) return port;
  const owner = await describePortOwner(port);
  const freePort = await pickFreePort();
  process.stderr.write(
    `[grove] ${name} port ${port} held by foreign process (${owner.split("\n")[0]}); ` +
      `using free port ${freePort} instead.\n`,
  );
  const portEnvVar = name === "server" ? "PORT" : "MCP_PORT";
  process.env[portEnvVar] = String(freePort);
  if (name === "server") process.env.GROVE_SERVER_PORT = String(freePort);
  return freePort;
}

/**
 * Decide whether a port-holder discovered during forceFreshSpawn is safe
 * to terminate or must be preserved. (#191 round 4.)
 *
 * Safe to kill:
 *   - Pidfile identity matches AND parentPid is dead/this-process AND
 *     either (a) we recorded the bridge port and it's stale, or (b) no
 *     port info recorded (older pidfile — conservative-but-not-frozen).
 *
 * Must preserve:
 *   - Foreign listener (no identity match).
 *   - Pidfile identity matches BUT parentPid is a different live process
 *     (a sibling grove for the same project, e.g. a parallel TUI on
 *     fallback ports — killing its MCP would break it).
 *   - Recorded bridge port matches the current server port (the MCP is
 *     fresh enough; no shift visible to it).
 */
export async function classifyForceFreshOwner(
  identity: { ok: true; pid: number } | { ok: false; reason: string },
  name: string,
  _port: number,
  pidFilePath: string,
): Promise<
  { kind: "killable-stale"; pid: number; reason: string } | { kind: "preserve"; reason: string }
> {
  if (!identity.ok) {
    return { kind: "preserve", reason: "foreign listener" };
  }

  let pidData:
    | {
        parentPid?: number;
        children?: ReadonlyArray<{
          name?: string;
          pid?: number;
          parentPid?: number;
          serverPort?: number;
        }>;
      }
    | undefined;
  try {
    pidData = JSON.parse(readFileSync(pidFilePath, "utf-8"));
  } catch {
    // Pidfile gone or malformed at this read point. Identity already
    // matched a moment earlier, which means the pidfile DID exist then.
    // The most plausible cause of a transient read failure is a sibling
    // grove rewriting the pidfile concurrently. Fail closed: preserve
    // the listener rather than risk killing a live sibling's child.
    // (#191 round 5.)
    return { kind: "preserve", reason: "pidfile unreadable — failing closed" };
  }
  // Prefer the child's recorded parentPid (round 9 schema) over the
  // top-level parentPid. A mixed-owner pidfile may have a dead
  // top-level parent but an adopted entry whose original owner is
  // still alive — that entry must be preserved.
  const childEntry = (pidData?.children ?? []).find((c) => c.name === name);
  const ownerPid =
    typeof childEntry?.parentPid === "number" ? childEntry.parentPid : pidData?.parentPid;
  let parentAlive = false;
  if (ownerPid) {
    try {
      process.kill(ownerPid, 0);
      parentAlive = true;
    } catch {
      parentAlive = false;
    }
  }
  if (parentAlive && ownerPid !== process.pid) {
    return {
      kind: "preserve",
      reason: `recorded owner ${ownerPid} is a different live grove`,
    };
  }

  // Owner is dead or is us — this MCP is ours to manage. Cross-check the
  // recorded bridge port (if present) against the current server.
  if (name === "mcp" && childEntry?.serverPort !== undefined) {
    const currentServerPort = resolveServicePort("server");
    if (childEntry.serverPort === currentServerPort) {
      return {
        kind: "preserve",
        reason: `MCP recorded server port ${childEntry.serverPort} matches current — not stale`,
      };
    }
    return {
      kind: "killable-stale",
      pid: identity.pid,
      reason: `MCP recorded server port ${childEntry.serverPort} != current ${currentServerPort}`,
    };
  }

  return {
    kind: "killable-stale",
    pid: identity.pid,
    reason: parentAlive ? "same-process ownership" : "parent process dead",
  };
}

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
  opts?: { readonly forceFreshSpawn?: boolean },
): Promise<ManagedChildProcess | null> {
  // forceFreshSpawn: caller (startServices) detected that the upstream
  // server port shifted during pre-resolve, so any prior child of `name`
  // would still hold a stale GROVE_SERVER_PORT in its env. Skip adoption
  // and rebind to a fresh port so the new child links to the new server.
  if (opts?.forceFreshSpawn) {
    const desiredPort = resolveServicePort(name);
    if (desiredPort && (await isPortBound(desiredPort))) {
      const pidFilePath = join(groveDir, "grove.pid");
      const identity = await verifyPortIdentity(desiredPort, pidFilePath, name);
      const decision = await classifyForceFreshOwner(identity, name, desiredPort, pidFilePath);
      if (decision.kind === "killable-stale") {
        // Our own pidfile-recorded child whose recorded bridge port is
        // demonstrably stale (or whose parent process is dead). Safe to
        // terminate and reuse the port — keeping it alive would leave
        // an orphan that grove-down can no longer reach.
        process.stderr.write(
          `[grove] ${name} forced fresh spawn (server port shifted); ` +
            `killing stale ${name} pid=${decision.pid} on port ${desiredPort} ` +
            `(${decision.reason}).\n`,
        );
        try {
          process.kill(decision.pid, "SIGTERM");
        } catch {
          /* already dead */
        }
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && (await isPortBound(desiredPort))) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (await isPortBound(desiredPort)) {
          try {
            process.kill(decision.pid, "SIGKILL");
          } catch {
            /* gone */
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } else {
        // decision.kind === "preserve" — either a foreign listener or a
        // pidfile-recorded child owned by a DIFFERENT live grove parent
        // (e.g. a sibling TUI running on fallback ports for the same
        // grove). Don't disturb it; bind this run on a free port and
        // log so operators can see the divergence.
        const freePort = await pickFreePort();
        const portEnvVar = name === "server" ? "PORT" : "MCP_PORT";
        process.env[portEnvVar] = String(freePort);
        if (name === "server") process.env.GROVE_SERVER_PORT = String(freePort);
        process.stderr.write(
          `[grove] ${name} forced fresh spawn (server port shifted); ` +
            `port ${desiredPort} preserved (${decision.reason}) — using free port ${freePort}.\n`,
        );
      }
    }
  }
  const port = resolveServicePort(name);
  if (port && !opts?.forceFreshSpawn) {
    // Identity gate (NO credentials): if the port is bound, the listening
    // PID must match a record in our pidfile for this service name. Any
    // mismatch — including no pidfile at all — is treated as foreign.
    // We deliberately do NOT send the project's API key to an unverified
    // listener; a port squatter that returns 401 to a bogus token would
    // otherwise receive the real key on the second probe.
    const bound = await isPortBound(port);
    if (bound) {
      // Pre-spawn (preResolvePort) already handled the foreign-owner case
      // by rebinding to a free port. By the time spawnService runs, a
      // bound port should always be one of OUR pidfile-recorded children
      // (adoption path) or — if foreign now — a TOCTOU race that leaks
      // late. Either way we do NOT mutate process.env here: env mutation
      // after the parallel spawn is already in flight risks giving MCP
      // a stale GROVE_SERVER_PORT (#191 round 2).
      const pidFilePath = join(groveDir, "grove.pid");
      const identity = await verifyPortIdentity(port, pidFilePath, name);
      if (!identity.ok) {
        // Late TOCTOU collision — fail loudly rather than rewrite env
        // mid-spawn. preResolvePort would normally have caught this.
        const owner = await describePortOwner(port);
        throw new Error(
          `${name} port ${port} became foreign-held between pre-resolve and spawn ` +
            `(owner: ${owner.split("\n")[0]}). ${identity.reason}\n` +
            `This is a TOCTOU race; restart \`grove up\` to retry.`,
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
        // child-exited gets terminated. The startup log file
        // (`${groveDir}/${name}.log`) is preserved on disk for post-mortem.
        let cleanupError = "";
        if (readiness.kind !== "child-exited") {
          const term = await terminateChild({
            pid,
            kill: (sig: NodeJS.Signals) => process.kill(pid, sig),
            exited,
          });
          if (!term.ok) {
            // Round 7: SIGKILL failed or child survived it. The port stays
            // bound by an unmanaged PID. Make this LOUD in the error so
            // operators clean up manually before grove down/up tries again.
            cleanupError =
              `\nCLEANUP FAILED: spawned PID ${pid} could not be terminated (${term.reason}). ` +
              `Port ${port} is leaked. Run: kill -9 ${pid}; lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill -9`;
          }
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
            `Diagnose live state with: lsof -iTCP:${port} -sTCP:LISTEN${cleanupError}`,
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
