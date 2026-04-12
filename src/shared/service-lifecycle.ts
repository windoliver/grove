/**
 * Service lifecycle management — shared between `grove up` and the TUI.
 *
 * Handles starting HTTP server, MCP server, and managed Nexus,
 * plus graceful shutdown of all spawned processes.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChildProcess {
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
  readonly children: ChildProcess[];
  readonly nexusManaged: boolean;
  readonly projectRoot: string;
  readonly pidFilePath: string;
}

// ---------------------------------------------------------------------------
// Start services
// ---------------------------------------------------------------------------

/**
 * Start all configured services (HTTP server, MCP server, managed Nexus).
 *
 * Reads grove.json to determine which services to start. Returns a handle
 * for stopping services later.
 *
 * If grove.json doesn't exist or has no services configured, returns
 * an empty RunningServices (no-op shutdown).
 */
export async function startServices(options: ServiceStartOptions): Promise<RunningServices> {
  const { groveDir } = options;
  const configPath = join(groveDir, "grove.json");
  const projectRoot = join(groveDir, "..");
  const pidFilePath = join(groveDir, "grove.pid");
  const children: ChildProcess[] = [];
  let nexusManaged = false;
  process.stderr.write(
    `[startServices] groveDir=${groveDir} configExists=${existsSync(configPath)} GROVE_NEXUS_URL=${process.env.GROVE_NEXUS_URL ?? "unset"}\n`,
  );

  if (!existsSync(configPath)) {
    return { children, nexusManaged, projectRoot, pidFilePath };
  }

  const raw = readFileSync(configPath, "utf-8");
  const { parseGroveConfig } = await import("../core/config.js");
  const config = parseGroveConfig(raw);

  // Start managed Nexus if configured — skip if GROVE_NEXUS_URL already set (reuse existing).
  // Issue 3A: removed the duplicate config.nexusUrl fast-path health check that previously
  // preceded ensureNexusRunning(). ensureNexusRunning() already probes config.nexusUrl as
  // one of its candidates (including parallel probing per Issue 2A), so the outer check was
  // redundant and kept two copies of the "is Nexus healthy?" logic in sync.
  if (
    !process.env.GROVE_NEXUS_URL &&
    (config.nexusManaged || (config.mode === "nexus" && !config.nexusUrl))
  ) {
    try {
      const { ensureNexusRunning } = await import("../cli/nexus-lifecycle.js");
      const nexusInfo = await ensureNexusRunning(projectRoot, config, {
        build: options.build ?? false,
        nexusSource: options.nexusSource,
        onProgress: options.onProgress,
      });
      nexusManaged = true;
      // Only set env vars if not already configured (user may have set explicit Nexus URL)
      if (!process.env.GROVE_NEXUS_URL) {
        process.env.GROVE_NEXUS_URL = nexusInfo.url;
      }
      if (!process.env.NEXUS_API_KEY && nexusInfo.apiKey) {
        process.env.NEXUS_API_KEY = nexusInfo.apiKey;
      }
      // Issue 15A: reuse already-parsed config and raw string — avoids a redundant readFileSync.
      // Persist Nexus URL to grove.json so Resume can find it without re-discovery.
      try {
        if (config.nexusUrl !== nexusInfo.url) {
          const updated = { ...JSON.parse(raw), nexusUrl: nexusInfo.url };
          writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
        }
      } catch {
        // Best-effort — don't fail startup over config persistence
      }
    } catch (err) {
      // If user explicitly asked for --build, don't silently fall back — surface the error
      if (options.build) {
        throw err;
      }
      // Fall back to local mode — log the reason for debugging
      const errMsg = err instanceof Error ? err.message : String(err);
      options.onProgress?.(`Nexus unavailable (${errMsg}), using local mode`);
    }
  }

  // Spawn services in parallel
  const spawnPromises: Promise<ChildProcess | null>[] = [];

  // Resolve grove source root for service entry points.
  // Use process.argv[1] (the CLI entry point) not import.meta.url — bun bundles
  // inline this file into a chunk, making import.meta.url unreliable.
  // process.argv[1] = "<groveRoot>/dist/cli/main.js" or "<groveRoot>/src/cli/main.ts"
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
    process.stderr.write(
      `[startServices] spawning HTTP server: ${serverEntry} groveDir=${groveDir}\n`,
    );
    spawnPromises.push(spawnService("server", serverEntry, groveDir));
  } else {
    process.stderr.write(
      `[startServices] HTTP server NOT configured (services.server=${String(config.services?.server)})\n`,
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

  return { children, nexusManaged, projectRoot, pidFilePath };
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

async function spawnService(
  name: string,
  entryPoint: string,
  groveDir: string,
): Promise<ChildProcess | null> {
  // Check if the port is already in use (server=4515, mcp=4015)
  const defaultPorts: Record<string, number> = { server: 4515, mcp: 4015 };
  const port = defaultPorts[name];
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
    // Spawn detached so the server survives TUI exit.
    const { spawn: nodeSpawn } = await import("node:child_process");
    const child = nodeSpawn("bun", [entryPoint], {
      cwd: join(groveDir, ".."),
      stdio: "ignore",
      env: { ...process.env, GROVE_DIR: groveDir },
      detached: true,
    });
    const pid = child.pid ?? 0;
    child.unref();

    // Issue 7A: poll the health endpoint with exponential backoff instead of a blind 5s sleep.
    // In the common case (service starts in < 1s) this returns immediately rather than blocking.
    // Cap at 10s; if the service is alive but not responding to health, return it anyway.
    if (port) {
      const deadline = Date.now() + 10_000;
      let delay = 200;
      while (Date.now() < deadline) {
        try {
          const resp = await fetch(`http://localhost:${port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (resp.ok) break;
        } catch {
          // Not ready yet
        }
        // Confirm the process is still alive before waiting again
        try {
          process.kill(pid, 0);
        } catch {
          return null; // process died during startup
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 2_000);
      }
    } else {
      // No known port — brief wait then existence check
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        process.kill(pid, 0);
      } catch {
        return null;
      }
    }

    // Wrap for the ChildProcess interface
    const proc = {
      pid,
      kill: (signal?: string) => {
        try {
          process.kill(pid, (signal ?? "SIGTERM") as NodeJS.Signals);
        } catch {
          /* already dead */
        }
      },
      exited: new Promise<number>(() => {
        /* detached — never resolves from parent */
      }),
    } as unknown as ReturnType<typeof Bun.spawn>;

    return { name, pid, proc };
  } catch {
    return null;
  }
}
