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

  report(
    `[startServices] groveDir=${groveDir} configExists=${existsSync(configPath)} GROVE_NEXUS_URL=${process.env.GROVE_NEXUS_URL ?? "unset"}`,
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
        report(
          `[startServices] reusing services already running under PID ${parentPid} (pidfile present, alive)`,
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

  // Start managed Nexus if configured — skip if GROVE_NEXUS_URL already set (reuse existing)
  if (
    !process.env.GROVE_NEXUS_URL &&
    (config.nexusManaged || (config.mode === "nexus" && !config.nexusUrl))
  ) {
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

  const results = await Promise.all(spawnPromises);
  for (const result of results) {
    if (result) children.push(result);
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
  return { ...process.env, GROVE_DIR: groveDir, PORT: String(port) };
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

async function spawnService(
  name: string,
  entryPoint: string,
  groveDir: string,
): Promise<ManagedChildProcess | null> {
  const port = resolveServicePort(name);
  if (port) {
    try {
      const resp = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);
      if (resp?.ok) {
        // Service already running — skip spawn, return null (not an error)
        return null;
      }
    } catch {
      // Port not in use — proceed with spawn
    }
  }

  try {
    const { spawn: nodeSpawn } = await import("node:child_process");
    const child = nodeSpawn(resolveBunExecutable(), [entryPoint], {
      cwd: join(groveDir, ".."),
      stdio: "ignore",
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

    // Verify the process is still alive after health check / timeout
    try {
      process.kill(pid, 0); // Signal 0 = check existence
    } catch {
      return null; // Process died during startup
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
  } catch {
    return null;
  }
}
