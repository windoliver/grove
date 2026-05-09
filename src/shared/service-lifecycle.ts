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
  readonly projectRoot: string;
  readonly pidFilePath: string;
  /**
   * Resolved Nexus URL after successful startup. Present when nexusManaged
   * is true and Nexus started successfully. Callers should persist this to
   * grove.json via persistNexusUrlToConfig so Resume can skip re-discovery.
   */
  readonly resolvedNexusUrl?: string | undefined;
}

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
    return { children, nexusManaged, projectRoot, pidFilePath };
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
    try {
      const pidRaw = readFileSync(pidFilePath, "utf-8");
      const pidData = JSON.parse(pidRaw) as {
        parentPid?: number;
        children?: ReadonlyArray<{ name?: string; pid?: number }>;
        nexusManaged?: boolean;
      };
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
      if (parentAlive && someChildAlive) {
        // Even when the pidfile looks valid, the reused server may have a stale
        // in-memory key registry (e.g. .grove was re-initialized while the
        // server kept running). Probe the configured port with the current
        // api-key — if the existing server doesn't accept it, fail loud
        // instead of silently 401'ing every TUI request.
        if (config.services?.server) {
          const serverPort = resolveServicePort("server");
          if (serverPort) {
            const ownership = await verifyServerOwnership(serverPort, groveDir);
            if (!ownership.ok) {
              const owner = await describePortOwner(serverPort);
              throw new Error(
                `Existing grove-server (PID ${parentPid}) on port ${serverPort} no longer accepts this project's API key.\n` +
                  `${ownership.reason}\n` +
                  `Owner: ${owner}\n` +
                  `This usually happens when .grove was re-initialized while the server kept running.\n` +
                  `Stop the server (e.g. \`kill ${parentPid}\`) and retry, or set PORT to an unused port.`,
              );
            }
          }
        }
        report(
          `[startServices] reusing services already running under PID ${parentPid} (pidfile present, alive, ownership verified)`,
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
            // best-effort
          }
        }
        return {
          children,
          nexusManaged: pidData.nexusManaged ?? false,
          projectRoot,
          pidFilePath,
          ...(config.nexusUrl !== undefined ? { resolvedNexusUrl: config.nexusUrl } : {}),
        };
      }
      if (parentPid && !parentAlive) {
        report(`[startServices] pidfile points to dead PID ${parentPid}; ignoring`);
      }
    } catch {
      // Malformed pidfile — fall through and start fresh.
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
          signal: AbortSignal.timeout(5_000),
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
    // Roll back successful spawns to keep the host clean.
    for (const child of children) {
      try {
        child.proc.kill("SIGTERM");
      } catch {
        /* idempotent */
      }
    }
    if (nexusManaged) {
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

  return { children, nexusManaged, projectRoot, pidFilePath, resolvedNexusUrl };
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
  const { children, nexusManaged, projectRoot, pidFilePath } = services;

  // SIGTERM all children
  for (const child of children) {
    try {
      child.proc.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }
  }

  // Wait for graceful shutdown (max 5s), then SIGKILL
  const deadline = Date.now() + 5_000;
  for (const child of children) {
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

  // Stop managed Nexus
  if (nexusManaged) {
    try {
      const { nexusDown } = await import("../cli/nexus-lifecycle.js");
      await nexusDown(projectRoot);
    } catch {
      /* ignore — nexus down is best-effort */
    }
  }

  // Clean up PID file
  try {
    unlinkSync(pidFilePath);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Service spawning with health check
// ---------------------------------------------------------------------------

/** Default service ports. */
const DEFAULT_SERVICE_PORTS = { server: 4515, mcp: 4015 } as const;

/** Service health-check timeout (ms). */
const SERVICE_HEALTH_TIMEOUT_MS = 10_000;

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
      signal: AbortSignal.timeout(2000),
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
      signal: AbortSignal.timeout(2000),
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
      timeout: 1500,
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
      timeout: 1500,
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
    sock.setTimeout(1500);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
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
      // PID identity matches our pidfile record — reuse silently.
      return null;
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

    // Wait for the service to pass its health check instead of sleeping blindly.
    if (port) {
      await waitForServiceHealth(`http://localhost:${port}/health`, SERVICE_HEALTH_TIMEOUT_MS);
    }

    // Verify the process is still alive after health check / timeout.
    // If it died during startup, surface the failure instead of silently
    // returning null — leaving startServices believing the service is
    // running when it isn't would only resurface as confusing 401s/timeouts
    // downstream (the same class of regression Codex flagged in round 2).
    try {
      process.kill(pid, 0); // Signal 0 = check existence
    } catch {
      const tail = await readLogTail(join(groveDir, `${name}.log`)).catch(() => "");
      throw new Error(
        `${name} exited during startup. Last log lines:\n${tail || "(empty)"}\n` +
          `Common cause: another listener on the configured port. Run: lsof -iTCP:${port} -sTCP:LISTEN`,
      );
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

    return { name, pid, proc };
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
