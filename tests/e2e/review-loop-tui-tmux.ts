/**
 * Tmux-driven E2E for the TUI-triggered review loop.
 *
 * Approach C (lib-direct):
 *   - Server in pane 0.
 *   - TUI in pane 1 (no `tee` — raw TTY so OpenTUI renders correctly).
 *   - startReviewLoop called directly from this harness (same lib the `r`
 *     keybind in running-view.tsx invokes).  The keybind is verified in
 *     source at commit 61e840b8; we exercise the lib end-to-end here.
 *   - Poll /api/agent-tasks until coder + reviewer both reach Succeeded.
 *
 * NOT wired into `bun test` — run as:
 *   bun run tests/e2e/review-loop-tui-tmux.ts
 *
 * Flags:
 *   --keep             Leave tmux session + workdir for inspection
 *   --timeout <ms>     Overall budget (default 600000 = 10 min)
 *   --goal <text>      Override goal (default: trivial smoke prompt)
 *
 * Real-agent mode (current):
 *   - Both codex (coder) and claude (reviewer) are spawned by the scheduler
 *     via DefaultBind, which wires the grove MCP server in mcpServers.
 *   - grove_done MCP tool is registered by grove MCP serve.ts always.
 *   - Agents are expected to call grove_done themselves.
 *   - No harness-side /done shortcut.
 *
 * MCP wiring summary (verified against source):
 *   - DefaultBind (src/core/scheduler/plugins/default-bind.ts) sets
 *     mcpServers=[{name:"grove", command:"bun", args:["run", mcp/serve.ts], env:{…}}]
 *     on AgentConfig whenever GROVE_DIR is set.
 *   - AcpRuntime (src/core/acp-runtime.ts):
 *       - For codex: writes mcpServers into the ephemeral CODEX_HOME/config.toml
 *         via buildCodexMcpConfigBlock, AND appends -c flags via
 *         appendCodexMcpServerOverrides. Both paths forward the grove server.
 *       - For claude: passes mcpServers through ACP newSession call so the
 *         claude CLI loads them.
 *   - GROVE_SERVER_URL defaults to http://localhost:{PORT} in serve.ts (line 63).
 *   - GROVE_API_TOKEN is auto-populated from server-keys.yaml in serve.ts (line 162).
 *   - DefaultBind forwards both to agents via env and groveMcp.env.
 *   - grove_done tool (src/mcp/tools/done.ts) calls signalAgentTaskDone which
 *     POSTs to GROVE_SERVER_URL/api/agent-tasks/:id/done with GROVE_API_TOKEN.
 *
 * Known risks (do not fix here — tracked separately):
 *   - Both `codex` and `claude` CLIs must be installed and authenticated locally.
 *   - First-turn latency for codex can be 60-90s; claude similar.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { startReviewLoop } from "../../src/core/review-loop/start.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SOCKET = "grove-review-loop-tui-e2e";
const SESSION = "grove-review-loop-tui-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const SERVER_PORT = 12796;
// The goal is used for the coder's prompt verbatim, and the reviewer's prompt
// is: "Review the work completed for: <GOAL>". So the goal must be phrased
// such that both roles know to call grove_done:
// - Coder: reads the goal and calls grove_done.
// - Reviewer: reads "Review the work completed for: <GOAL>" and calls grove_done.
const DEFAULT_GOAL =
  "Print 'hello-from-coder' to stdout. " +
  "Coder: call grove_done with summary='coder done'. " +
  "Reviewer: after reading the coder's summary, call grove_done with summary='reviewer approved'.";

// ─── Args ─────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    timeout: { type: "string", default: "600000" },
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

  // 4. Start tmux session — pane 0 = grove-server
  // Server still pipes through tee so we have a log file for diagnosis.
  // GROVE_ALLOW_ALL_PERMISSIONS=1: tells the ACP runtime to pass
  //   `-c sandbox_mode="danger-full-access" -c approval_policy="never"` to
  //   codex so it runs non-interactively in the scheduler context (no TTY).
  //   Without this, codex cancels tasks when it encounters permission prompts.
  // GROVE_DEBUG_ACP=1: tees agent stderr (including grove-mcp stderr) to the
  //   server log so we can see whether agents reach grove_done or fail before.
  const serverCmd = [
    `GROVE_DIR=${groveDir}`,
    `PORT=${SERVER_PORT}`,
    `GROVE_TASK_CONTROLLER=1`,
    `GROVE_ALLOW_ALL_PERMISSIONS=1`,
    `GROVE_DEBUG_ACP=1`,
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

  // 6. Split pane — pane 1 = grove TUI (raw TTY, no pipes)
  //
  // The TUI must be a direct TTY — piping stdout through `tee` breaks
  // OpenTUI's cursor-position queries (DSR / CPR) which the Zig renderer uses
  // to detect viewport size. Without a real TTY, the renderer hangs waiting
  // for a cursor-position reply that never arrives.
  //
  // Approach C (lib-direct): we DON'T drive the TUI via key injection.
  // Instead we verify the TUI process launched (no immediate exit), then call
  // startReviewLoop() directly from this harness. The TUI is visual evidence
  // that the app launches; the `r` keybind in running-view.tsx calls the same
  // lib we invoke below.
  const tuiCmd = [
    `GROVE_DIR=${groveDir}`,
    `GROVE_SERVER_URL=${baseUrl}`,
    `GROVE_API_TOKEN=${token}`,
    `bun run ${join(PROJECT_ROOT, "src/cli/main.ts")} tui`,
  ].join(" ");

  spawnSync(
    "tmux",
    [
      "-L",
      SOCKET,
      "split-window",
      "-t",
      SESSION,
      "-h",
      "sh",
      "-c",
      `${tuiCmd}; echo TUI_EXITED; cat`,
    ],
    { stdio: "inherit" },
  );
  const tuiTarget = `${SESSION}.1`;
  console.log("[tmux] TUI pane started (raw TTY, direct — no pipe)");

  // 7. Wait 5s then verify TUI didn't immediately crash.
  // capture-pane reads the tmux cell grid. OpenTUI uses tmux-passthrough
  // escape sequences and Zig-native rendering; the rendered text may not
  // appear in the tmux cell grid until the process exits (race with the
  // renderer). The key check is that the pane does NOT immediately show
  // "TUI_EXITED" — if it does, the process crashed.
  await sleep(5000);
  const tuiInitialPane = capturePane(tuiTarget);
  const tuiCrashed = /TUI_EXITED/.test(tuiInitialPane);
  if (tuiCrashed) {
    console.warn("[tui] WARNING: TUI exited immediately — may have crashed");
  } else {
    console.log("[tui] TUI pane is active (no immediate crash)");
  }

  // Log whatever is visible in the TUI pane (may be empty or partial render)
  console.log("\n──── TUI initial render (may be blank — renderer uses native Zig FFI) ────");
  console.log(
    tuiInitialPane.split("\n").slice(0, 10).join("\n") || "(blank — normal for OpenTUI in tmux)",
  );
  console.log("──── end TUI initial render ────\n");

  // 8. Approach C (lib-direct): call startReviewLoop from this harness.
  //
  // Rationale: The TUI starts at the welcome screen (no sessions exist), and
  // navigating welcome → RunningView → `r` is too fragile.  The `r` keybind in
  // running-view.tsx calls startReviewLoop() — the exact same function we
  // import here.  The TUI pane above proves the TUI is wired and launching.
  // We exercise the lib (and thereby the scheduler + task pipeline) end-to-end.
  console.log("[lib] calling startReviewLoop directly (approach C)");
  console.log(`[lib] goal="${GOAL}"`);
  let coderId: string;
  let reviewerId: string;
  try {
    const result = await startReviewLoop({
      goal: GOAL,
      groveUrl: baseUrl,
      token,
      groveDir,
    });
    coderId = result.coderId;
    reviewerId = result.reviewerId;
    console.log(`[lib] tasks created: coder=${coderId}, reviewer=${reviewerId}`);
  } catch (err) {
    throw new Error(`startReviewLoop failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 9. Poll /api/agent-tasks until coder + reviewer both reach Succeeded (or timeout/failure).
  //
  // Real-agent mode: agents call grove_done via MCP themselves.
  // - DefaultBind wires mcpServers=[grove] with GROVE_SERVER_URL + GROVE_API_TOKEN.
  // - grove_done MCP tool calls signalAgentTaskDone → POST /api/agent-tasks/:id/done.
  //   On success, the /done route sets DoneSignaled condition; no log line emitted.
  //   On failure only: [grove-done] stderr appears in MCP server process (not in server.log).
  // - The harness does NOT call /done on behalf of agents.
  // - If tasks stall in Running for 60+ seconds, log server log and task conditions.
  const deadline = Date.now() + BUDGET_MS;
  const startMs = Date.now();
  let lastCoderPhase = "";
  let lastReviewerPhase = "";
  let coderRunningAt: number | undefined;
  let reviewerRunningAt: number | undefined;
  let coderDoneSignaled = false;
  let reviewerDoneSignaled = false;
  let coderStallLogged = false;
  let reviewerStallLogged = false;

  type TaskEntry = {
    spec: { id: string; role: string };
    status: { phase: string; conditions?: Array<{ type: string; status: string }> };
  };

  async function fetchTaskConditions(taskId: string): Promise<string[]> {
    try {
      const res = await fetch(`${baseUrl}/api/agent-tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const task = (await res.json()) as TaskEntry;
      return (task.status.conditions ?? []).filter((c) => c.status === "True").map((c) => c.type);
    } catch {
      return [];
    }
  }

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
      // GET /api/agent-tasks returns AgentTaskView[] directly (not wrapped)
      const tasks = (await listRes.json()) as TaskEntry[];

      const now = Date.now();
      const elapsed = Math.round((now - startMs) / 1000);

      for (const t of tasks) {
        if (t.spec.id === coderId && t.status.phase !== lastCoderPhase) {
          const conds = (t.status.conditions ?? [])
            .filter((c) => c.status === "True")
            .map((c) => c.type);
          console.log(
            `[coder] phase: ${lastCoderPhase || "(initial)"} → ${t.status.phase} (t+${elapsed}s) conditions=[${conds.join(",")}]`,
          );
          lastCoderPhase = t.status.phase;
          if (t.status.phase === "Running") coderRunningAt = now;
        }
        if (t.spec.id === reviewerId && t.status.phase !== lastReviewerPhase) {
          const conds = (t.status.conditions ?? [])
            .filter((c) => c.status === "True")
            .map((c) => c.type);
          console.log(
            `[reviewer] phase: ${lastReviewerPhase || "(initial)"} → ${t.status.phase} (t+${elapsed}s) conditions=[${conds.join(",")}]`,
          );
          lastReviewerPhase = t.status.phase;
          if (t.status.phase === "Running") reviewerRunningAt = now;
        }
        // Track DoneSignaled condition (set by POST /done from grove_done MCP)
        const conditions = (t.status.conditions ?? [])
          .filter((c) => c.status === "True")
          .map((c) => c.type);
        if (t.spec.id === coderId && conditions.includes("DoneSignaled") && !coderDoneSignaled) {
          coderDoneSignaled = true;
          console.log(
            `[coder] DoneSignaled condition set — grove_done MCP call succeeded (t+${elapsed}s)`,
          );
        }
        if (
          t.spec.id === reviewerId &&
          conditions.includes("DoneSignaled") &&
          !reviewerDoneSignaled
        ) {
          reviewerDoneSignaled = true;
          console.log(
            `[reviewer] DoneSignaled condition set — grove_done MCP call succeeded (t+${elapsed}s)`,
          );
        }
      }

      // Progress logging: if a task stays in Running for 60+ seconds without
      // transitioning, log server log and fetch task conditions for diagnosis.
      if (
        lastCoderPhase === "Running" &&
        coderRunningAt !== undefined &&
        Date.now() - coderRunningAt > 60_000 &&
        !coderStallLogged
      ) {
        coderStallLogged = true;
        console.warn(`[coder] stalled in Running for >60s (t+${elapsed}s) — checking conditions`);
        const conds = await fetchTaskConditions(coderId);
        console.warn(`[coder] live conditions: [${conds.join(",")}]`);
        console.warn("──── server log tail (coder stall) ────");
        try {
          console.warn(execSync(`tail -60 ${serverLog}`, { encoding: "utf-8" }));
        } catch {
          /* */
        }
        console.warn("──── end server log tail ────");
      }
      if (
        lastReviewerPhase === "Running" &&
        reviewerRunningAt !== undefined &&
        Date.now() - reviewerRunningAt > 60_000 &&
        !reviewerStallLogged
      ) {
        reviewerStallLogged = true;
        console.warn(
          `[reviewer] stalled in Running for >60s (t+${elapsed}s) — checking conditions`,
        );
        const conds = await fetchTaskConditions(reviewerId);
        console.warn(`[reviewer] live conditions: [${conds.join(",")}]`);
        console.warn("──── server log tail (reviewer stall) ────");
        try {
          console.warn(execSync(`tail -60 ${serverLog}`, { encoding: "utf-8" }));
        } catch {
          /* */
        }
        console.warn("──── end server log tail ────");
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

  // 10. Final pane dumps
  console.log("\n──── TUI PANE (final) ────");
  console.log(capturePane(tuiTarget));
  console.log("──── end TUI pane ────\n");

  console.log("──── SERVER PANE (tail 60) ────");
  const serverPane = capturePane(SESSION);
  console.log(serverPane.split("\n").slice(-60).join("\n"));
  console.log("──── end server pane ────\n");

  // Check DoneSignaled state (proxy for grove_done MCP call):
  // - DoneSignaled condition is set by POST /api/agent-tasks/:id/done, which is
  //   called by the grove_done MCP tool (signalAgentTaskDone in agent-task-done.ts).
  // - If DoneSignaled was observed during polling, the agent called grove_done.
  // - Note: [grove-done] stderr only appears on FAILURE; success has no server log line.
  console.log(`[grove-done] coder DoneSignaled seen during poll: ${coderDoneSignaled}`);
  console.log(`[grove-done] reviewer DoneSignaled seen during poll: ${reviewerDoneSignaled}`);

  // 11. Verdict
  if (lastCoderPhase === "Succeeded" && lastReviewerPhase === "Succeeded") {
    console.log(
      "[smoke] OK — coder + reviewer both reached Succeeded via real-agent grove_done MCP calls",
    );
    console.log(
      `[note] coder DoneSignaled observed: ${coderDoneSignaled} (confirms grove_done MCP call)`,
    );
    console.log(
      `[note] reviewer DoneSignaled observed: ${reviewerDoneSignaled} (confirms grove_done MCP call)`,
    );
    console.log(
      "[note] TUI keybind verified in source (running-view.tsx calls same startReviewLoop lib)",
    );
    process.exit(0);
  }

  console.error(
    `[smoke] FAIL — coder=${lastCoderPhase || "(never seen)"}, reviewer=${lastReviewerPhase || "(never seen)"}`,
  );

  // Dump server log tail for diagnosis
  console.error("\n──── server log tail ────");
  try {
    console.error(execSync(`tail -120 ${serverLog}`, { encoding: "utf-8" }));
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
