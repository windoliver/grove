/**
 * Manual tmux-driven E2E for the codex → claude review-loop handoff (#219 validation).
 *
 * Launches the real Grove TUI in a tmux pane, initialises a review-loop preset
 * with coder=codex + reviewer=claude-code, sends a goal, captures pane output
 * at each phase, and asserts the cross-platform handoff completes (work CID
 * from codex is reviewed by claude-code).
 *
 * NOT wired into `bun test` — this boots actual codex + claude-code processes.
 * Run as:
 *
 *   bun run tests/tui/codex-claude-handoff-e2e.ts
 *
 * Flags:
 *   --keep          Leave the tmux session + work dir behind for inspection
 *   --attach        Print `tmux attach` command and wait
 *   --timeout <ms>  Overall budget (default 600000)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SOCKET = "grove-cx-cl-e2e";
const SESSION = "grove-cx-cl-e2e";
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

  // 1b. Free the default grove ports (4515 HTTP, 4015 MCP) from any orphan
  //     listener — the new TUI's per-service identity gate refuses to adopt a
  //     port held by a process this run did not spawn, which is correct but
  //     fatal for the harness.
  for (const port of [4515, 4015]) {
    try {
      execSync(
        `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null | xargs -r kill -TERM 2>/dev/null; sleep 0.3; ` +
          `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null | xargs -r kill -KILL 2>/dev/null`,
        { stdio: "ignore", shell: "/bin/sh" } as Parameters<typeof execSync>[1],
      );
    } catch {
      /* nothing to kill */
    }
  }

  // 2. Create a bare repo the coder can work inside.
  execSync(`git init -q ${repoDir} && cd ${repoDir} && git commit --allow-empty -q -m init`, {
    stdio: "inherit",
  });

  // 3. Init a grove. Use review-loop preset (coder + reviewer).
  console.log("[setup] grove init --preset review-loop");
  execSync(
    `cd ${repoDir} && GROVE_DIR=${groveDir} bun run ${PROJECT_ROOT}/src/cli/main.ts init --preset review-loop --force cx-cl-e2e`,
    { stdio: "inherit" },
  );

  // 4. Patch GROVE.md topology to make coder=codex, reviewer=claude-code.
  //    The review-loop preset hardcodes platform: "claude-code" for both roles
  //    in GROVE.md (despite the .md extension, the file is plain YAML); we want
  //    to exercise the codex → claude handoff path specifically.
  const groveMdPath = join(repoDir, "GROVE.md");
  if (!existsSync(groveMdPath)) throw new Error(`GROVE.md missing at ${groveMdPath}`);
  const groveMd = readFileSync(groveMdPath, "utf-8");
  // Coder role appears first in the YAML — replace ONLY the first
  // `platform: claude-code` occurrence (under the `coder` block).
  const idx = groveMd.indexOf("platform: claude-code");
  if (idx === -1) throw new Error("GROVE.md has no `platform: claude-code` line to patch");
  const patched = `${groveMd.slice(0, idx)}platform: codex${groveMd.slice(idx + "platform: claude-code".length)}`;
  writeFileSync(groveMdPath, patched, "utf-8");
  console.log(
    "[setup] patched GROVE.md: coder=codex (first occurrence), reviewer stays claude-code",
  );

  // 5. Launch the TUI inside tmux. GROVE_DIR points at our temp grove.
  //    Use `--url` is not what we want — we want the interactive flow.
  // Wrap the TUI launch in a subshell that captures the exit code and
  // writes it to a file — the `; cat` at the end keeps the pane alive
  // so we can see the output even on crash.
  const stdoutLog = join(workDir, "tui.stdout.log");
  // GROVE_ALLOW_ALL_PERMISSIONS=1 disables the RulesResolver gate so codex/claude
  // child processes are actually allowed to Edit + execute + fetch — otherwise
  // the coder cannot write hello.txt and the loop never produces a contribution.
  const launchCmd = [
    `cd ${repoDir}`,
    `GROVE_ALLOW_ALL_PERMISSIONS=1 GROVE_DEBUG_LOG=${join(workDir, "grove-debug.log")} bun run ${PROJECT_ROOT}/src/cli/main.ts 2>&1 | tee ${stdoutLog}`,
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

  // 6. Wait for TUI to show the welcome screen with the new-session hint.
  await waitForPane(
    (p) => /Press \[n\] to start|\[n\] new|Continue session/i.test(p),
    "tui-welcome",
    60000,
  );
  console.log("[phase 1] TUI welcome screen visible");

  // 7. Press `n` to enter new-session flow → preset picker appears.
  tmuxSendKeys(["n"]);
  await waitForPane(
    (p) => /review-loop|Pick a preset|preset for this session/i.test(p),
    "preset-select",
    15000,
  );
  console.log("[phase 1b] preset select screen visible");

  // 8. Default cursor is on first preset (review-loop). Pick it.
  tmuxSendKeys(["Enter"]);

  // 9. Wait for goal-input screen — Nexus boot + service spawn can take a while,
  //    but the goal screen renders before any of that is required.
  await waitForPane(
    (p) => /Goal|goal/.test(p) && /Continue|Esc:back|continue/i.test(p),
    "goal-input",
    240000,
  );
  console.log("[phase 2] goal-input screen visible");

  // 10. Type goal + Enter.
  tmuxSendKeys([
    "Create a file named hello.txt with the contents 'hi from codex', " +
      "then run git add hello.txt && git commit -m 'add hello.txt', then " +
      "call grove_submit_work with the resulting commit hash.",
  ]);
  await sleep(800);
  tmuxSendKeys(["Enter"]);
  console.log("[phase 2b] goal submitted, awaiting launch-preview");

  // 11. Wait for launch-preview (agent-detect) screen, then Enter to launch.
  //     Despite the screen header mentioning "Ctrl+Enter", the actual handler
  //     in agent-detect.tsx accepts plain `return`.
  await waitForPane(
    (p) => /codex|claude|detect|Agents detected|Launch|Roles|launch/i.test(p),
    "launch-preview",
    120000,
  );
  console.log("[phase 2c] launch-preview screen visible");
  await sleep(1500);
  tmuxSendKeys(["Enter"]);
  console.log("[phase 2d] launch confirmed");

  // 12. Wait for the running screen — agents spawn synchronously after launch.
  const running = await waitForPane(
    (p) => /RUNNING|coder.*\[1\]|reviewer.*\[2\]|Contribution Feed|Agents:/i.test(p),
    "running",
    300000,
  );
  console.log("[phase 3] running screen + agents spawned");
  console.log("──── running pane ────");
  console.log(running);
  console.log("──── end running pane ────");

  // 14. Observe for up to 7 minutes — watch for handoff + review signals.
  //     Codex+claude is slower than pure-claude so give it more headroom.
  const OBSERVE_MS = 420_000;
  console.log(`[phase 5] observing agent activity for up to ${OBSERVE_MS / 1000}s...`);
  const observeEnd = Math.min(Date.now() + OBSERVE_MS, overallDeadline);
  let sawCoderWork = false;
  let sawHandoff = false;
  let sawReview = false;
  let lastCapture = "";
  while (Date.now() < observeEnd) {
    await sleep(15000);
    lastCapture = capturePane();
    const headline = lastCapture.split("\n").slice(0, 5).join(" | ");
    const elapsed = Math.round((Date.now() - (observeEnd - OBSERVE_MS)) / 1000);
    console.log(`[observe t+${elapsed}s] ${headline.slice(0, 120)}`);
    if (!sawCoderWork && /submit_work|coder.*contribution|kind.?work/i.test(lastCapture)) {
      sawCoderWork = true;
      console.log("[phase 5] coder work submission detected");
    }
    if (!sawHandoff && /handoff/i.test(lastCapture)) {
      sawHandoff = true;
      console.log("[phase 5] handoff event detected");
    }
    if (!sawReview && /submit_review|reviewer.*contribution|kind.?review/i.test(lastCapture)) {
      sawReview = true;
      console.log("[phase 5] reviewer submission detected");
    }
    if (sawHandoff && sawReview) break;
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

  // 16. Validate via Nexus VFS — contributions + handoffs should be there.
  console.log("\n[phase 6] querying Nexus VFS for contributions + handoffs");
  try {
    const groveJsonPath = join(groveDir, "grove.json");
    const apiKeyPath = join(groveDir, "api-key");
    const groveJson = JSON.parse(readFileSync(groveJsonPath, "utf-8")) as {
      nexusUrl?: string;
    };
    const nexusUrl = groveJson.nexusUrl;
    if (nexusUrl && existsSync(apiKeyPath)) {
      const apiKey = readFileSync(apiKeyPath, "utf-8").trim();
      for (const dir of [
        "/zones/default/contributions",
        "/zones/default/handoffs",
        "/zones/default/sessions",
      ]) {
        const res = execSync(
          `curl -s -X POST '${nexusUrl}/api/nfs/sys_readdir' ` +
            `-H 'Authorization: Bearer ${apiKey}' -H 'Content-Type: application/json' ` +
            `-d '${JSON.stringify({ path: dir })}'`,
          { encoding: "utf-8" },
        );
        console.log(`[nexus] ${dir}: ${res.slice(0, 400)}`);
      }
    } else {
      console.log("[nexus] no nexusUrl/api-key — skipping VFS validation");
    }
  } catch (err) {
    console.log(`[nexus] validation failed: ${(err as Error).message}`);
  }

  console.log(`\n[result] coderWork=${sawCoderWork} handoff=${sawHandoff} review=${sawReview}`);
  if (!sawHandoff || !sawReview) {
    throw new Error(`E2E incomplete — handoff=${sawHandoff} review=${sawReview}`);
  }
  console.log("[result] E2E PASSED — codex → claude handoff completed");
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
