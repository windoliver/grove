/**
 * Tmux-driven E2E for the TUI-triggered review loop.
 *
 * Starts grove-server with scheduler config, launches grove TUI in a second pane,
 * sends `r` + goal text + Enter to drive ReviewLoopPrompt, then polls the server
 * until both AgentTask records reach Succeeded.
 *
 * NOT wired into `bun test` — run as:
 *   bun run tests/e2e/review-loop-tui-tmux.ts
 *
 * Flags:
 *   --keep             Leave tmux session + workdir for inspection
 *   --timeout <ms>     Overall budget (default 180000)
 *   --goal <text>      Override goal (default: trivial smoke prompt)
 *
 * Known risks (do not fix here — tracked separately):
 *   - TUI keymap: `r` may be consumed differently when a list widget has focus.
 *   - ReviewLoopPrompt regex (`/REVIEW LOOP/`) must match the rendered header.
 *   - Both `codex` and `claude` CLIs must be installed and authenticated locally.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

// ─── Constants ────────────────────────────────────────────────────────────────

const SOCKET = "grove-review-loop-tui-e2e";
const SESSION = "grove-review-loop-tui-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const SERVER_PORT = 12796;
const DEFAULT_GOAL =
  "Print 'hello-from-coder' to stdout then immediately call grove_done with summary='ready for review'.";

// ─── Args ─────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    timeout: { type: "string", default: "180000" },
    goal: { type: "string" },
  },
});
const KEEP = values.keep;
const BUDGET_MS = Number.parseInt(values.timeout as string, 10);
const GOAL = (values.goal as string | undefined) ?? DEFAULT_GOAL;

// ─── tmux helpers ─────────────────────────────────────────────────────────────

function capturePane(target: string): string {
  const out = spawnSync("tmux", ["-L", SOCKET, "capture-pane", "-t", target, "-p", "-S", "-5000"], {
    encoding: "utf-8",
  });
  return out.stdout;
}

function sendKeys(target: string, keys: string[]): void {
  spawnSync("tmux", ["-L", SOCKET, "send-keys", "-t", target, ...keys], { stdio: "ignore" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPane(
  target: string,
  predicate: (pane: string) => boolean,
  phase: string,
  maxMs = 60000,
): Promise<string> {
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(target);
    if (predicate(last)) {
      console.log(`[${phase}] matched`);
      return last;
    }
    await sleep(500);
  }
  console.error(`\n──── pane dump (${phase}) target=${target} ────`);
  console.error(last);
  console.error("──── end pane dump ────\n");
  throw new Error(`[${phase}] predicate did not match within ${maxMs}ms`);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), "grove-review-loop-tui-"));
const groveDir = join(workDir, ".grove");
console.log(`[setup] workDir=${workDir}`);

function cleanup(): void {
  if (KEEP) {
    console.log(`[keep] workDir=${workDir}`);
    console.log(`[keep] tmux -L ${SOCKET} attach -t ${SESSION}`);
    return;
  }
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ok */
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ─── Grove config with scheduler block (codex coder + claude reviewer) ────────

const GROVE_JSON = {
  name: "review-loop-tui-e2e",
  mode: "local",
  scheduler: {
    profiles: [
      {
        name: "codex-default",
        platform: "codex",
        runtimeCommand: "codex",
        supportedRoles: ["coder"],
      },
      {
        name: "claude-default",
        platform: "claude-code",
        runtimeCommand: "claude",
        supportedRoles: ["reviewer"],
      },
    ],
    pipeline: {
      filters: ["RuntimeCapability", "BudgetRemaining", "WorktreeExclusivity"],
      scores: [{ name: "TaskAffinity", weight: 1 }],
      permits: ["AutoPermit"],
      bind: "DefaultBind",
    },
  },
};

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Kill any leftover tmux socket from a previous run
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }

  // 1. grove init — creates .grove/server-keys.yaml, grove.json, etc.
  console.log("[setup] grove init --preset review-loop");
  mkdirSync(workDir, { recursive: true });
  execSync(
    `GROVE_DIR=${groveDir} bun run ${join(PROJECT_ROOT, "src/cli/main.ts")} init --preset review-loop --force review-loop-tui-e2e`,
    { cwd: workDir, stdio: "inherit" },
  );

  // 2. Overwrite grove.json with scheduler block (codex coder + claude reviewer)
  const groveJsonPath = join(groveDir, "grove.json");
  writeFileSync(groveJsonPath, `${JSON.stringify(GROVE_JSON, null, 2)}\n`);
  console.log(`[setup] wrote ${groveJsonPath}`);

  // 3. Read bearer token from .grove/server-keys.yaml
  const serverKeysPath = join(groveDir, "server-keys.yaml");
  if (!existsSync(serverKeysPath)) {
    throw new Error(`server-keys.yaml not found at ${serverKeysPath}`);
  }
  const rawYaml = readFileSync(serverKeysPath, "utf8");
  const keysFile = parseYaml(rawYaml) as {
    version: number;
    keys: Record<string, { namespace: string; createdAt: string }>;
  };
  const token = Object.keys(keysFile.keys)[0];
  if (!token) throw new Error("No bearer token found in server-keys.yaml");
  console.log(`[setup] token=${token.slice(0, 8)}... (first 8 chars)`);

  const baseUrl = `http://localhost:${SERVER_PORT}`;
  console.log(`[setup] baseUrl=${baseUrl}`);

  const serverLog = join(workDir, "server.log");
  const tuiLog = join(workDir, "tui.log");

  // 4. Start tmux session — pane 0 = grove-server
  const serverCmd = [
    `GROVE_DIR=${groveDir}`,
    `PORT=${SERVER_PORT}`,
    `GROVE_TASK_CONTROLLER=1`,
    `bun run ${join(PROJECT_ROOT, "src/server/serve.ts")} 2>&1 | tee ${serverLog}`,
  ].join(" ");

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
      "220",
      "-y",
      "50",
      "sh",
      "-c",
      `${serverCmd}; cat`,
    ],
    { stdio: "inherit" },
  );
  console.log(`[tmux] server pane started. Attach: tmux -L ${SOCKET} attach -t ${SESSION}`);

  // 5. Wait for scheduler wiring log line, then for server listening
  await waitForPane(
    SESSION,
    (p) => /task-controller enabled \(scheduler: 2 profiles, 3 filters\)/.test(p),
    "scheduler-wired",
    30000,
  );
  console.log("[phase 1] scheduler wired (2 profiles, 3 filters confirmed)");

  await waitForPane(SESSION, (p) => /listening/.test(p), "server-ready", 10000);
  console.log("[phase 2] server listening");

  // 6. Split pane — pane 1 = grove TUI
  const tuiCmd = [
    `GROVE_DIR=${groveDir}`,
    `GROVE_SERVER_URL=${baseUrl}`,
    `GROVE_API_TOKEN=${token}`,
    `bun run ${join(PROJECT_ROOT, "src/cli/main.ts")} tui 2>&1 | tee ${tuiLog}`,
  ].join(" ");

  spawnSync(
    "tmux",
    ["-L", SOCKET, "split-window", "-t", SESSION, "-h", "sh", "-c", `${tuiCmd}; cat`],
    { stdio: "inherit" },
  );
  const tuiTarget = `${SESSION}.1`;
  console.log("[tmux] TUI pane started");

  // 7. Wait for TUI dashboard to render
  await waitForPane(
    tuiTarget,
    (p) => /AGENTS|DASHBOARD|RUNNING|ACTIVITY|TASKS|grove/.test(p),
    "tui-up",
    30000,
  );
  console.log("[tui] dashboard visible");
  await sleep(1500); // let initial render settle

  // 8. Send `r` to open the review-loop prompt
  sendKeys(tuiTarget, ["r"]);
  await waitForPane(tuiTarget, (p) => /REVIEW LOOP/.test(p), "prompt-open", 10000);
  console.log("[tui] review-loop prompt open");

  // 9. Type goal character-by-character (mimics real typing; avoids paste-mode issues)
  for (const ch of GOAL) {
    sendKeys(tuiTarget, [ch === " " ? "Space" : ch]);
    await sleep(15);
  }
  await sleep(300);
  sendKeys(tuiTarget, ["Enter"]);
  console.log("[tui] goal submitted, awaiting AgentTask creation");

  // 10. Poll /api/agent-tasks until coder + reviewer both reach Succeeded (or timeout/failure)
  const deadline = Date.now() + BUDGET_MS;
  let coderId: string | undefined;
  let reviewerId: string | undefined;
  let lastCoderPhase = "";
  let lastReviewerPhase = "";

  while (Date.now() < deadline) {
    let listRes: Response;
    try {
      listRes = await fetch(`${baseUrl}/api/agent-tasks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      await sleep(1500);
      continue;
    }

    if (listRes.ok) {
      const body = (await listRes.json()) as {
        tasks?: Array<{
          spec: { id: string; role: string };
          status: { phase: string };
        }>;
      };
      const tasks = body.tasks ?? [];

      for (const t of tasks) {
        if (t.spec.role === "coder" && coderId === undefined) {
          coderId = t.spec.id;
          console.log(`[poll] found coder task id=${coderId}`);
        }
        if (t.spec.role === "reviewer" && reviewerId === undefined) {
          reviewerId = t.spec.id;
          console.log(`[poll] found reviewer task id=${reviewerId}`);
        }
        if (t.spec.id === coderId && t.status.phase !== lastCoderPhase) {
          console.log(
            `[coder ${coderId}] phase: ${lastCoderPhase || "(initial)"} → ${t.status.phase}`,
          );
          lastCoderPhase = t.status.phase;
        }
        if (t.spec.id === reviewerId && t.status.phase !== lastReviewerPhase) {
          console.log(
            `[reviewer ${reviewerId}] phase: ${lastReviewerPhase || "(initial)"} → ${t.status.phase}`,
          );
          lastReviewerPhase = t.status.phase;
        }
      }

      if (lastCoderPhase === "Succeeded" && lastReviewerPhase === "Succeeded") {
        break;
      }
      if (lastCoderPhase === "Failed" || lastReviewerPhase === "Failed") {
        break;
      }
    }

    await sleep(1500);
  }

  // 11. Final pane dumps
  console.log("\n──── TUI PANE ────");
  console.log(capturePane(tuiTarget));
  console.log("──── end TUI pane ────\n");

  console.log("──── SERVER PANE (tail 60) ────");
  const serverPane = capturePane(SESSION);
  console.log(serverPane.split("\n").slice(-60).join("\n"));
  console.log("──── end server pane ────\n");

  // 12. Verdict
  if (lastCoderPhase === "Succeeded" && lastReviewerPhase === "Succeeded") {
    console.log("[smoke] OK — coder + reviewer both reached Succeeded via TUI-triggered scheduler");
    process.exit(0);
  }

  console.error(
    `[smoke] FAIL — coder=${lastCoderPhase || "(never seen)"}, reviewer=${lastReviewerPhase || "(never seen)"}`,
  );

  // Dump server log tail for diagnosis
  console.error("\n──── server log tail ────");
  try {
    console.error(execSync(`tail -80 ${serverLog}`, { encoding: "utf-8" }));
  } catch {
    /* no log file yet */
  }

  process.exit(1);
}

main().catch((err) => {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);

  console.error("\n──── server pane (fatal) ────");
  try {
    console.error(capturePane(SESSION));
  } catch {
    /* tmux already dead */
  }
  console.error("──── end server pane (fatal) ────");

  process.exit(2);
});
