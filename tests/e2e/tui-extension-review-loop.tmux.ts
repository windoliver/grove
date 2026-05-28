/**
 * Tmux-driven E2E smoke for the TUI extension surface (#189).
 *
 * Validates the operator path against a real Grove review-loop data flow:
 *   1. Create a Codex coder -> Claude reviewer topology in real SQLite stores.
 *   2. Submit coder work, verify a reviewer handoff is created.
 *   3. Submit reviewer review, verify the handoff becomes replied.
 *   4. Submit the reviewer done marker.
 *   5. Mount the real TUI with a trusted local extension that contributes:
 *      - a default-visible operator panel showing the handoff/done state
 *      - a command-palette action
 *   6. Drive Ctrl+P / filter / Enter through tmux and assert the action message
 *      appears in the captured pane.
 *
 * NOT wired into `bun test` -- run as:
 *   bun ./tests/e2e/tui-extension-review-loop.tmux.ts
 *
 * Flags:
 *   --keep          Leave tmux session + workdir for inspection
 *   --attach        Print `tmux attach` command
 *   --timeout <ms>  Overall budget (default 60000)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SOCKET = "grove-tui-ext-e2e";
const SESSION = "grove-tui-ext-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");

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

function capturePane(): string {
  const out = spawnSync(
    "tmux",
    ["-L", SOCKET, "capture-pane", "-t", SESSION, "-p", "-S", "-5000"],
    {
      encoding: "utf-8",
    },
  );
  return out.stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPane(
  predicate: (pane: string) => boolean,
  phase: string,
  maxMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane();
    if (predicate(last)) {
      console.log(`[${phase}] matched`);
      return last;
    }
    await sleep(400);
  }
  console.error(`\n---- pane dump (${phase}) ----\n${last}\n---- end pane dump ----`);
  throw new Error(`[${phase}] predicate did not match within ${String(maxMs)}ms`);
}

function sendKeys(...keys: string[]): void {
  const args = ["-L", SOCKET, "send-keys", "-t", SESSION, ...keys];
  const result = spawnSync("tmux", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`tmux send-keys failed: ${result.stderr || result.stdout}`);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "grove-tui-ext-e2e-"));
const driverPath = join(PROJECT_ROOT, `.tmp-tui-extension-review-loop-${process.pid}.tsx`);

function cleanup(): void {
  if (!KEEP) {
    try {
      execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      /* already dead */
    }
  }
  if (!KEEP && existsSync(driverPath)) {
    rmSync(driverPath, { force: true });
  }
  if (!KEEP && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  } else if (KEEP) {
    console.log(`[cleanup] kept workDir=${workDir}`);
    console.log(`[cleanup] kept driver=${driverPath}`);
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function makeDriver(projectRoot: string): string {
  return `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";

const { LocalEventBus } = await import("${projectRoot}/src/core/local-event-bus.js");
const { HandoffStatus } = await import("${projectRoot}/src/core/handoff.js");
const { TopologyRouter } = await import("${projectRoot}/src/core/topology-router.js");
const { contributeOperation } = await import("${projectRoot}/src/core/operations/contribute.js");
const { initSqliteDb, SqliteContributionStore } = await import("${projectRoot}/src/local/sqlite-store.js");
const { SqliteHandoffStore } = await import("${projectRoot}/src/local/sqlite-handoff-store.js");
const { App } = await import("${projectRoot}/src/tui/app.js");
const { SpawnManager } = await import("${projectRoot}/src/tui/spawn-manager.js");
const { SpawnManagerContext } = await import("${projectRoot}/src/tui/spawn-manager-context.js");

const workDir = process.env.E2E_WORKDIR;
if (!workDir) throw new Error("E2E_WORKDIR required");
mkdirSync(workDir, { recursive: true });
mkdirSync(join(process.cwd(), ".grove"), { recursive: true });
writeFileSync(join(process.cwd(), ".grove", "tui-state.json"), '{"tooltipsDismissed":true}\\n');

const topology = Object.freeze({
  structure: "graph",
  roles: Object.freeze([
    Object.freeze({
      name: "coder",
      description: "Codex coder",
      platform: "codex",
      edges: Object.freeze([
        Object.freeze({ target: "reviewer", edgeType: "delegates", replyTimeoutSeconds: 30 }),
      ]),
    }),
    Object.freeze({
      name: "reviewer",
      description: "Claude reviewer",
      platform: "claude-code",
      endsSession: true,
    }),
  ]),
});

const db = initSqliteDb(join(workDir, "grove.db"));
const contributionStore = new SqliteContributionStore(db);
const handoffStore = new SqliteHandoffStore(db);
const eventBus = new LocalEventBus();
const topologyRouter = new TopologyRouter(topology, eventBus);
const deps = { contributionStore, handoffStore, topologyRouter, eventBus };

async function expectOk(result, label) {
  if (!result.ok) throw new Error(label + " failed: " + result.error.message);
  return result.value;
}

async function waitForHandoff(predicate, label) {
  const deadline = Date.now() + 5000;
  let last = [];
  while (Date.now() < deadline) {
    last = await handoffStore.list();
    const found = last.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(label + " not observed; last=" + JSON.stringify(last));
}

const work = await expectOk(
  await contributeOperation(
    {
      kind: "work",
      summary: "Codex coder implemented a TUI extension smoke",
      agent: { agentId: "codex-coder", role: "coder", platform: "codex" },
      context: { workspacePath: join(workDir, "codex-workspace") },
    },
    deps,
  ),
  "coder work",
);

const createdHandoff = await waitForHandoff(
  (handoff) => handoff.sourceCid === work.cid && handoff.toRole === "reviewer",
  "reviewer handoff",
);

const review = await expectOk(
  await contributeOperation(
    {
      kind: "review",
      summary: "Claude reviewer approved the TUI extension smoke",
      relations: [{ targetCid: work.cid, relationType: "reviews" }],
      scores: { correctness: { value: 0.95, direction: "maximize" } },
      agent: { agentId: "claude-reviewer", role: "reviewer", platform: "claude-code" },
    },
    deps,
  ),
  "reviewer review",
);

const repliedHandoff = await waitForHandoff(
  (handoff) => handoff.handoffId === createdHandoff.handoffId && handoff.status === HandoffStatus.Replied,
  "replied handoff",
);

const done = await expectOk(
  await contributeOperation(
    {
      kind: "discussion",
      summary: "[DONE] Claude reviewer approved",
      context: { ephemeral: true, done: true, reason: "Approved through tmux TUI extension E2E" },
      agent: { agentId: "claude-reviewer", role: "reviewer", platform: "claude-code" },
    },
    deps,
  ),
  "reviewer done",
);
const storedDone = await contributionStore.get(done.cid);
const doneSignaled = storedDone?.context?.done === true;
if (!doneSignaled) throw new Error("stored done marker did not preserve context.done=true");

const contributions = await contributionStore.list({ limit: 20 });
const handoffs = await handoffStore.list();
console.log("[flow] codex work cid=" + work.cid);
console.log("[flow] claude review cid=" + review.cid);
console.log("[flow] handoff status=" + repliedHandoff.status + " id=" + repliedHandoff.handoffId);
console.log("[flow] done marker cid=" + done.cid + " done=" + String(doneSignaled));

const capabilities = Object.freeze({
  outcomes: false,
  artifacts: false,
  vfs: false,
  messaging: false,
  costTracking: false,
  askUser: false,
  github: false,
  bounties: false,
  gossip: false,
  goals: false,
  sessions: false,
  handoffs: true,
});

const frontierEntries = contributions
  .filter((contribution) => contribution.context?.ephemeral !== true)
  .map((contribution, index) => ({
    cid: contribution.cid,
    summary: contribution.summary,
    value: contributions.length - index,
    contribution,
  }));

const provider = {
  capabilities,
  async getDashboard() {
    return {
      metadata: {
        name: "tui-extension-review-loop-e2e",
        contributionCount: contributions.length,
        activeClaimCount: 0,
        mode: "exploration",
        backendLabel: "tmux e2e",
        goal: "Validate Codex -> Claude review-loop TUI extension",
      },
      activeClaims: [],
      recentContributions: contributions,
      frontierSummary: { topByMetric: [], topByAdoption: [] },
    };
  },
  async getContributions() {
    return contributions;
  },
  async getContribution(cid) {
    const contribution = contributions.find((item) => item.cid === cid);
    if (!contribution) return undefined;
    return { contribution, ancestors: [], children: [], thread: [] };
  },
  async getClaims() {
    return [];
  },
  async getFrontier() {
    return {
      byMetric: {},
      byAdoption: [],
      byRecency: frontierEntries,
      byReviewScore: frontierEntries.filter((entry) => entry.contribution.kind === "review"),
      byReproduction: [],
    };
  },
  async getActivity() {
    return contributions;
  },
  async getDag() {
    return { contributions };
  },
  async getHotThreads() {
    return [];
  },
  async getHandoffs() {
    return handoffs;
  },
  async markHandoffDelivered() {},
  async cancelHandoff() {},
  async manualResolveHandoff() {},
  async resendHandoff() {},
  async rerouteHandoff() {},
  close() {},
};

function ReviewLoopPanel() {
  return React.createElement(
    "box",
    { flexDirection: "column", paddingLeft: 1 },
    React.createElement("text", { color: "#7dd3fc", bold: true }, "Review Handoff Extension"),
    React.createElement("text", null, "codex -> claude"),
    React.createElement("text", null, "handoff status: " + repliedHandoff.status),
    React.createElement("text", null, "review cid: " + review.cid.slice(0, 18)),
    React.createElement("text", null, "done marker: " + String(doneSignaled)),
  );
}

const extension = Object.freeze({
  id: "review-loop",
  name: "Review Loop Smoke",
  version: "1.0.0",
  panels: Object.freeze([
    Object.freeze({
      id: "review-loop-panel",
      label: "Review Loop",
      slot: "operator-panel",
      defaultVisible: true,
      order: 900,
      component: ReviewLoopPanel,
    }),
  ]),
  actions: Object.freeze([
    Object.freeze({
      id: "mark-handoff-done",
      label: "Mark handoff done",
      detail: "codex -> claude",
      order: 20,
      run: (context) => {
        context.showMessage("handoff done via plugin action");
      },
    }),
  ]),
});

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useAlternateScreen: false,
  useThread: false,
});
const root = createRoot(renderer);
const spawnManager = new SpawnManager(provider, undefined, (message) => {
  console.log("[spawn-error] " + message);
}, []);

root.render(
  React.createElement(
    SpawnManagerContext,
    { value: spawnManager },
    React.createElement(App, {
      provider,
      intervalMs: 1000,
      topology,
      extensions: [extension],
      screenContext: "inspect",
    }),
  ),
);

let driverCleaned = false;
function cleanupDriver() {
  if (driverCleaned) return;
  driverCleaned = true;
  eventBus.close();
  db.close();
  console.log("\\nTUI_DRIVER_DONE");
}

setTimeout(() => {
  renderer.destroy();
  cleanupDriver();
}, 30000);

renderer.start();
await renderer.idle();
cleanupDriver();
`;
}

async function main(): Promise<void> {
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }

  writeFileSync(driverPath, makeDriver(PROJECT_ROOT), "utf8");
  console.log(`[setup] workDir=${workDir}`);
  console.log(`[setup] driver=${driverPath}`);

  const command = [
    `cd ${JSON.stringify(workDir)}`,
    [
      `PATH="/Users/tafeng/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"`,
      `E2E_WORKDIR=${JSON.stringify(workDir)}`,
      "GROVE_NO_ALT_SCREEN=1",
      `bun run ${JSON.stringify(driverPath)} 2>&1`,
    ].join(" "),
    "cat",
  ].join(" && ");

  const started = spawnSync(
    "tmux",
    [
      "-L",
      SOCKET,
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      "180",
      "-y",
      "50",
      "sh",
      "-lc",
      command,
    ],
    { encoding: "utf-8" },
  );
  if (started.status !== 0) {
    throw new Error(`tmux new-session failed: ${started.stderr || started.stdout}`);
  }

  console.log(`[tmux] started. Attach: tmux -L ${SOCKET} attach -t ${SESSION}`);
  if (ATTACH) {
    console.log(`\nAttach in another terminal:\n  tmux -L ${SOCKET} attach -t ${SESSION}\n`);
  }

  await waitForPane(
    (pane) =>
      pane.includes("[flow] codex work cid=") &&
      pane.includes("[flow] claude review cid=") &&
      pane.includes("[flow] handoff status=replied") &&
      pane.includes("[flow] done marker cid="),
    "review-loop core flow",
    Math.min(BUDGET_MS, 20_000),
  );

  await waitForPane((pane) => pane.includes("[NORMAL] [INSPECT]"), "tui ready", 10_000);
  sendKeys("+");
  await waitForPane(
    (pane) =>
      pane.includes("Review Loop") &&
      pane.includes("claude") &&
      pane.includes("handoff status: replied") &&
      pane.includes("done marker: true"),
    "plugin panel rendered",
    Math.min(BUDGET_MS, 20_000),
  );

  sendKeys("C-p");
  await waitForPane((pane) => pane.includes("Command Palette"), "palette opened", 10_000);
  sendKeys("handoff");
  await waitForPane(
    (pane) => pane.includes("Mark handoff done") && pane.includes("codex -> claude"),
    "plugin action visible",
    10_000,
  );
  sendKeys("Enter");
  await waitForPane(
    (pane) => pane.includes("handoff done via plugin action"),
    "plugin action executed",
    10_000,
  );

  console.log("\nPASS tui extension review-loop tmux e2e");
}

main()
  .catch((err) => {
    console.error("\nFAIL tui extension review-loop tmux e2e:", err);
    process.exitCode = 1;
  })
  .finally(() => cleanup());
