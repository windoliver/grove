/**
 * Tmux-driven E2E smoke test for WatchClient relist on stale-rv (#293).
 *
 * Starts a real grove-server with tight ring-buffer retention (2000 ms,
 * max 2 events), then drives a WatchClient through the A5 handshake and
 * forces a stale-rv condition by pausing the watcher while 3 writes push
 * events past the ring boundary.  Asserts the watcher re-lists via a 410
 * response and surfaces all 5 markers.
 *
 * NOT wired into `bun test` — run as:
 *   bun run tests/e2e/watch-relist-tmux.ts
 *
 * Flags:
 *   --keep          Leave tmux session + workdir for inspection
 *   --attach        Print `tmux attach` command and wait
 *   --timeout <ms>  Overall budget (default 60000)
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

// ─── Paths ────────────────────────────────────────────────────────────────────

const SOCKET = "grove-watch-relist-e2e";
const SESSION = "grove-watch-relist-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const SERVER_PORT = 12793;

// ─── Args ─────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    attach: { type: "boolean", default: false },
    timeout: { type: "string", default: "60000" },
  },
});
const KEEP = values.keep;
const ATTACH = values.attach;
const BUDGET_MS = Number.parseInt(values.timeout as string, 10);

// ─── tmux helpers ─────────────────────────────────────────────────────────────

function tmux(cmd: string, opts: { check?: boolean } = {}): string {
  const args = cmd.split(" ").filter(Boolean);
  const out = spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf-8" });
  if (opts.check !== false && out.status !== 0) {
    throw new Error(`tmux ${cmd} failed (${out.status}): ${out.stderr}`);
  }
  return out.stdout.trim();
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
  maxMs = 30000,
  target = SESSION,
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
  console.error(`\n──── pane dump (${phase}) ────`);
  console.error(last);
  console.error("──── end pane dump ────\n");
  throw new Error(`[${phase}] predicate did not match within ${maxMs}ms`);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), "grove-watch-relist-"));
const groveDir = join(workDir, ".grove");
console.log(`[setup] workDir=${workDir}`);

function cleanup() {
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
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

// ─── Watcher script (written to a temp .ts file) ──────────────────────────────

function makeWatcherScript(projectRoot: string): string {
  // Language: TypeScript (run via bun). Receives env vars:
  //   GROVE_BASE_URL, GROVE_TOKEN, GROVE_PID_FILE
  //
  // Pause mechanism mirrors the unit test in watch.relist.e2e.test.ts:
  //   SIGUSR1 → set paused=true + killActiveWatches() (aborts open SSE stream)
  //             next watch request gets 503 so WatchClient loops in backoff
  //   SIGUSR2 → set paused=false; WatchClient retries from old lastSeenRv
  //             which is now stale → server SSE sends ERROR/410 → RELIST
  return `
import { WatchClient } from "${projectRoot}/src/core/watch-client.js";
import { writeFileSync } from "node:fs";

const baseUrl = process.env.GROVE_BASE_URL ?? "http://localhost:${SERVER_PORT}";
const token   = process.env.GROVE_TOKEN ?? "";
const pidFile = process.env.GROVE_PID_FILE ?? "/tmp/watcher.pid";

// Write our PID so the driver can send signals
writeFileSync(pidFile, String(process.pid));

let paused = false;
// Track active-watch stream close functions so we can terminate the SSE
// body cleanly (done=true) without throwing AbortError into WatchClient.
const killFns: (() => void)[] = [];

function killActiveWatches(): void {
  const fns = killFns.splice(0);
  for (const fn of fns) fn();
}

process.on("SIGUSR1", () => {
  paused = true;
  killActiveWatches(); // close currently open SSE streams cleanly
  console.log("[watcher] paused");
});
process.on("SIGUSR2", () => {
  paused = false;
  console.log("[watcher] resumed");
});

const outerAc = new AbortController();
process.on("SIGTERM", () => outerAc.abort());
process.on("SIGINT",  () => { outerAc.abort(); process.exit(0); });

// Proxied fetch — mirrors pauseGate from watch.relist.e2e.test.ts.
// When paused: returns 503 immediately so WatchClient triggers relist path.
// When live: wraps the response body through a manual ReadableStream that
// we can close early (cleanly, without AbortError) by calling its stored
// controller.close(). WatchClient's reader.read() returns done=true,
// streamWatch returns {kind:"ended"}, then the next request hits 503 and
// triggers relist (since paused is still true at that point, old lastSeenRv
// is now stale).
const proxiedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : (input as Request).url;
  if (url.includes("/api/watch")) {
    if (paused) {
      return new Response("", { status: 503 });
    }
    const res = await fetch(input as RequestInfo, init as RequestInit);
    if (!res.body) return res;

    // Wrap body in a manually-controlled ReadableStream so we can close it
    // cleanly (done=true) without throwing AbortError.
    let innerReader: ReadableStreamDefaultReader<Uint8Array> | null = res.body.getReader();
    let killed = false;

    const wrapped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!innerReader || killed) { controller.close(); return; }
        try {
          const { value, done } = await innerReader.read();
          if (done || killed) {
            controller.close();
            try { await innerReader.cancel(); } catch { /* ignore */ }
            innerReader = null;
          } else {
            controller.enqueue(value);
          }
        } catch {
          controller.close();
          innerReader = null;
        }
      },
      cancel() {
        killed = true;
        try { innerReader?.cancel(); } catch { /* ignore */ }
        innerReader = null;
      },
    });

    const killFn = (): void => {
      killed = true;
      try { innerReader?.cancel(); } catch { /* ignore */ }
      innerReader = null;
    };
    killFns.push(killFn);

    return new Response(wrapped, { status: res.status, headers: res.headers });
  }
  return fetch(input as RequestInfo, init as RequestInit);
}) as typeof fetch;

const client = new WatchClient({
  baseUrl,
  kind: "Contribution",
  authHeader: \`Bearer \${token}\`,
  fetch: proxiedFetch,
  backoff: { minMs: 50, maxMs: 500, jitter: 0 },
});

console.log("[watcher] starting");

client
  .run({
    onEvent(e) {
      const summary = (e.entity as { spec?: { summary?: string } })?.spec?.summary ?? "";
      console.log(\`[EVENT] op=\${e.op} rv=\${e.rv} summary=\${summary}\`);
    },
    signal: outerAc.signal,
  })
  .then(() => {
    console.log("[watcher] done");
  })
  .catch((err: unknown) => {
    if (outerAc.signal.aborted) return;
    console.error("[watcher] error:", err);
    process.exit(1);
  });
`;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Kill any leftover tmux socket
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }

  // 1. Init grove inside workDir (creates .grove/server-keys.yaml, api-key, project-id)
  console.log("[setup] grove init --preset review-loop");
  mkdirSync(workDir, { recursive: true });
  execSync(
    `GROVE_DIR=${groveDir} bun run ${join(PROJECT_ROOT, "src/cli/main.ts")} init --preset review-loop --force watch-smoke`,
    { cwd: workDir, stdio: "inherit" },
  );

  // 2. Read bearer token from .grove/server-keys.yaml
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

  // 3. Write watcher script to workDir
  const watcherScriptPath = join(workDir, "watcher.ts");
  writeFileSync(watcherScriptPath, makeWatcherScript(PROJECT_ROOT));

  const pidFile = join(workDir, "watcher.pid");
  const serverLogFile = join(workDir, "server.log");

  // 4. Create tmux session (server pane)
  spawnSync(
    "tmux",
    [
      "-L", SOCKET,
      "new-session", "-d",
      "-s", SESSION,
      "-x", "220",
      "-y", "50",
      "sh", "-c",
      // GROVE_WATCH_MAX_EVENTS=2 matches the unit test sizing:
      // after 2 events in the ring, a write evicts the oldest.
      // Writing 5 events while paused guarantees oldestRv > lastSeenRv.
      [
        `GROVE_DIR=${groveDir}`,
        `PORT=${SERVER_PORT}`,
        `GROVE_WATCH_RETENTION_MS=60000`,
        `GROVE_WATCH_MAX_EVENTS=2`,
        `bun run ${join(PROJECT_ROOT, "src/server/serve.ts")} 2>&1 | tee ${serverLogFile}`,
      ].join(" ") + "; cat",
    ],
    { stdio: "inherit" },
  );
  console.log(`[tmux] server pane started. Attach: tmux -L ${SOCKET} attach -t ${SESSION}`);

  if (ATTACH) {
    console.log(`\nAttach in another terminal:\n  tmux -L ${SOCKET} attach -t ${SESSION}\n`);
    await sleep(BUDGET_MS);
    return;
  }

  // 5. Wait for server to be listening
  await waitForPane((p) => /listening/.test(p), "server-ready", 30000);
  console.log("[phase 1] server listening");

  // 6. Split pane — watcher pane (pane 1)
  spawnSync(
    "tmux",
    [
      "-L", SOCKET,
      "split-window", "-t", SESSION,
      "-h",
      "sh", "-c",
      [
        `GROVE_BASE_URL=${baseUrl}`,
        `GROVE_TOKEN=${token}`,
        `GROVE_PID_FILE=${pidFile}`,
        `bun run ${watcherScriptPath}`,
      ].join(" ") + "; cat",
    ],
    { stdio: "inherit" },
  );
  console.log("[tmux] watcher pane started");

  // Helper: capture watcher pane (pane 1)
  const watcherTarget = `${SESSION}.1`;
  const waitWatcher = (pred: (p: string) => boolean, phase: string, maxMs?: number) =>
    waitForPane(pred, phase, maxMs, watcherTarget);

  // 7. Wait for initial RELIST (empty list is fine — client prints [watcher] starting first)
  await waitWatcher((p) => /\[watcher\] starting/.test(p), "watcher-started", 15000);
  console.log("[phase 2] watcher started");

  // Wait for at least one [EVENT] line (initial RELIST may fire immediately even with 0 items)
  // Give it a moment to connect
  await sleep(2000);

  // Helper: POST a contribution using plain JSON body (server supports both multipart and JSON)
  async function postContribution(summary: string) {
    const body = {
      kind: "work",
      mode: "evaluation",
      summary,
      agent: {
        agentId: "smoke-agent-001",
        agentName: "Smoke Agent",
        provider: "test",
        model: "test-model",
      },
      tags: [],
      relations: [],
      createdAt: new Date().toISOString(),
    };

    const res = await fetch(`${baseUrl}/api/contributions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /api/contributions failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    console.log(`[driver] posted ${summary} → cid=${(json as { cid?: string }).cid?.slice(0, 16)}...`);
  }

  // 8. POST m1
  await postContribution("m1");
  await waitWatcher((p) => /summary=m1/.test(p), "event-m1", 15000);
  console.log("[phase 3] m1 observed");

  // 9. POST m2
  await postContribution("m2");
  await waitWatcher((p) => /summary=m2/.test(p), "event-m2", 15000);
  console.log("[phase 4] m2 observed");

  // 10. Read watcher PID (wait for it to be written)
  let watcherPid: number | undefined;
  const pidDeadline = Date.now() + 10000;
  while (Date.now() < pidDeadline) {
    if (existsSync(pidFile)) {
      watcherPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      break;
    }
    await sleep(200);
  }
  if (!watcherPid) throw new Error("Watcher PID file not written");
  console.log(`[driver] watcher PID=${watcherPid}`);

  // 11. Pause watcher via SIGUSR1
  //     killActiveWatches() inside the watcher aborts the current SSE stream.
  process.kill(watcherPid, "SIGUSR1");
  console.log("[driver] sent SIGUSR1 (pause)");
  // Wait briefly so the signal handler runs and the SSE stream is aborted
  // before we start writing.
  await sleep(200);

  // 12. POST m3, m4, m5 while watcher is paused.
  //     With GROVE_WATCH_MAX_EVENTS=2, writing 5 events pushes oldestRv past
  //     lastSeenRv (which was 2 after m1+m2), matching the unit test sizing.
  for (let i = 3; i <= 7; i++) {
    await postContribution(`m${i}`);
  }
  console.log("[driver] 5 filler writes done (ring evicted m1/m2 rv)");

  // 14. Capture pre-resume RELIST count BEFORE sending SIGUSR2, so we can
  //     detect new RELISTs that appear after the resume.
  const preResumeContent = capturePane(watcherTarget);
  const preResumeRelistCount = (preResumeContent.match(/op=RELIST/g) ?? []).length;
  console.log(`[driver] pre-resume RELIST count=${preResumeRelistCount}`);

  // 13. Resume watcher via SIGUSR2
  process.kill(watcherPid, "SIGUSR2");
  console.log("[driver] sent SIGUSR2 (resume)");

  // Wait for RELIST after pause (the stale-rv relist).
  // The watcher will list → get 410/relist path → emit RELIST events at rv=7.
  await waitWatcher(
    (p) => {
      const curCount = (p.match(/op=RELIST/g) ?? []).length;
      return curCount > preResumeRelistCount;
    },
    "relist-after-stale",
    20000,
  );
  console.log("[phase 5] RELIST after stale-rv observed");

  // 15. Wait for post-pause markers to appear via RELIST snapshot
  await waitWatcher((p) => /summary=m5/.test(p), "event-m5-via-relist", 20000);
  console.log("[phase 6] m5 observed via relist");
  await waitWatcher((p) => /summary=m6/.test(p), "event-m6-via-relist", 20000);
  console.log("[phase 7] m6 observed via relist");

  // 16. Final assertions
  const finalPane = capturePane(watcherTarget);

  // All 7 markers must appear (m1-m7, whether via ADDED or RELIST)
  const allMarkers = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
  const missingMarkers = allMarkers.filter((m) => !new RegExp(`summary=${m}\\b`).test(finalPane));
  const relistCount = (finalPane.match(/op=RELIST/g) ?? []).length;

  console.log("\n──── watcher pane (final) ────");
  console.log(finalPane);
  console.log("──── end watcher pane ────\n");

  if (missingMarkers.length > 0) {
    console.error(`[FAIL] Missing markers in watcher output: ${missingMarkers.join(", ")}`);
    console.error("──── server log tail ────");
    try {
      console.error(execSync(`tail -50 ${serverLogFile}`, { encoding: "utf-8" }));
    } catch {
      /* no log */
    }
    process.exit(1);
  }

  if (relistCount < 2) {
    console.error(`[FAIL] Expected at least 2 RELIST events, got ${relistCount}`);
    console.error("──── server log tail ────");
    try {
      console.error(execSync(`tail -50 ${serverLogFile}`, { encoding: "utf-8" }));
    } catch {
      /* no log */
    }
    process.exit(1);
  }

  console.log(
    `[smoke] OK — RELIST after stale rv observed, all markers surfaced. (relistCount=${relistCount})`,
  );
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error("[FAIL]", err);
    console.error("\n──── watcher pane (error) ────");
    try {
      console.error(capturePane(`${SESSION}.1`));
    } catch {
      /* tmux already dead */
    }
    console.error("──── server pane (error) ────");
    try {
      console.error(capturePane(SESSION));
    } catch {
      /* tmux already dead */
    }
    cleanup();
    process.exit(1);
  });
