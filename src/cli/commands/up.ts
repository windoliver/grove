/**
 * `grove up` command — start all grove services and TUI.
 *
 * Reads .grove/grove.json, spawns server + MCP processes in parallel,
 * health-checks each service, then launches the TUI as the foreground process.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { parseGroveConfig } from "../../core/config.js";
import { resolveGroveDir } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpOptions {
  readonly headless: boolean;
  readonly noTui: boolean;
  readonly groveOverride?: string | undefined;
}

interface ChildProcess {
  readonly name: string;
  readonly pid: number;
  readonly proc: ReturnType<typeof Bun.spawn>;
}

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

function parseUpArgs(args: readonly string[]): UpOptions {
  const { values } = parseArgs({
    args: [...args],
    options: {
      headless: { type: "boolean", default: false },
      "no-tui": { type: "boolean", default: false },
      grove: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    console.log(`grove up — start all grove services

Usage:
  grove up [options]

Options:
  --headless     Start services without TUI (for CI/scripting)
  --no-tui       Start services only, no TUI
  --grove <path> Path to .grove directory
  -h, --help     Show this help message`);
    process.exit(0);
  }

  return {
    headless: values.headless as boolean,
    noTui: values["no-tui"] as boolean,
    groveOverride: values.grove as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Main handler for `grove up`. */
export async function handleUp(args: readonly string[], groveOverride?: string): Promise<void> {
  const opts = parseUpArgs(args);
  const effectiveGrove = opts.groveOverride ?? groveOverride;

  // Resolve grove directory
  const { groveDir } = resolveGroveDir(effectiveGrove);
  const configPath = join(groveDir, "grove.json");

  if (!existsSync(configPath)) {
    throw new Error(
      "No grove.json found. Run 'grove init' first, or 'grove init --preset <name>' for a quick start.",
    );
  }

  const raw = readFileSync(configPath, "utf-8");
  const config = parseGroveConfig(raw);

  const children: ChildProcess[] = [];
  const pidFilePath = join(groveDir, "grove.pid");

  // Graceful shutdown handler
  const shutdown = async () => {
    process.stderr.write("\nShutting down...\n");
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
        const { nexusDown } = await import("../nexus-lifecycle.js");
        process.stderr.write("Stopping Nexus...\n");
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
  };

  process.on("SIGINT", () => {
    shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().then(() => process.exit(0));
  });

  // Start managed Nexus if configured
  const projectRoot = join(groveDir, "..");
  let nexusManaged = false;
  if (config.nexusManaged || (config.mode === "nexus" && !config.nexusUrl)) {
    const { ensureNexusRunning } = await import("../nexus-lifecycle.js");
    const nexusUrl = await ensureNexusRunning(projectRoot, config);
    nexusManaged = true;
    // Expose the discovered URL so resolveBackend (env step) picks it up
    // when launching the TUI. This is the bridge between the managed-Nexus
    // lifecycle and the TUI's backend resolution chain.
    process.env.GROVE_NEXUS_URL = nexusUrl;
  }

  // Everything after Nexus startup is wrapped in try/catch so we
  // call shutdown() (including nexus down) if a later step throws.
  try {
    // Spawn services in parallel
    const spawnPromises: Promise<ChildProcess | null>[] = [];

    if (config.services?.server) {
      spawnPromises.push(spawnService("server", "src/server/serve.ts", groveDir));
    }

    if (config.services?.mcp) {
      spawnPromises.push(spawnService("mcp", "src/mcp/serve-http.ts", groveDir));
    }

    const results = await Promise.all(spawnPromises);
    for (const result of results) {
      if (result) children.push(result);
    }

    // Write PID file
    const pidData = {
      parentPid: process.pid,
      children: children.map((c) => ({ name: c.name, pid: c.pid })),
      startedAt: new Date().toISOString(),
      nexusManaged,
    };
    writeFileSync(pidFilePath, `${JSON.stringify(pidData, null, 2)}\n`, "utf-8");

    if (children.length > 0) {
      console.log(
        `Started ${children.length} service(s): ${children.map((c) => c.name).join(", ")}`,
      );
    }

    // Launch TUI or stay headless
    if (opts.headless || opts.noTui) {
      console.log("Running in headless mode. Use 'grove down' to stop.");
      // In headless mode, wait for any child to exit, then shut down all remaining
      if (children.length > 0) {
        await Promise.race(children.map((c) => c.proc.exited));
        // One child exited — shut down all remaining services cleanly
        await shutdown();
      }
    } else {
      // Launch TUI as foreground
      const { handleTui } = await import("../../tui/main.js");
      await handleTui([], effectiveGrove);

      // TUI exited — shut down services
      await shutdown();
    }
  } catch (err) {
    // Ensure managed Nexus + child processes are cleaned up on failure
    await shutdown();
    throw err;
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
      const stderr = await new Response(proc.stderr).text();
      process.stderr.write(`Warning: ${name} service exited immediately: ${stderr.trim()}\n`);
      return null;
    }

    return { name, pid: proc.pid, proc };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: Failed to start ${name} service: ${msg}\n`);
    return null;
  }
}
