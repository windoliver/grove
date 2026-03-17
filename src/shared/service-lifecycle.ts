/**
 * Service lifecycle management — shared between `grove up` and the TUI.
 *
 * Handles starting HTTP server, MCP server, and managed Nexus,
 * plus graceful shutdown of all spawned processes.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

  if (!existsSync(configPath)) {
    return { children, nexusManaged, projectRoot, pidFilePath };
  }

  const raw = readFileSync(configPath, "utf-8");
  const { parseGroveConfig } = await import("../core/config.js");
  const config = parseGroveConfig(raw);

  // Start managed Nexus if configured
  if (config.nexusManaged || (config.mode === "nexus" && !config.nexusUrl)) {
    try {
      const { ensureNexusRunning } = await import("../cli/nexus-lifecycle.js");
      const nexusInfo = await ensureNexusRunning(projectRoot, config, {
        build: options.build ?? false,
        nexusSource: options.nexusSource,
        onProgress: options.onProgress,
        force: options.force,
      });
      nexusManaged = true;
      process.env.GROVE_NEXUS_URL = nexusInfo.url;
      if (nexusInfo.apiKey) {
        process.env.NEXUS_API_KEY = nexusInfo.apiKey;
      }
    } catch (err) {
      // If user explicitly asked for --build, don't silently fall back — surface the error
      if (options.build) {
        throw err;
      }
      // Otherwise fall back to local mode silently
      options.onProgress?.(`Nexus unavailable, using local mode`);
    }
  }

  // Spawn services in parallel
  const spawnPromises: Promise<ChildProcess | null>[] = [];

  if (config.services?.server) {
    options.onProgress?.("Starting HTTP server...");
    spawnPromises.push(spawnService("server", "src/server/serve.ts", groveDir));
  }

  if (config.services?.mcp) {
    options.onProgress?.("Starting MCP server...");
    spawnPromises.push(spawnService("mcp", "src/mcp/serve-http.ts", groveDir));
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
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
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
  try {
    const proc = Bun.spawn(["bun", "run", entryPoint], {
      cwd: join(groveDir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GROVE_DIR: groveDir,
      },
    });

    // Basic health check: wait for process to not immediately crash
    const healthCheck = await Promise.race([
      proc.exited.then(() => "exited" as const),
      new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 1_000)),
    ]);

    if (healthCheck === "exited") {
      return null;
    }

    return { name, pid: proc.pid, proc };
  } catch {
    return null;
  }
}
