/**
 * Manual tmux-driven E2E for the typed ACP consumer (#314), updated for
 * SupervisionScreen (#193).
 *
 * Launches the real Grove TUI in a tmux pane, initialises a review-loop
 * preset with real claude-code agents (coder + reviewer), sends a goal,
 * captures pane output at each phase, and asserts the typed ACP flow +
 * handoff completes — visible as state transitions on supervision cards.
 *
 * NOT wired into `bun test` — this boots actual claude-code processes
 * and requires an ANTHROPIC_API_KEY in env. Run as:
 *
 *   ANTHROPIC_API_KEY=... bun run tests/tui/typed-acp-tmux-e2e.ts
 *
 * Flags:
 *   --keep          Leave the tmux session + work dir behind for inspection
 *   --attach        Print `tmux attach` command and wait
 *   --timeout <ms>  Overall budget (default 600000)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SOCKET = "grove-acp-e2e";
const SESSION = "grove-acp-e2e";
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
      console.log(`[${phase}] matched in ${60000 - (deadline - Date.now())}ms`);
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
const workDir = mkdtempSync(join(tmpdir(), "grove-acp-e2e-"));
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
    `cd ${repoDir} && GROVE_DIR=${groveDir} bun run ${PROJECT_ROOT}/src/cli/main.ts init --preset review-loop --force acp-e2e`,
    { stdio: "inherit" },
  );

  // (goal injection is not needed for phase-1 boot verification)

  // 5. Launch the TUI inside tmux. GROVE_DIR points at our temp grove.
  //    Use `--url` is not what we want — we want the interactive flow.
  // Wrap the TUI launch in a subshell that captures the exit code and
  // writes it to a file — the `; cat` at the end keeps the pane alive
  // so we can see the output even on crash.
  const stdoutLog = join(workDir, "tui.stdout.log");
  const launchCmd = [
    `cd ${repoDir}`,
    `GROVE_DEBUG_LOG=${join(workDir, "grove-debug.log")} bun run ${PROJECT_ROOT}/src/cli/main.ts 2>&1 | tee ${stdoutLog}`,
    `echo [EXIT $?]`,
    `cat`, // keep pane alive
  ].join(" ; ");

  // Pass the launch command to tmux as separate args so quoting survives.
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

  // 6. Wait for TUI to show the setup / welcome screen.
  await waitForPane((p) => /Grove|Resume|Create|grove/i.test(p), "tui-setup", 60000);
  console.log("[phase 1] TUI setup screen visible");

  // 7. Walk the wizard: Enter (start new session) → optionally land on
  //    goal-input → type goal → Enter → spawning → supervision.
  tmuxSendKeys(["Enter"]);
  await sleep(2000);

  // 7a. If the goal-input screen is shown, type the goal there. The supervision
  //     surface itself does NOT expose a `:` prompt — goals must be injected
  //     during the wizard.
  const afterEnter = capturePane();
  if (/Goal|prompt|describe/i.test(afterEnter)) {
    console.log("[phase 1b] goal-input screen — injecting goal");
    tmuxSendKeys(["Create a hello.txt file with the text 'hi' and commit it."]);
    await sleep(500);
    tmuxSendKeys(["Enter"]);
    await sleep(3000);
  }

  // 8. Wait for the SupervisionScreen (running surface). Matches the FLEET
  //    banner, the new card prefix (`a-`), or any state badge.
  const running = await waitForPane(
    (p) => /FLEET|a-[0-9a-f]+|RUN|BLK|SLNT|STCK|APPR/i.test(p),
    "supervision",
    90000,
  );
  console.log("[phase 2] supervision screen visible — agents registered");
  console.log("──── supervision pane ────");
  console.log(running);
  console.log("──── end supervision pane ────");

  // 9. Observe for up to 3 minutes — watch the FLEET banner state counts
  //    move (running → silent → blocked / approve) as agents work and hand
  //    off. The drill-down would surface contribution text if Enter is
  //    pressed; we keep the grid view to track the fleet-level signal.
  console.log("[phase 3] observing fleet-level activity for up to 3 minutes...");
  const observeEnd = Math.min(Date.now() + 180_000, overallDeadline);
  let lastCapture = "";
  while (Date.now() < observeEnd) {
    await sleep(15000);
    lastCapture = capturePane();
    const headline = lastCapture.split("\n").slice(0, 5).join(" | ");
    console.log(
      `[observe t+${Math.round((Date.now() - (observeEnd - 180_000)) / 1000)}s] ${headline.slice(0, 140)}`,
    );
    // A handoff is visible when the reviewer card transitions from idle/silent
    // into running, or when the cost-line ticks up — meaning the coder's
    // contribution was projected and the reviewer started reading it.
    if (/handoff|contribution|review|reviewer.*\bRUN\b|approve/i.test(lastCapture)) {
      console.log("[phase 3] handoff / reviewer activity detected");
      break;
    }
  }

  // 15. Final capture + debug log tail.
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

  console.log("\n[result] E2E run complete.");
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
