/**
 * Real-process E2E for the AcpxRuntime supervisor respawn path (#273, Phase 5.3).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠️  STATUS: NOT-YET-RUN. Authored without a live grove+Nexus stack.       │
 * │ This script encodes the INTENDED end-to-end scenario and assertions, but  │
 * │ it has NOT been executed against a real stack. Two areas are explicitly   │
 * │ marked TODO(verify-on-stack) below and will almost certainly need a tweak │
 * │ on first real run: (1) acpx child-PID discovery, (2) the exact agent-task │
 * │ id / readiness signal. Do NOT report this E2E as passing until it has been │
 * │ run on a real stack and the assertions observed green. See the runbook at  │
 * │ docs/superpowers/plans/2026-05-29-acpx-supervisor-e2e-runbook.md.          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Scenario:
 *   1. Start a real grove-server with GROVE_SUPERVISOR=1 (so selectRuntime wraps
 *      the runtime in AcpxSupervisor) in a fresh temp workdir + `git init`
 *      (fresh dir per run avoids the stale-session IPC stall — project memory).
 *   2. Create one AgentTask (PUT /api/agent-tasks/:id) that binds a real acpx
 *      agent; wait until its status.phase === "Running" and status.sessionId set.
 *   3. Discover the acpx adapter child PID and `kill -9` it (simulate a crash).
 *   4. Poll GET /api/agent-tasks/:id until a `SessionLost` condition appears
 *      AND status.phase is still "Running" (transient blip, NOT Failed) AND
 *      status.sessionId has CHANGED (respawn bound a fresh session).
 *
 * What this E2E can and cannot assert (verified against the codebase, #273):
 *   ✅ AgentTask phase transitions (Pending → Running) and stays Running on a
 *      recoverable respawn (does not flip to Failed).
 *   ✅ A `SessionLost` condition (type "SessionLost", status "True") is present
 *      after respawn — set by src/server/acpx-supervisor-wiring.ts.
 *   ✅ status.sessionId changes across the kill boundary (fresh session/new).
 *   ❌ Monotonic `seq` across the kill boundary is NOT externally observable.
 *      Supervisor-stamped seq lives only on the in-process AcpRuntimeEvent sink
 *      (→ AcpSessionStore, TUI-local). It is NOT exposed over HTTP/SSE today, so
 *      a black-box E2E cannot assert seq continuity. Seq continuity IS covered
 *      by the unit test src/core/acpx-supervisor.respawn.test.ts
 *      ("seq is strictly increasing across turns and respawn (no reset)").
 *      If wire-level seq observability is wanted, that's a separate follow-up
 *      (expose seq on the watch/agent-event stream), tracked outside #273.
 *
 * NOT wired into `bun test`. Run as:
 *   GROVE_SUPERVISOR=1 bun run tests/e2e/acpx-supervisor-respawn-tmux.ts
 *
 * Flags:
 *   --keep          Leave tmux session + workdir for inspection
 *   --attach        Print `tmux attach` command and wait
 *   --timeout <ms>  Overall budget (default 120000)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

// ─── Paths / constants ──────────────────────────────────────────────────────

const SOCKET = "grove-acpx-respawn-e2e";
const SESSION = "grove-acpx-respawn-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const SERVER_PORT = 12931;
const TASK_ID = "e2e-respawn-task";
const ROLE = "coder";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    attach: { type: "boolean", default: false },
    timeout: { type: "string", default: "120000" },
  },
});
const KEEP = values.keep;
const ATTACH = values.attach;
const BUDGET_MS = Number.parseInt(values.timeout as string, 10);

// ─── tmux helpers (mirrors tests/e2e/watch-relist-tmux.ts) ──────────────────

function tmux(cmd: string, args: string[], opts: { check?: boolean } = {}): string {
  const out = spawnSync("tmux", ["-L", SOCKET, cmd, ...args], { encoding: "utf-8" });
  if (opts.check !== false && out.status !== 0) {
    throw new Error(`tmux ${cmd} failed (${out.status}): ${out.stderr}`);
  }
  return out.stdout;
}

function sendKeys(line: string, enter: "C-m" | undefined, target = SESSION): void {
  tmux("send-keys", ["-t", target, line, ...(enter ? [enter] : [])]);
}

function capturePane(target = SESSION): string {
  const out = spawnSync("tmux", ["-L", SOCKET, "capture-pane", "-t", target, "-p", "-S", "-5000"], {
    encoding: "utf-8",
  });
  return out.stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPane(
  predicate: (pane: string) => boolean,
  phase: string,
  maxMs: number,
  target = SESSION,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate(capturePane(target))) {
      console.log(`[${phase}] matched`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`[${phase}] predicate did not match within ${maxMs}ms`);
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

interface TaskCondition {
  readonly type: string;
  readonly status: string;
  readonly reason: string;
}
interface TaskView {
  readonly status: {
    readonly phase: string;
    readonly sessionId?: string;
    readonly conditions: readonly TaskCondition[];
  };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function getTask(baseUrl: string, token: string): Promise<TaskView | undefined> {
  const res = await fetch(`${baseUrl}/api/agent-tasks/${TASK_ID}`, { headers: authHeaders(token) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET task failed: ${res.status}`);
  return (await res.json()) as TaskView;
}

async function pollTask(
  baseUrl: string,
  token: string,
  predicate: (t: TaskView) => boolean,
  phase: string,
  maxMs: number,
): Promise<TaskView> {
  const deadline = Date.now() + maxMs;
  let last: TaskView | undefined;
  while (Date.now() < deadline) {
    last = await getTask(baseUrl, token);
    if (last && predicate(last)) {
      console.log(
        `[${phase}] matched: phase=${last.status.phase} session=${last.status.sessionId}`,
      );
      return last;
    }
    await sleep(750);
  }
  throw new Error(`[${phase}] not satisfied within ${maxMs}ms; last=${JSON.stringify(last)}`);
}

// ─── acpx child-PID discovery ───────────────────────────────────────────────
// TODO(verify-on-stack): confirm the adapter process name. The supervisor's
// shared AcpRuntime spawns the agent adapter via acp-launch (codex →
// @zed-industries/codex-acp, claude → @agentclientprotocol/claude-agent-acp,
// gemini → `gemini --acp`). On the real stack, inspect `pgrep -fl` output once
// and pin the matching pattern. We match a process whose argv mentions the
// adapter and is a descendant of our server, then return the youngest match.
function findAcpxChildPid(): number | undefined {
  const out = spawnSync(
    "bash",
    ["-lc", "pgrep -fl 'codex-acp|claude-agent-acp|gemini .*--acp|acp' || true"],
    { encoding: "utf-8" },
  );
  const lines = out.stdout.split("\n").filter((l) => l.trim().length > 0);
  // Prefer the most recently started match (highest pid is a rough proxy).
  const pids = lines
    .map((l) => Number.parseInt(l.trim().split(/\s+/)[0] ?? "", 10))
    .filter((n) => Number.isInteger(n));
  if (pids.length === 0) return undefined;
  return Math.max(...pids);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env.GROVE_SUPERVISOR !== "1") {
    throw new Error("GROVE_SUPERVISOR=1 is required (the supervisor must wrap the runtime)");
  }
  const startedAt = Date.now();
  const budgetLeft = (): number => Math.max(1000, BUDGET_MS - (Date.now() - startedAt));

  const workdir = mkdtempSync(join(tmpdir(), "grove-acpx-respawn-"));
  // Fresh git repo per run — avoids the stale-session IPC stall (project memory).
  execSync("git init -q", { cwd: workdir });
  execSync("git commit -q --allow-empty -m init", {
    cwd: workdir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  });

  // Initialize a grove project (preset gives server keys + .grove scaffold).
  execSync(`bun run ${join(PROJECT_ROOT, "src/cli/main.ts")} init --preset review-loop`, {
    cwd: workdir,
    stdio: "inherit",
  });

  tmux("new-session", ["-d", "-s", SESSION, "-x", "220", "-y", "50"]);

  const serverEntry = join(PROJECT_ROOT, "src/server/serve.ts");
  // GROVE_SUPERVISOR=1 makes selectRuntime() wrap the runtime in AcpxSupervisor.
  sendKeys(
    `cd ${workdir} && GROVE_SUPERVISOR=1 GROVE_TASK_CONTROLLER=1 bun ${serverEntry} --port ${SERVER_PORT}`,
    "C-m",
  );
  await waitForPane((p) => /listening|ready|Server listening/i.test(p), "server-start", 25000);

  // Bearer token for the API.
  const keysPath = join(workdir, ".grove", "server-keys.yaml");
  let token = "";
  if (existsSync(keysPath)) {
    const parsed = parseYaml(readFileSync(keysPath, "utf-8")) as {
      keys?: Array<{ token?: string }>;
    };
    token = parsed.keys?.[0]?.token ?? "";
  }
  const baseUrl = `http://127.0.0.1:${SERVER_PORT}`;

  // ─── Create the AgentTask (binds a real acpx agent via the controller) ──────
  // TODO(verify-on-stack): confirm the AgentTask spec shape the server accepts
  // (worktree/runtime/role/prompt/generation). Adjust to the real PUT schema.
  const putRes = await fetch(`${baseUrl}/api/agent-tasks/${TASK_ID}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify({
      id: TASK_ID,
      worktree: workdir,
      runtime: "codex",
      role: ROLE,
      prompt: "Stay running; do nothing destructive. Wait for instructions.",
      dependsOn: [],
      generation: 1,
      createdAt: new Date().toISOString(),
    }),
  });
  if (!putRes.ok) throw new Error(`PUT agent-task failed: ${putRes.status} ${await putRes.text()}`);

  // ─── Wait for the task to bind + run ───────────────────────────────────────
  const running = await pollTask(
    baseUrl,
    token,
    (t) => t.status.phase === "Running" && typeof t.status.sessionId === "string",
    "task-running",
    Math.min(60000, budgetLeft()),
  );
  const firstSessionId = running.status.sessionId;
  console.log(`[bound] first sessionId=${firstSessionId}`);

  // ─── Kill the acpx child to simulate a crash ───────────────────────────────
  const pid = findAcpxChildPid();
  if (pid === undefined) {
    throw new Error(
      "could not find an acpx adapter child PID to kill — see TODO(verify-on-stack) in findAcpxChildPid()",
    );
  }
  console.log(`[kill] SIGKILL acpx child pid=${pid}`);
  spawnSync("kill", ["-9", String(pid)]);

  // ─── Assert respawn: SessionLost condition + new session + still Running ────
  const recovered = await pollTask(
    baseUrl,
    token,
    (t) =>
      t.status.phase === "Running" &&
      t.status.conditions.some((c) => c.type === "SessionLost" && c.status === "True") &&
      typeof t.status.sessionId === "string" &&
      t.status.sessionId !== firstSessionId,
    "task-respawned",
    Math.min(90000, budgetLeft()),
  );

  console.log(
    `PASS: respawn observed — SessionLost set, phase still Running, sessionId ${firstSessionId} → ${recovered.status.sessionId}`,
  );
  console.log(
    "NOTE: seq continuity is NOT asserted here (not wire-observable); see acpx-supervisor.respawn.test.ts.",
  );

  // ─── Teardown ───────────────────────────────────────────────────────────────
  if (ATTACH) {
    console.log(`Attach with: tmux -L ${SOCKET} attach -t ${SESSION}`);
    await sleep(budgetLeft());
  }
  if (!KEEP) {
    tmux("kill-session", ["-t", SESSION], { check: false });
    rmSync(workdir, { recursive: true, force: true });
  } else {
    console.log(`[keep] workdir=${workdir} session=${SESSION} socket=${SOCKET}`);
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  // Best-effort teardown on failure unless --keep.
  if (!KEEP) tmux("kill-session", ["-t", SESSION], { check: false });
  process.exit(1);
});
