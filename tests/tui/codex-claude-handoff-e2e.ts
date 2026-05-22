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
 *   --nexus-source <path>  Build/start Nexus from local source
 *   --nexus-image <ref>    Pin Nexus image ref (for prebuilt local test images)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const SOCKET = process.env.GROVE_E2E_TMUX_SOCKET ?? `grove-cx-cl-e2e-${process.pid}`;
const SESSION = "grove-cx-cl-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");

// ─── Args ─────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    attach: { type: "boolean", default: false },
    timeout: { type: "string", default: "600000" },
    "nexus-source": { type: "string" },
    "nexus-image": { type: "string" },
  },
});
const KEEP = values.keep;
const ATTACH = values.attach;
const BUDGET_MS = Number.parseInt(values.timeout as string, 10);
const NEXUS_SOURCE = values["nexus-source"] as string | undefined;
const NEXUS_IMAGE = values["nexus-image"] as string | undefined;
const SOURCE_SETUP_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.GROVE_E2E_SOURCE_SETUP_TIMEOUT_MS ?? "1200000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_200_000;
})();

interface NexusYaml {
  services?: unknown;
  compose_profiles?: unknown;
  ports?: Record<string, unknown> | undefined;
  api_key?: unknown;
  [key: string]: unknown;
}

interface NexusListResponse {
  items?: Array<{ path?: string; isDirectory?: boolean }>;
  detail?: string;
}

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

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function removeString(values: unknown, removed: string): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.filter((value): value is string => typeof value === "string" && value !== removed);
}

function dropOptionalSearchService(nexusYamlPath: string): void {
  const parsed = parseYaml(readFileSync(nexusYamlPath, "utf-8")) as NexusYaml | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Unable to parse Nexus YAML at ${nexusYamlPath}`);
  }

  const services = removeString(parsed.services, "zoekt");
  const profiles = removeString(parsed.compose_profiles, "search");
  if (services) parsed.services = services;
  if (profiles) parsed.compose_profiles = profiles;

  const ports = parsed.ports;
  if (ports && typeof ports === "object" && !Array.isArray(ports)) {
    const nextPorts: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ports)) {
      if (key !== "zoekt") nextPorts[key] = value;
    }
    parsed.ports = nextPorts;
  }

  writeFileSync(nexusYamlPath, stringifyYaml(parsed), "utf-8");
}

function tailFileIfExists(path: string, maxChars = 200_000): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return content.length > maxChars ? content.slice(-maxChars) : content;
}

function hasCoderWorkSignal(text: string): boolean {
  return /\[(?:seenCids|contribution)\].*kind=work role=coder/i.test(text);
}

function hasHandoffSignal(text: string): boolean {
  return (
    /\[nexus-ipc\] SEND OK sender=coder recipient=reviewer/i.test(text) ||
    /\[eventBus\] handoff event/i.test(text) ||
    /\[nexus-handoff\].*total=[1-9]/i.test(text) ||
    /\[NexusHandoffStore\.readModifyWrite\].*count=[1-9]/i.test(text)
  );
}

function hasReviewSignal(text: string): boolean {
  return (
    /\[(?:seenCids|contribution)\].*kind=review role=reviewer/i.test(text) ||
    /\[contribution\].*kind=discussion role=reviewer summary="\[DONE\] Approved/i.test(text)
  );
}

function hasCompletionSignal(text: string): boolean {
  return (
    /Session Complete/i.test(text) ||
    /Reason:\s*Session signaled done/i.test(text) ||
    /review-loop[\s\S]{0,80}Complete/i.test(text)
  );
}

function encodeSegment(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}

function readNexusApiKey(nexusYamlPath: string): string | undefined {
  const parsed = parseYaml(readFileSync(nexusYamlPath, "utf-8")) as NexusYaml | null;
  return typeof parsed?.api_key === "string" && parsed.api_key.length > 0
    ? parsed.api_key
    : undefined;
}

async function listNexusDir(
  nexusUrl: string,
  apiKey: string,
  path: string,
): Promise<NexusListResponse> {
  const params = new URLSearchParams({ path });
  const res = await fetch(`${nexusUrl}/api/v2/files/list?${params.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = (await res.json()) as NexusListResponse;
  if (!res.ok) {
    throw new Error(`Nexus list failed for ${path}: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  if (body.detail) {
    throw new Error(`Nexus list failed for ${path}: ${body.detail}`);
  }
  return body;
}

async function waitForPane(predicate: (pane: string) => boolean, phase: string, maxMs = 60000) {
  const started = Date.now();
  const deadline = started + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane();
    if (predicate(last)) {
      console.log(`[${phase}] matched in ${Date.now() - started}ms`);
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

  const nexusYamlPath = join(repoDir, "nexus.yaml");
  if (!existsSync(nexusYamlPath)) throw new Error(`nexus.yaml missing at ${nexusYamlPath}`);
  dropOptionalSearchService(nexusYamlPath);
  console.log("[setup] patched nexus.yaml: disabled optional search/zoekt service");

  // 5. Launch the TUI inside tmux. GROVE_DIR points at our temp grove.
  //    Use `--url` is not what we want — we want the interactive flow.
  // Wrap the TUI launch in a subshell that captures the exit code and
  // writes it to a file — the `; cat` at the end keeps the pane alive
  // so we can see the output even on crash.
  const stdoutLog = join(workDir, "tui.stdout.log");
  const debugPath = join(workDir, "grove-debug.log");
  const nexusSourceArgs = NEXUS_SOURCE ? ` --nexus-source ${shQuote(NEXUS_SOURCE)}` : "";
  const nexusImageEnv = NEXUS_IMAGE ? `NEXUS_IMAGE_REF=${shQuote(NEXUS_IMAGE)} ` : "";
  const healthTimeoutMs = NEXUS_SOURCE ? 120000 : 30000;
  // GROVE_ALLOW_ALL_PERMISSIONS=1 disables the RulesResolver gate so codex/claude
  // child processes are actually allowed to Edit + execute + fetch — otherwise
  // the coder cannot write hello.txt and the loop never produces a contribution.
  const launchCmd = [
    `cd ${repoDir}`,
    `${nexusImageEnv}GROVE_SERVICE_HEALTH_TIMEOUT_MS=${healthTimeoutMs} GROVE_ALLOW_ALL_PERMISSIONS=1 GROVE_DEBUG_LOG=${debugPath} bun run ${PROJECT_ROOT}/src/cli/main.ts up --grove ${groveDir}${nexusSourceArgs} 2>&1 | tee ${stdoutLog}`,
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

  // 9. Wait for goal-input screen. Source-backed Nexus builds can take several
  //    minutes before the TUI can advance past setup.
  const goalInputTimeoutMs = NEXUS_SOURCE ? SOURCE_SETUP_TIMEOUT_MS : 240_000;
  await waitForPane(
    (p) => /Goal|goal/.test(p) && /Continue|Esc:back|continue/i.test(p),
    "goal-input",
    goalInputTimeoutMs,
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
  let sawComplete = false;
  let lastCapture = "";
  while (Date.now() < observeEnd) {
    await sleep(15000);
    lastCapture = capturePane();
    const evidence = tailFileIfExists(debugPath);
    const headline = lastCapture.split("\n").slice(0, 5).join(" | ");
    const elapsed = Math.round((Date.now() - (observeEnd - OBSERVE_MS)) / 1000);
    console.log(`[observe t+${elapsed}s] ${headline.slice(0, 120)}`);
    if (!sawCoderWork && hasCoderWorkSignal(evidence)) {
      sawCoderWork = true;
      console.log("[phase 5] coder work submission detected");
    }
    if (!sawHandoff && hasHandoffSignal(evidence)) {
      sawHandoff = true;
      console.log("[phase 5] handoff event detected");
    }
    if (!sawReview && hasReviewSignal(evidence)) {
      sawReview = true;
      console.log("[phase 5] reviewer submission detected");
    }
    if (!sawComplete && hasCompletionSignal(lastCapture)) {
      sawComplete = true;
      console.log("[phase 5] session completion detected in tmux pane");
    }
    if (sawCoderWork && sawHandoff && sawReview && sawComplete) break;
  }

  // 15. Final capture + debug log tail.
  const finalPane = capturePane();
  sawComplete ||= hasCompletionSignal(finalPane);
  console.log("\n──── final pane ────");
  console.log(finalPane);
  console.log("──── end final pane ────");

  if (existsSync(debugPath)) {
    const debug = tailFileIfExists(debugPath).split("\n").slice(-300).join("\n");
    console.log("──── debug tail ────");
    console.log(debug);
    console.log("──── end debug tail ────");

    const finalEvidence = debug;
    sawCoderWork ||= hasCoderWorkSignal(finalEvidence);
    sawHandoff ||= hasHandoffSignal(finalEvidence);
    sawReview ||= hasReviewSignal(finalEvidence);
  }

  if (NEXUS_SOURCE) {
    const stdout = existsSync(stdoutLog) ? readFileSync(stdoutLog, "utf-8") : "";
    const sourceLabel = `source build from ${NEXUS_SOURCE}`;
    if (!stdout.includes(sourceLabel)) {
      throw new Error(`Source-backed Nexus validation failed — missing "${sourceLabel}"`);
    }
    console.log(`[nexus] source build validated: ${NEXUS_SOURCE}`);
  }

  // 16. Validate via Nexus VFS — contributions + handoffs should be there.
  console.log("\n[phase 6] querying Nexus VFS for contributions + handoffs");
  const groveJsonPath = join(groveDir, "grove.json");
  const namespacePath = join(groveDir, "namespace");
  const currentSessionPath = join(groveDir, "current-session.json");
  const groveJson = JSON.parse(readFileSync(groveJsonPath, "utf-8")) as {
    nexusUrl?: string;
  };
  const nexusUrl = groveJson.nexusUrl;
  const nexusApiKey = readNexusApiKey(nexusYamlPath);
  if (!nexusUrl || !nexusApiKey) {
    throw new Error("Nexus VFS validation unavailable — missing nexusUrl or nexus.yaml api_key");
  }
  const zoneId = readFileSync(namespacePath, "utf-8").trim();
  const currentSession = JSON.parse(readFileSync(currentSessionPath, "utf-8")) as {
    sessionId?: string;
  };
  const sessionId = currentSession.sessionId;
  if (!sessionId) throw new Error("Nexus VFS validation unavailable — missing sessionId");

  const encodedZoneRoot = `/zones/${encodeSegment(zoneId)}`;
  const rawZoneRoot = `/zones/${zoneId}`;
  const contributionList = await listNexusDir(
    nexusUrl,
    nexusApiKey,
    `${encodedZoneRoot}/sessions/${encodeSegment(sessionId)}/contributions`,
  );
  const handoffList = await listNexusDir(nexusUrl, nexusApiKey, `${rawZoneRoot}/handoffs`);
  const sessionList = await listNexusDir(nexusUrl, nexusApiKey, `${rawZoneRoot}/sessions`);
  console.log(
    `[nexus] contributions=${contributionList.items?.length ?? 0} handoffs=${handoffList.items?.length ?? 0} sessions=${sessionList.items?.length ?? 0}`,
  );
  if ((contributionList.items?.length ?? 0) < 2) {
    throw new Error("Nexus VFS validation failed — expected at least work + review contributions");
  }
  if ((handoffList.items?.length ?? 0) < 1) {
    throw new Error("Nexus VFS validation failed — expected at least one handoff record");
  }
  if ((sessionList.items?.length ?? 0) < 1) {
    throw new Error("Nexus VFS validation failed — expected at least one session record");
  }

  console.log(
    `\n[result] coderWork=${sawCoderWork} handoff=${sawHandoff} review=${sawReview} complete=${sawComplete}`,
  );
  if (!sawCoderWork || !sawHandoff || !sawReview || !sawComplete) {
    throw new Error(
      `E2E incomplete — coderWork=${sawCoderWork} handoff=${sawHandoff} review=${sawReview} complete=${sawComplete}`,
    );
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
