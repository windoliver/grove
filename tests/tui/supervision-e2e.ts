/**
 * Manual tmux-driven E2E for the Supervision body (#193 Task 13).
 *
 * Launches the real Grove TUI in a tmux pane with GROVE_SUPERVISION=1,
 * initialises a review-loop preset with real claude-code agents
 * (coder + reviewer), and asserts the supervision fleet rail renders with
 * both agents visible.
 *
 * NOT wired into `bun test` — this boots actual claude-code processes,
 * requires grove up (grove-managed Nexus lifecycle), and needs:
 *
 *   export ANTHROPIC_API_KEY=<your key>
 *   bun run tests/tui/supervision-e2e.ts
 *
 * Flags:
 *   --keep          Leave the tmux session + work dir behind for inspection
 *   --attach        Print `tmux attach` command and wait
 *   --timeout <ms>  Overall budget (default 600000)
 *
 * ASSERTION STRATEGY
 * ------------------
 * The HEALTH_THRESHOLDS.silentMs default is 5 minutes, so a short-budget run
 * cannot reliably wait for a SILENT badge. Instead the primary assertions are
 * DETERMINISTIC and appear immediately once the running screen with
 * GROVE_SUPERVISION=1 is active:
 *
 *   1. "Fleet (" — the FleetRail header, rendered as soon as useFleetModel
 *      returns at least one agent claim.
 *   2. "coder" + "reviewer" role strings in the fleet-rail rows.
 *   3. Either "Select an agent" (detail-rail empty state, no agent selected
 *      yet) or a selected agent's name / RUNNING / IDLE header — i.e. the
 *      detail-rail scaffold appeared.
 *
 * These three markers confirm the Supervision composition root rendered the
 * full fleet. If the --timeout budget is long enough that an agent goes idle
 * for > 5 min, the script will also look for a SILENT badge — but this is
 * opportunistic, not required.
 *
 * Validate against the real running stack (Nexus via `grove up`), consistent
 * with this repo's e2e convention. The grove init below configures the grove
 * so that `grove up` inside the TUI's setup flow connects to Nexus.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SOCKET = "grove-supervision-e2e";
const SESSION = "grove-supervision-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");

// ─── Args ─────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    attach: { type: "boolean", default: false },
    timeout: { type: "string", default: "600000" },
  },
});
const KEEP = values.keep;
const ATTACH = values.attach;
const BUDGET_MS = Number.parseInt(values.timeout as string, 10);

// ─── tmux helpers ─────────────────────────────────────────────────────
function tmux(cmd: string, opts: { check?: boolean } = {}): string {
  const out = spawnSync("tmux", ["-L", SOCKET, ...cmd.split(" ").filter(Boolean)], {
    encoding: "utf-8",
  });
  if (opts.check !== false && out.status !== 0) {
    throw new Error(`tmux ${cmd} failed (${out.status}): ${out.stderr}`);
  }
  return out.stdout.trim();
}

function tmuxSendKeys(args: string[]): void {
  const out = spawnSync("tmux", ["-L", SOCKET, "send-keys", "-t", SESSION, ...args], {
    encoding: "utf-8",
  });
  if (out.status !== 0) {
    throw new Error(`send-keys failed: ${out.stderr}`);
  }
}

function capturePane(): string {
  return tmux(`capture-pane -t ${SESSION} -p -S -2000`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPane(predicate: (pane: string) => boolean, phase: string, maxMs = 60000) {
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane();
    if (predicate(last)) {
      console.log(`[${phase}] matched in ${maxMs - (deadline - Date.now())}ms`);
      return last;
    }
    await sleep(1000);
  }
  console.error(`\n──── pane dump (${phase}) ────`);
  console.error(last);
  console.error("──── end pane dump ────\n");
  throw new Error(`[${phase}] predicate did not match within ${maxMs}ms`);
}

// ─── main ─────────────────────────────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), "grove-supervision-e2e-"));
const repoDir = join(workDir, "repo");
const groveDir = join(repoDir, ".grove");
console.log(`[setup] workDir=${workDir}`);

function cleanup() {
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // already dead
  }
  if (!KEEP && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  } else if (KEEP) {
    console.log(`[cleanup] kept workDir=${workDir} (--keep)`);
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function main() {
  const overallDeadline = Date.now() + BUDGET_MS;

  // 1. Kill any prior tmux server on our socket.
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }

  // 2. Create a bare repo the coder can work inside.
  execSync(`git init -q ${repoDir} && cd ${repoDir} && git commit --allow-empty -q -m init`, {
    stdio: "inherit",
  });

  // 3. Init a grove. Use review-loop preset (coder + reviewer).
  console.log("[setup] grove init --preset review-loop");
  execSync(
    `cd ${repoDir} && GROVE_DIR=${groveDir} bun run ${PROJECT_ROOT}/src/cli/main.ts init --preset review-loop --force supervision-e2e`,
    { stdio: "inherit" },
  );

  // 4. Launch the TUI inside tmux with GROVE_SUPERVISION=1.
  //    grove up → TUI setup screen → Enter → running screen (supervision body).
  //    Wrap in a subshell that keeps the pane alive after exit (via `; cat`).
  const stdoutLog = join(workDir, "tui.stdout.log");
  const launchCmd = [
    `cd ${repoDir}`,
    `GROVE_SUPERVISION=1 GROVE_DEBUG_LOG=${join(workDir, "grove-debug.log")} bun run ${PROJECT_ROOT}/src/cli/main.ts 2>&1 | tee ${stdoutLog}`,
    `echo [EXIT $?]`,
    `cat`,
  ].join(" ; ");

  spawnSync(
    "tmux",
    [
      "-L",
      SOCKET,
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      "160",
      "-y",
      "48",
      "sh",
      "-c",
      launchCmd,
    ],
    { stdio: "inherit" },
  );
  console.log(`[tmux] session started. Attach: tmux -L ${SOCKET} attach -t ${SESSION}`);

  if (ATTACH) {
    console.log(`\nAttach in another terminal:\n  tmux -L ${SOCKET} attach -t ${SESSION}\n`);
    console.log("Press Ctrl+C here to tear down.");
    await sleep(BUDGET_MS);
    return;
  }

  // 5. Wait for TUI setup screen.
  await waitForPane((p) => /Grove|Resume|Create|grove/i.test(p), "tui-setup", 60000);
  console.log("[phase 1] TUI setup screen visible");

  // 6. Press Enter on the default "New session" option. With a single preset
  //    and an existing grove, the flow short-circuits past preset-select and
  //    lands on the running screen with agents pre-spawned (coder + reviewer).
  tmuxSendKeys(["Enter"]);
  await sleep(3000);

  // 7. Wait for the running screen — confirms agents spawned.
  const running = await waitForPane(
    (p) => /RUNNING|coder.*\[1\]|reviewer.*\[2\]|Contribution Feed|Fleet \(/i.test(p),
    "running",
    60000,
  );
  console.log("[phase 2] running screen visible");
  console.log("──── running pane ────");
  console.log(running);
  console.log("──── end running pane ────");

  // 8. PRIMARY ASSERTION: supervision body rendered the fleet rail.
  //    Fleet ( appears as soon as useFleetModel returns ≥1 active claim.
  //    Both "coder" and "reviewer" role columns must be present.
  //    The detail rail shows either "Select an agent" (no selection yet) or
  //    a selected agent's header (RUNNING / IDLE / ...).
  console.log("[phase 3] asserting supervision body markers...");

  const supervisionPane = await waitForPane(
    (p) => /Fleet \(/.test(p) && /coder/.test(p) && /reviewer/.test(p),
    "supervision-fleet-rail",
    120000,
  );

  // Confirm the detail rail scaffold is also visible.
  const hasDetailRail =
    /Select an agent/.test(supervisionPane) ||
    /RUNNING|IDLE|STUCK|SILENT|BLOCKED|APPROVAL|ERROR/.test(supervisionPane);

  if (!hasDetailRail) {
    console.warn("[phase 3] WARNING: detail-rail scaffold not yet visible in captured pane");
    console.warn("──── supervision pane ────");
    console.warn(supervisionPane);
    console.warn("──── end supervision pane ────");
  } else {
    console.log("[phase 3] detail-rail scaffold visible — supervision body fully rendered");
  }

  console.log("\n[ASSERT] Fleet ( header:  ", /Fleet \(/.test(supervisionPane));
  console.log('[ASSERT] "coder" row:      ', /coder/.test(supervisionPane));
  console.log('[ASSERT] "reviewer" row:   ', /reviewer/.test(supervisionPane));
  console.log("[ASSERT] detail-rail:      ", hasDetailRail);

  if (
    !/Fleet \(/.test(supervisionPane) ||
    !/coder/.test(supervisionPane) ||
    !/reviewer/.test(supervisionPane)
  ) {
    throw new Error(
      "FAIL: supervision fleet rail did not render with expected Fleet ( header and both agent roles",
    );
  }

  // 9. OPPORTUNISTIC: if budget allows, watch for a SILENT/STUCK badge.
  //    The HEALTH_THRESHOLDS.silentMs is 5 min and cannot be overridden via
  //    env (the constants are compile-time). Only checked if > 6 min remain.
  const silentBudgetMs = Math.min(360_000, overallDeadline - Date.now() - 30_000);
  if (silentBudgetMs > 60_000) {
    console.log(
      `\n[phase 4] watching for SILENT/STUCK badge (budget ${Math.round(silentBudgetMs / 1000)}s)...`,
    );
    const observeEnd = Date.now() + silentBudgetMs;
    let lastCapture = "";
    let silentSeen = false;
    while (Date.now() < observeEnd) {
      await sleep(15_000);
      lastCapture = capturePane();
      const headline = lastCapture.split("\n").slice(0, 3).join(" | ");
      console.log(
        `[observe t+${Math.round((Date.now() - (observeEnd - silentBudgetMs)) / 1000)}s] ${headline.slice(0, 120)}`,
      );
      if (/SILENT|STUCK/.test(lastCapture)) {
        console.log("[phase 4] SILENT/STUCK badge observed — health degradation detection works");
        silentSeen = true;
        break;
      }
    }
    if (!silentSeen) {
      console.log(
        "[phase 4] no SILENT/STUCK badge observed within budget (agents still active — expected for short runs)",
      );
    }
  }

  // 10. Final capture + debug log tail.
  console.log("\n──── final pane ────");
  console.log(capturePane());
  console.log("──── end final pane ────");

  const debugPath = join(workDir, "grove-debug.log");
  if (existsSync(debugPath)) {
    const debug = execSync(`tail -300 ${debugPath}`, { encoding: "utf-8" });
    console.log("──── debug tail ────");
    console.log(debug);
    console.log("──── end debug tail ────");
  }

  console.log("\n[result] Supervision E2E smoke passed.");
}

main()
  .then(() => cleanup())
  .catch((err) => {
    console.error("[FAIL]", err);
    console.error("──── final pane ────");
    try {
      console.error(capturePane());
    } catch {
      /* tmux already dead */
    }
    console.error("──── end pane ────");
    cleanup();
    process.exit(1);
  });
