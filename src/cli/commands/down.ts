/**
 * `grove down` command — stop all grove services.
 *
 * Reads .grove/grove.pid, sends SIGTERM to each child PID,
 * waits for graceful shutdown, then cleans up the PID file.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveGroveDir } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PidFileData {
  readonly parentPid: number;
  readonly children: readonly { name: string; pid: number }[];
  readonly startedAt: string;
  readonly nexusManaged?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Main handler for `grove down`. */
export async function handleDown(args: readonly string[], groveOverride?: string): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      grove: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    console.log(`grove down — stop all grove services

Usage:
  grove down [options]

Options:
  --grove <path> Path to .grove directory
  -h, --help     Show this help message`);
    process.exit(0);
  }

  const effectiveGrove = (values.grove as string | undefined) ?? groveOverride;
  const { groveDir } = resolveGroveDir(effectiveGrove);
  const pidFilePath = join(groveDir, "grove.pid");

  if (!existsSync(pidFilePath)) {
    console.log("No running grove services found (no grove.pid file).");
    return;
  }

  let pidData: PidFileData;
  try {
    const raw = readFileSync(pidFilePath, "utf-8");
    pidData = JSON.parse(raw) as PidFileData;
  } catch {
    console.error("Failed to read grove.pid — removing stale PID file.");
    try {
      unlinkSync(pidFilePath);
    } catch {
      /* ignore */
    }
    return;
  }

  let stopped = 0;

  for (const child of pidData.children) {
    try {
      // Check if process is still running
      process.kill(child.pid, 0);
      // Send SIGTERM
      process.kill(child.pid, "SIGTERM");
      console.log(`Sent SIGTERM to ${child.name} (PID ${child.pid})`);
      stopped++;
    } catch {
      // Process not running
      console.log(`${child.name} (PID ${child.pid}) already stopped`);
    }
  }

  // Wait for graceful shutdown
  if (stopped > 0) {
    await waitForPids(
      pidData.children.map((c) => c.pid),
      5_000,
    );
  }

  // Stop managed Nexus if applicable
  if (pidData.nexusManaged) {
    try {
      const { nexusDown } = await import("../nexus-lifecycle.js");
      const projectRoot = join(groveDir, "..");
      console.log("Stopping Nexus...");
      await nexusDown(projectRoot);
      console.log("Nexus stopped.");
    } catch {
      /* nexus down is best-effort */
    }
  }

  // Clean up PID file
  try {
    unlinkSync(pidFilePath);
  } catch {
    /* ignore */
  }

  console.log(`Stopped ${stopped} service(s).`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForPids(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

    if (alive.length === 0) return;

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Force kill any remaining
  for (const pid of pids) {
    try {
      process.kill(pid, 0); // Check if alive
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}
