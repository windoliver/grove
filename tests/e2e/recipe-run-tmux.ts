/**
 * Tmux-driven real-process E2E for the live `grove recipe run` path (#276).
 *
 * Proves the end-to-end recipe LIVE flow against a grove-managed stack:
 *   1. Fresh temp working dir + `git init` + a couple of source files.
 *   2. A valid recipe.yaml is materialized (parameters / extensions /
 *      instructions / agent_topology) — validated against GroveRecipeWireSchema.
 *   3. The stack is brought up via the grove-managed lifecycle
 *      (`grove up --headless --no-tui` in a tmux pane), which starts the HTTP
 *      server, MCP server, and a managed Nexus, persisting nexusUrl to grove.json.
 *   4. `grove recipe run ./recipe.yaml --param target_path=./src --json` runs
 *      with GROVE_RUNTIME=acp and real multi-agent (claude coder -> codex
 *      reviewer) launch, capturing the JSON output (sessionId + recipeDigest).
 *   5. We poll until both roles spawn, a coder->reviewer handoff/contribution
 *      occurs, and the session reaches a terminal state.
 *   6. ASSERTIONS:
 *      - run output recipeDigest is non-empty + `blake3:`-prefixed AND equals
 *        `grove recipe validate ./recipe.yaml --json`'s digest;
 *      - the session record read back FROM NEXUS carries
 *        recipeProvenance.recipeDigest equal to that digest;
 *      - the recipe's `stdio:` MCP extension was attached to the spawned
 *        agent's MCP set AND actually launched (proven by a sentinel file the
 *        stdio MCP shim writes on startup — see EXTENSION WIRING below);
 *      - at least one contribution / a handoff happened (proves real agents ran).
 *   7. Teardown: kill tmux, `grove down`, remove temp dir.
 *
 * NOT wired into `bun test` — run as:
 *   bun run tests/e2e/recipe-run-tmux.ts
 *
 * Requires real claude + codex CLIs on PATH and a managed-Nexus-capable host
 * (same prerequisites as a live review-loop). The controller runs this; this
 * file is authored to be runnable, not executed here.
 *
 * ─── EXTENSION WIRING VERIFICATION ──────────────────────────────────────────
 * The orchestrator appends the recipe's resolved `stdio:` MCP servers to EVERY
 * spawned agent's `config.mcpServers` (session-orchestrator.ts), and the ACP
 * runtime passes them into the child agent's `newSession({ mcpServers })` /
 * codex `mcp_servers.<name>` config. The most robust, run-surviving proof that
 * the extension is in the agent's MCP set is to point the recipe's `stdio:` URI
 * at a tiny stdio MCP shim we write into the temp dir; on startup the shim
 * touches a sentinel file under the grove dir. If the sentinel exists after the
 * run, the extension was wired into a real spawned agent AND launched.
 *
 * If the controller prefers a pre-existing command instead of the shim, the
 * other repo tests use `stdio:grove-fs-mcp` as the canonical example
 * (recipe.run.test.ts, recipe-extensions.test.ts). That binary is NOT on PATH
 * in this environment (verified), so this harness ships the self-contained
 * sentinel shim, which is both real and launchable. To switch, change
 * STDIO_MCP_URI below and drop the sentinel assertion.
 *
 * Flags:
 *   --keep          Leave tmux session + workdir for inspection
 *   --attach        Print `tmux attach` command and idle
 *   --timeout <ms>  Overall budget (default 600000 — real agents are slow)
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { Session } from "../../src/core/session.js";

// ─── Paths / constants ──────────────────────────────────────────────────────

const SOCKET = "grove-recipe-run-e2e";
const SESSION = "grove-recipe-run-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const MAIN_TS = join(PROJECT_ROOT, "src/cli/main.ts");

// Name of the recipe MCP extension. Must satisfy the recipe NamePattern
// (^[a-z][a-z0-9_-]*$).
const EXT_NAME = "sentinel-fs";

// ─── Args ───────────────────────────────────────────────────────────────────

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

// ─── tmux + polling helpers (mirrors watch-relist-tmux.ts) ──────────────────

function capturePane(target = SESSION): string {
  const out = spawnSync(
    "tmux",
    ["-L", SOCKET, "capture-pane", "-t", target, "-p", "-S", "-20000"],
    { encoding: "utf-8" },
  );
  return out.stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPane(
  predicate: (pane: string) => boolean,
  phase: string,
  maxMs = 30000,
  target = SESSION,
): Promise<string> {
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(target);
    if (predicate(last)) {
      console.error(`[${phase}] matched`);
      return last;
    }
    await sleep(1000);
  }
  console.error(`\n──── pane dump (${phase}, target=${target}) ────`);
  console.error(last);
  console.error("──── end pane dump ────\n");
  throw new Error(`[${phase}] predicate did not match within ${maxMs}ms`);
}

/** Poll an async predicate until it returns a value or the deadline passes. */
async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  phase: string,
  maxMs: number,
  intervalMs = 2000,
): Promise<T> {
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined) {
        console.error(`[${phase}] satisfied`);
        return value;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `[${phase}] not satisfied within ${maxMs}ms` +
      (lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : ""),
  );
}

// ─── Workdir setup ──────────────────────────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), "grove-recipe-run-"));
const groveDir = join(workDir, ".grove");
// Sentinel the stdio MCP shim writes on startup — proof the extension was
// wired into a spawned agent's MCP set AND launched.
const sentinelPath = join(workDir, "ext-launched.sentinel");
console.error(`[setup] workDir=${workDir}`);

let groveUpStarted = false;

function cleanup(): void {
  // Best-effort grove down first (stops managed Nexus + services), then tmux.
  if (groveUpStarted) {
    try {
      execSync(`bun run ${MAIN_TS} down --grove ${groveDir} --force`, {
        cwd: workDir,
        env: { ...process.env, GROVE_DIR: groveDir },
        stdio: "inherit",
        timeout: 60000,
      });
    } catch {
      /* best-effort */
    }
  }
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }
  if (!KEEP && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  } else if (KEEP) {
    console.error(`[cleanup] kept workDir=${workDir} (--keep)`);
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ─── stdio MCP shim ─────────────────────────────────────────────────────────

/**
 * A minimal, self-contained stdio MCP server (JSON-RPC over stdio) that the
 * recipe's `stdio:` extension points at. On startup it touches the sentinel
 * file (proof of launch), then answers `initialize` / `tools/list` and idles.
 * It deliberately exposes zero tools — its only job is to prove the wiring.
 */
function makeStdioMcpShim(sentinel: string): string {
  return `#!/usr/bin/env bun
// Generated stdio MCP shim for recipe-run-tmux e2e. Proves the recipe
// extension was wired into a spawned agent's MCP set and launched.
import { appendFileSync } from "node:fs";

try {
  appendFileSync(${JSON.stringify(sentinel)}, "launched " + new Date().toISOString() + "\\n");
} catch {
  /* best-effort — never crash the agent over the sentinel */
}

const enc = new TextEncoder();
function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(enc.encode(body + "\\n"));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
          serverInfo: { name: ${JSON.stringify(EXT_NAME)}, version: "0.0.1" },
          capabilities: { tools: {} },
        },
      });
    } else if (req.method === "tools/list") {
      send({ jsonrpc: "2.0", id: req.id, result: { tools: [] } });
    } else if (req.method === "notifications/initialized" || req.id === undefined) {
      // notification — no response
    } else {
      send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "method not found" },
      });
    }
  }
});
// Keep the process alive until the parent agent closes stdin.
process.stdin.on("end", () => process.exit(0));
`;
}

// ─── Recipe YAML ────────────────────────────────────────────────────────────

/**
 * A valid recipe per GroveRecipeWireSchema:
 *   - kind/recipe_version/name/version (semver)
 *   - parameters.target_path (string, required)
 *   - one mcp extension with a launchable `stdio:` URI (the shim above; the
 *     `required: true` flag forces a hard error if it can't be wired, so the
 *     test fails loud rather than silently skipping the extension)
 *   - instructions referencing ${parameters.target_path}
 *   - agent_topology: coder (claude-code) -> reviewer (codex), mirroring the
 *     review-loop preset topology (coder delegates to reviewer; reviewer
 *     ends_session).
 *
 * `shimPath` is absolute so the stdio command resolves regardless of agent cwd.
 */
function makeRecipeYaml(shimPath: string): string {
  // `bun ${shimPath}` is the launchable stdio command. resolveRecipeMcpServers
  // splits on whitespace → command="bun", args=[shimPath].
  return `kind: recipe
recipe_version: 1
name: recipe-run-e2e
version: 1.0.0
description: Live recipe-run tmux e2e — coder/reviewer over a target path.
parameters:
  target_path:
    type: string
    required: true
    description: Relative path the coder should work on.
extensions:
  - type: mcp
    name: ${EXT_NAME}
    uri: "stdio:bun ${shimPath}"
    required: true
instructions: |
  Implement a tiny improvement under \${parameters.target_path}.
  Coder: read the files under \${parameters.target_path}, make one small,
  correct edit (e.g. fix the obvious bug in add.js), commit it, then submit
  your work with grove_submit_work including the commit hash. Reviewer: read
  the coder's files at the Workspace path, submit a grove_submit_review, and
  if it is correct call grove_done to end the session.
agent_topology:
  structure: graph
  roles:
    - name: coder
      description: Writes and iterates on code
      platform: claude-code
      mode: broadcast
      max_instances: 1
      skills:
        - grove
      edges:
        - target: reviewer
          edge_type: delegates
          reply_timeout_seconds: 300
      prompt: |
        You are a software engineer. Workflow:
        1. Read the files under the target path and understand the goal.
        2. Edit files to implement the smallest correct fix.
        3. Commit: git add -A && git commit -m 'fix'
        4. Get the commit hash: git rev-parse HEAD
        5. grove_submit_work({ summary: "what you did", commitHash: "<hash>", agent: { role: "coder" } })
        6. Iterate on reviewer feedback. NEVER call grove_done yourself.
    - name: reviewer
      description: Reviews code and provides feedback
      platform: codex
      mode: broadcast
      max_instances: 1
      ends_session: true
      skills:
        - grove
      prompt: |
        You are a code reviewer. Wait for the coder's contribution to arrive.
        1. Read the actual source files at the Workspace path from the notification.
        2. grove_submit_review({ targetCid: "<CID>", summary: "review", scores: {"correctness": {"value": 0.9, "direction": "maximize"}}, agent: { role: "reviewer" } })
        3. In the SAME response: if correct, immediately grove_done({ summary: "Approved", agent: { role: "reviewer" } }).
           Only you can end the session.
  spawning:
    dynamic: true
    max_depth: 2
`;
}

// ─── Nexus readback (mirrors launch-session.ts) ─────────────────────────────

/**
 * Read the session record back FROM NEXUS using the exact same store wiring
 * grove uses to mirror it: NexusHttpClient + NexusSessionStore scoped to the
 * zone resolved from the grove dir's namespace. Reads grove.json for nexusUrl
 * (persisted by `grove up`) and .grove/api-key for the bearer.
 */
async function readSessionFromNexus(sessionId: string): Promise<Session | undefined> {
  const nexusUrl = resolveNexusUrl();
  if (!nexusUrl) throw new Error("nexusUrl not yet persisted to grove.json");
  const apiKey = resolveNexusApiKey();

  const { NexusHttpClient } = await import("../../src/nexus/nexus-http-client.js");
  const { NexusSessionStore } = await import("../../src/nexus/nexus-session-store.js");
  const { resolveSessionNexusZoneId } = await import("../../src/cli/commands/session.js");

  const client = new NexusHttpClient({
    url: nexusUrl,
    ...(apiKey ? { apiKey } : {}),
  });
  const zoneId = resolveSessionNexusZoneId(groveDir);
  const store = new NexusSessionStore(client, zoneId);
  return store.getSessionRecord(sessionId);
}

/** nexusUrl persisted to grove.json by `grove up` (service-lifecycle). */
function resolveNexusUrl(): string | undefined {
  if (process.env.GROVE_NEXUS_URL) return process.env.GROVE_NEXUS_URL;
  try {
    const cfg = JSON.parse(readFileSync(join(groveDir, "grove.json"), "utf-8")) as {
      nexusUrl?: string;
    };
    return cfg.nexusUrl;
  } catch {
    return undefined;
  }
}

/** Project API key written to .grove/api-key by `grove init`. */
function resolveNexusApiKey(): string | undefined {
  if (process.env.NEXUS_API_KEY) return process.env.NEXUS_API_KEY;
  try {
    return readFileSync(join(groveDir, "api-key"), "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Kill any leftover tmux socket.
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }

  mkdirSync(workDir, { recursive: true });

  // 1. Fresh git repo + a couple of source files for the agents to work on.
  console.error("[setup] git init + source files");
  execSync("git init -q && git config user.email e2e@grove.test && git config user.name 'Grove E2E'", {
    cwd: workDir,
    stdio: "inherit",
  });
  const srcDir = join(workDir, "src");
  mkdirSync(srcDir, { recursive: true });
  // A deliberately buggy tiny module so the coder has a clear, small fix.
  writeFileSync(
    join(srcDir, "add.js"),
    "// add(a, b) should return the sum. BUG: it subtracts.\nexport function add(a, b) {\n  return a - b;\n}\n",
  );
  writeFileSync(
    join(srcDir, "README.md"),
    "# target\n\n`add.js` has a one-line bug. Fix it so add(2, 3) === 5.\n",
  );
  execSync("git add -A && git commit -q -m 'seed source'", { cwd: workDir, stdio: "inherit" });

  // 2. Write the stdio MCP shim + recipe.yaml.
  const shimPath = join(workDir, "sentinel-mcp.ts");
  writeFileSync(shimPath, makeStdioMcpShim(sentinelPath));
  const recipePath = join(workDir, "recipe.yaml");
  writeFileSync(recipePath, makeRecipeYaml(shimPath));
  console.error(`[setup] recipe=${recipePath} shim=${shimPath}`);

  // 2a. `grove init --preset review-loop` — establishes a nexus-backed
  //     grove.json + api-key + server-keys so `grove up` brings up managed
  //     Nexus (review-loop preset declares backend: "nexus").
  console.error("[setup] grove init --preset review-loop");
  execSync(`bun run ${MAIN_TS} init --preset review-loop --force recipe-run-e2e`, {
    cwd: workDir,
    env: { ...process.env, GROVE_DIR: groveDir },
    stdio: "inherit",
  });

  // 2b. Validate the recipe up front and capture its canonical digest. This
  //     is the source-of-truth digest the run output + Nexus provenance must
  //     match. Also fails fast if the authored YAML is invalid.
  console.error("[setup] grove recipe validate");
  const validateOut = execSync(`bun run ${MAIN_TS} recipe validate ${recipePath} --json`, {
    cwd: workDir,
    env: { ...process.env, GROVE_DIR: groveDir },
    encoding: "utf-8",
  });
  const validate = JSON.parse(validateOut) as { valid: boolean; digest: string };
  if (!validate.valid || !/^blake3:/.test(validate.digest)) {
    throw new Error(`recipe validate produced invalid output: ${validateOut}`);
  }
  const canonicalDigest = validate.digest;
  console.error(`[setup] canonical recipe digest=${canonicalDigest}`);

  // 3. Bring up the stack via the grove-managed lifecycle in a tmux pane.
  //    `grove up --headless --no-tui` starts the HTTP server, MCP server, and
  //    managed Nexus, persisting nexusUrl to grove.json. GROVE_ALLOW_ALL_PERMISSIONS
  //    so the real agents' tool calls (edit/commit) aren't blocked by the
  //    default deny-most resolver. GROVE_DEBUG_ACP surfaces agent launch
  //    detail (incl. MCP wiring) into the captured pane for diagnostics.
  const upEnv = [
    `GROVE_DIR=${groveDir}`,
    "GROVE_RUNTIME=acp",
    "GROVE_ALLOW_ALL_PERMISSIONS=1",
    "GROVE_DEBUG_ACP=1",
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
      "-lc",
      `cd ${JSON.stringify(workDir)} && ${upEnv} bun run ${MAIN_TS} up --headless --no-tui --grove ${groveDir} 2>&1; cat`,
    ],
    { stdio: "inherit" },
  );
  groveUpStarted = true;
  console.error(`[tmux] grove up pane started. Attach: tmux -L ${SOCKET} attach -t ${SESSION}`);

  if (ATTACH) {
    console.error(`\nAttach in another terminal:\n  tmux -L ${SOCKET} attach -t ${SESSION}\n`);
    await sleep(BUDGET_MS);
    return;
  }

  // Wait until services report ready (headless `up` prints a started summary
  // and "Running in headless mode") AND nexusUrl is persisted to grove.json.
  await waitForPane(
    (p) => /Running in headless mode|Started \d+ service/.test(p),
    "stack-up",
    Math.min(BUDGET_MS, 120000),
  );
  await waitFor(
    async () => (resolveNexusUrl() ? true : undefined),
    "nexus-url-persisted",
    Math.min(BUDGET_MS, 120000),
  );
  console.error(`[phase 1] stack up; nexusUrl=${resolveNexusUrl()}`);

  // 4. Run the recipe LIVE in a second tmux pane, redirecting JSON output to a
  //    file (so we can parse it cleanly while the pane also shows progress).
  //    Real agents launch via AcpRuntime (GROVE_RUNTIME=acp). The run process
  //    inherits GROVE_NEXUS_URL via grove.json (resolved by launchGoalSession's
  //    Nexus mirror path), and the api-key from .grove/api-key.
  const runOutPath = join(workDir, "recipe-run.json");
  const runEnv = [
    `GROVE_DIR=${groveDir}`,
    "GROVE_RUNTIME=acp",
    "GROVE_ALLOW_ALL_PERMISSIONS=1",
    "GROVE_DEBUG_ACP=1",
    `GROVE_NEXUS_URL=${resolveNexusUrl() ?? ""}`,
    `NEXUS_API_KEY=${resolveNexusApiKey() ?? ""}`,
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
      "-lc",
      `cd ${JSON.stringify(workDir)} && ${runEnv} bun run ${MAIN_TS} recipe run ${recipePath} ` +
        `--param target_path=./src --json 2>>${JSON.stringify(join(workDir, "recipe-run.stderr.log"))} ` +
        `| tee ${JSON.stringify(runOutPath)}; echo RECIPE_RUN_EXIT=$?; cat`,
    ],
    { stdio: "inherit" },
  );
  const runTarget = `${SESSION}.1`;
  console.error("[tmux] recipe run pane started");

  // 5a. Wait for the run to emit its onAgentsStarted JSON (sessionId +
  //     recipeDigest). The JSON object is the FIRST thing written to runOutPath.
  const startInfo = await waitFor<{ sessionId: string; recipeDigest: string }>(
    async () => parseFirstJsonObject(runOutPath),
    "agents-started-json",
    Math.min(BUDGET_MS, 180000),
  );
  const { sessionId, recipeDigest } = startInfo;
  console.error(`[phase 2] recipe run started session=${sessionId} digest=${recipeDigest}`);

  // ── ASSERT (a): run output digest is blake3-prefixed and equals validate's.
  if (!recipeDigest || !/^blake3:/.test(recipeDigest)) {
    throw new Error(`run output recipeDigest is not blake3-prefixed: ${recipeDigest}`);
  }
  if (recipeDigest !== canonicalDigest) {
    throw new Error(
      `run output digest ${recipeDigest} != validate digest ${canonicalDigest}`,
    );
  }
  console.error("[assert a] run digest matches validate digest");

  // 5b. Wait for both roles to spawn (ACP launch lines in the up pane), the
  //     coder->reviewer handoff/contribution, and a terminal session state.
  //     We observe the run pane for the terminal line `... ended:` (recipe.ts
  //     non-json prints that, but in --json mode the loop still completes;
  //     we additionally confirm terminal state via the Nexus session record).
  await waitForPane(
    (p) => /coder/.test(p) && /reviewer/.test(p),
    "both-roles-spawned",
    Math.min(BUDGET_MS, 240000),
    SESSION,
  );
  console.error("[phase 3] both roles spawned");

  // ── ASSERT (c): the stdio MCP extension was attached to a spawned agent's
  //    MCP set AND launched — the shim wrote the sentinel.
  await waitFor(
    async () => (existsSync(sentinelPath) ? true : undefined),
    "extension-launched-sentinel",
    Math.min(BUDGET_MS, 240000),
  );
  console.error(
    `[assert c] stdio extension '${EXT_NAME}' launched (sentinel: ${sentinelPath})`,
  );

  // 5c. Wait for a terminal session state in Nexus AND at least one linked
  //     contribution (proves a real agent produced work / handoff).
  const terminalSession = await waitFor<Session>(
    async () => {
      const s = await readSessionFromNexus(sessionId);
      if (s === undefined) return undefined;
      const terminal =
        s.status === "completed" || s.status === "cancelled" || s.status === "archived";
      return terminal ? s : undefined;
    },
    "session-terminal-in-nexus",
    Math.min(BUDGET_MS, 360000),
    3000,
  );
  console.error(`[phase 4] session terminal in Nexus: status=${terminalSession.status}`);

  // ── ASSERT (b): the Nexus session record carries recipeProvenance with the
  //    same digest as the run output / validate.
  const provDigest = terminalSession.recipeProvenance?.recipeDigest;
  if (provDigest === undefined) {
    throw new Error(
      `Nexus session ${sessionId} has no recipeProvenance.recipeDigest: ${JSON.stringify(
        terminalSession.recipeProvenance,
      )}`,
    );
  }
  if (provDigest !== canonicalDigest) {
    throw new Error(
      `Nexus recipeProvenance.recipeDigest ${provDigest} != canonical ${canonicalDigest}`,
    );
  }
  console.error("[assert b] Nexus recipeProvenance.recipeDigest matches");

  // ── ASSERT (d): at least one contribution / handoff happened (real agents
  //    ran). The full session read links contributions; getSession() recomputes
  //    contributionCount from the Nexus link sidecar/markers.
  const linkedCount = await waitFor<number>(
    async () => {
      const full = await readFullSessionFromNexus(sessionId);
      const count = full?.contributionCount ?? 0;
      return count > 0 ? count : undefined;
    },
    "at-least-one-contribution",
    Math.min(BUDGET_MS, 60000),
    3000,
  );
  console.error(`[assert d] session has ${linkedCount} linked contribution(s)`);

  console.error(
    `\n✅ recipe-run tmux e2e PASS — session=${sessionId} digest=${recipeDigest} ` +
      `extension='${EXT_NAME}' launched, ${linkedCount} contribution(s), status=${terminalSession.status}`,
  );
  void runTarget;
}

// ─── Nexus full-session readback (recomputes contributionCount) ─────────────

async function readFullSessionFromNexus(sessionId: string): Promise<Session | undefined> {
  const nexusUrl = resolveNexusUrl();
  if (!nexusUrl) return undefined;
  const apiKey = resolveNexusApiKey();
  const { NexusHttpClient } = await import("../../src/nexus/nexus-http-client.js");
  const { NexusSessionStore } = await import("../../src/nexus/nexus-session-store.js");
  const { resolveSessionNexusZoneId } = await import("../../src/cli/commands/session.js");
  const client = new NexusHttpClient({ url: nexusUrl, ...(apiKey ? { apiKey } : {}) });
  const store = new NexusSessionStore(client, resolveSessionNexusZoneId(groveDir));
  return store.getSession(sessionId);
}

// ─── JSON parse helper ──────────────────────────────────────────────────────

/**
 * Parse the FIRST top-level JSON object from a file that may also contain
 * later lines (the recipe-run pane tees the onAgentsStarted JSON object first,
 * then potentially more output). recipe.ts emits the object with
 * `JSON.stringify(..., null, 2)`, so it spans multiple lines and ends at the
 * first line that is exactly `}`.
 */
function parseFirstJsonObject(
  path: string,
): { sessionId: string; recipeDigest: string } | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf-8");
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  // Find the matching closing brace by depth counting (robust to nested objects).
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          const obj = JSON.parse(slice) as {
            sessionId?: string;
            recipeDigest?: string;
          };
          if (obj.sessionId && obj.recipeDigest) {
            return { sessionId: obj.sessionId, recipeDigest: obj.recipeDigest };
          }
          return undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ recipe-run tmux e2e FAIL:", err);
    console.error("\n──── up pane (error) ────");
    try {
      console.error(capturePane(SESSION));
    } catch {
      /* tmux already dead */
    }
    console.error("\n──── recipe-run pane (error) ────");
    try {
      console.error(capturePane(`${SESSION}.1`));
    } catch {
      /* tmux already dead */
    }
    const stderrLog = join(workDir, "recipe-run.stderr.log");
    if (existsSync(stderrLog)) {
      console.error("\n──── recipe-run stderr log ────");
      try {
        console.error(readFileSync(stderrLog, "utf-8").slice(-4000));
      } catch {
        /* ignore */
      }
    }
    cleanup();
    process.exit(1);
  });
