/**
 * `grove down` command — stop all grove services.
 *
 * Reads .grove/grove.pid, sends SIGTERM to each child PID,
 * waits for graceful shutdown, then cleans up the PID file.
 *
 * Round-7 hardening: identity-checks each recorded PID against the
 * expected listening port before signalling so a PID reused by an
 * unrelated user process can't get killed. On partial failure the
 * pidfile is rewritten with the surviving entries so the next
 * grove down can finish the job.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
      force: { type: "boolean" },
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
  --force        Signal recorded PIDs even when identity cannot be verified
                 (default: refuse if lsof is unavailable, to prevent killing
                 a process that took over the PID).
  -h, --help     Show this help message`);
    process.exit(0);
  }

  const effectiveGrove = (values.grove as string | undefined) ?? groveOverride;
  const force = values.force === true;
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
  const targetedPids: number[] = [];
  const survivors: typeof pidData.children = [];

  for (const child of pidData.children) {
    // Liveness + port probe in one go (round-8): even when the recorded
    // PID is dead, the EXPECTED port may still be held by something else
    // (a recycled grove service, a foreign process). In that case we
    // cannot just unlink grove.pid — the real listener must be preserved
    // for inspection or a follow-up `grove down --force`.
    const recordedAlive = (() => {
      try {
        process.kill(child.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    const identity = await verifyChildIdentity(child.name, child.pid);

    if (!recordedAlive) {
      if (identity.portHeldBy === undefined) {
        console.log(`${child.name} (PID ${child.pid}) already stopped`);
      } else {
        console.warn(
          `${child.name} recorded PID ${child.pid} exited, but port is now ` +
            `held by PID ${identity.portHeldBy} — preserving pidfile so the ` +
            `real listener stays visible. Re-record with: grove up`,
        );
        survivors.push(child);
      }
      continue;
    }

    if (identity.outcome === "unavailable" && !force) {
      // Fail-closed (round 8): if we cannot prove identity, refuse to
      // signal. Operator can re-run with --force when they know the
      // pidfile is fresh.
      console.warn(
        `${child.name} (PID ${child.pid}) identity could not be verified ` +
          `(${identity.reason}). Refusing to signal without --force. ` +
          `Re-run with: grove down --force`,
      );
      survivors.push(child);
      continue;
    }

    if (identity.outcome === "mismatch") {
      console.warn(
        `${child.name} (PID ${child.pid}) does not own the expected port — ` +
          `assuming PID reuse and skipping. ${identity.reason}`,
      );
      survivors.push(child);
      continue;
    }

    try {
      process.kill(child.pid, "SIGTERM");
      console.log(`Sent SIGTERM to ${child.name} (PID ${child.pid})`);
      targetedPids.push(child.pid);
      stopped++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        console.log(`${child.name} (PID ${child.pid}) exited mid-down`);
      } else {
        console.warn(`SIGTERM to ${child.name} (PID ${child.pid}) failed: ${code ?? String(err)}`);
        survivors.push(child);
      }
    }
  }

  if (targetedPids.length > 0) {
    const remaining = await waitForPids(targetedPids, 5_000);
    // Anything still alive after SIGKILL is a survivor that must NOT be
    // forgotten — the pidfile is the only record future lifecycle code can
    // use to recover.
    for (const pid of remaining) {
      const child = pidData.children.find((c) => c.pid === pid);
      if (child) {
        console.error(`PID ${pid} (${child.name}) survived SIGKILL`);
        survivors.push(child);
      }
    }
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

  // Pidfile policy:
  //   - All children stopped: unlink (clean state)
  //   - Any survivor (signal failed / SIGKILL ignored / PID-reuse skip):
  //     rewrite with survivors so next `grove down` can finish the job.
  if (survivors.length === 0) {
    try {
      unlinkSync(pidFilePath);
    } catch {
      /* ignore */
    }
    console.log(`Stopped ${stopped} service(s).`);
  } else {
    try {
      const rewritten = {
        ...pidData,
        children: survivors,
      };
      writeFileSync(pidFilePath, `${JSON.stringify(rewritten, null, 2)}\n`, "utf-8");
    } catch {
      /* best-effort */
    }
    console.error(
      `Stopped ${stopped} service(s); ${survivors.length} entry(ies) preserved in grove.pid ` +
        `(SIGKILL ignored or PID-reuse skip). Run \`grove down\` again after manual cleanup.`,
    );
    process.exitCode = 1;
  }
}

/** Outcome of verifyChildIdentity — see function docs. */
type IdentityCheck =
  | { outcome: "match"; reason: string; portHeldBy: number }
  | { outcome: "mismatch"; reason: string; portHeldBy: number | undefined }
  | { outcome: "unavailable"; reason: string; portHeldBy: undefined };

/**
 * Cross-check that `pid` actually owns the TCP port we expect for the named
 * service. Uses lsof — same identity gate as service-lifecycle's adoption
 * path.
 *
 * Outcomes:
 *   - match        listening PID equals `pid`
 *   - mismatch     port held by a different PID (PID reuse) OR not bound
 *   - unavailable  lsof failed (missing, timed-out, permission denied) —
 *                  caller MUST fail closed: do not signal without --force
 *
 * Round-8: round-7 returned matched=true on unavailable (fail-open), which
 * could SIGKILL a same-UID stranger that took over the recorded PID on a
 * host without lsof. Caller now respects outcome=unavailable as a refusal.
 */
async function verifyChildIdentity(name: string, pid: number): Promise<IdentityCheck> {
  const port = (() => {
    if (name === "server") return Number.parseInt(process.env.PORT ?? "", 10) || 4515;
    if (name === "mcp") return Number.parseInt(process.env.MCP_PORT ?? "", 10) || 4015;
    return 0;
  })();
  if (!port) {
    // No port mapping for this service — degraded acceptance (treat as match
    // because there's nothing to compare against). Document if more service
    // types get added.
    return { outcome: "match", reason: "no port to verify", portHeldBy: pid };
  }
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 800,
    });
    if (r.error || r.status === null) {
      return {
        outcome: "unavailable",
        reason: `lsof unavailable (${r.error?.message ?? "timeout"})`,
        portHeldBy: undefined,
      };
    }
    const listenerPid = Number.parseInt((r.stdout ?? "").trim().split(/\s+/)[0] ?? "", 10);
    if (!Number.isFinite(listenerPid) || listenerPid <= 0) {
      return { outcome: "mismatch", reason: `port ${port} not bound`, portHeldBy: undefined };
    }
    if (listenerPid !== pid) {
      return {
        outcome: "mismatch",
        reason: `port ${port} held by PID ${listenerPid}, not ${pid}`,
        portHeldBy: listenerPid,
      };
    }
    return { outcome: "match", reason: "lsof confirmed", portHeldBy: listenerPid };
  } catch (err) {
    return {
      outcome: "unavailable",
      reason: `lsof error: ${(err as Error).message}`,
      portHeldBy: undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for `pids` to exit, escalate to SIGKILL after `timeoutMs`, and return
 * the PIDs that are STILL alive afterward. Callers preserve survivors in the
 * pidfile so a future `grove down` can finish what we couldn't (round 7).
 */
async function waitForPids(pids: readonly number[], timeoutMs: number): Promise<readonly number[]> {
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
    if (alive.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Force kill any remaining, then poll briefly for the kernel to reap.
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  const sigkillDeadline = Date.now() + 1_500;
  while (Date.now() < sigkillDeadline) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return [];
    await new Promise((r) => setTimeout(r, 50));
  }
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}
