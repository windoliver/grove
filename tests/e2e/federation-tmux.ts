/**
 * Tmux-driven real-process E2E smoke for gossip federation (#226).
 *
 * Boots TWO grove-server processes in tmux windows:
 *   - Server A: holds a contribution + artifact (origin).
 *   - Server B: seeded with A's URL, empty stores.
 * Drives a real gossip exchange over HTTP, then asks B to pull the cid via
 * `POST /api/gossip/fetch/:cid` and verifies B now has both the manifest and
 * the artifact bytes locally.
 *
 * NOT wired into `bun test` — run as:
 *   bun run tests/e2e/federation-tmux.ts
 *
 * Flags:
 *   --keep         Leave tmux session + workdirs for inspection
 *   --attach       Print attach command and idle
 *   --timeout <ms> Overall budget (default 90000)
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { hash as blake3Hash } from "blake3";
import { parse as parseYaml } from "yaml";

const SOCKET = "grove-federation-e2e";
const SESSION = "grove-federation-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const PORT_A = 12810;
const PORT_B = 12811;
const HMAC_SECRET = "fed-e2e-hmac-shared-secret-do-not-leak";
const GOSSIP_INTERVAL_MS = 1500;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    keep: { type: "boolean", default: false },
    attach: { type: "boolean", default: false },
    timeout: { type: "string", default: "90000" },
  },
});
const KEEP = values.keep;
const ATTACH = values.attach;
const BUDGET_MS = Number.parseInt(values.timeout as string, 10);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function capturePane(target: string): string {
  const out = spawnSync("tmux", ["-L", SOCKET, "capture-pane", "-t", target, "-p", "-S", "-5000"], {
    encoding: "utf-8",
  });
  return out.stdout;
}

async function waitForPane(
  target: string,
  predicate: (pane: string) => boolean,
  phase: string,
  maxMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(target);
    if (predicate(last)) {
      console.log(`[${phase}] ready`);
      return;
    }
    await sleep(400);
  }
  console.error(`\n──── pane dump (${phase}, target=${target}) ────\n${last}\n──── end ────`);
  throw new Error(`[${phase}] predicate did not match within ${maxMs}ms`);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "grove-fed-e2e-"));
const workA = join(tmpRoot, "a");
const workB = join(tmpRoot, "b");
const groveA = join(workA, ".grove");
const groveB = join(workB, ".grove");

function cleanup(): void {
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }
  if (!KEEP) {
    rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.log(`[cleanup] kept workdirs: ${workA}, ${workB}`);
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function initWorkdir(work: string, name: string): string {
  mkdirSync(work, { recursive: true });
  execSync(
    `bun run ${join(PROJECT_ROOT, "src/cli/main.ts")} init --preset review-loop --force ${name}`,
    { cwd: work, env: { ...process.env, GROVE_DIR: join(work, ".grove") }, stdio: "inherit" },
  );
  const keysFile = parseYaml(readFileSync(join(work, ".grove/server-keys.yaml"), "utf8")) as {
    keys: Record<string, { namespace: string }>;
  };
  const token = Object.keys(keysFile.keys)[0];
  if (!token) throw new Error(`no token in ${work}/.grove/server-keys.yaml`);
  return token;
}

function blake3Of(bytes: Uint8Array): string {
  return `blake3:${blake3Hash(bytes).toString("hex")}`;
}

async function postJson(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function getJson(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function main(): Promise<void> {
  try {
    execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }

  console.log(`[setup] tmpRoot=${tmpRoot}`);
  console.log("[setup] grove init A");
  const tokenA = initWorkdir(workA, "fed-e2e-a");
  console.log("[setup] grove init B");
  const tokenB = initWorkdir(workB, "fed-e2e-b");

  console.log(`[setup] tokenA=${tokenA.slice(0, 12)}…  tokenB=${tokenB.slice(0, 12)}…`);

  const baseA = `http://localhost:${PORT_A}`;
  const baseB = `http://localhost:${PORT_B}`;

  // Start server A in a new tmux session (pane 0).
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
      `${[
        `GROVE_DIR=${groveA}`,
        `PORT=${PORT_A}`,
        `GOSSIP_PEER_ID=peer-a`,
        `GOSSIP_ADDRESS=${baseA}`,
        `GROVE_GOSSIP_HMAC_SECRET=${HMAC_SECRET}`,
        `GROVE_GOSSIP_ALLOW_PRIVATE_IPS=true`,
        `GROVE_GOSSIP_INTERVAL_MS=${GOSSIP_INTERVAL_MS}`,
        // A seeds itself with B's address. Each gossip-enabled grove-server
        // needs at least one seedPeer to instantiate the GossipService; A
        // will retry-on-failure until B comes up shortly after.
        `GOSSIP_SEEDS=peer-b@${baseB}`,
        `bun run ${join(PROJECT_ROOT, "src/server/serve.ts")} 2>&1`,
      ].join(" ")}; cat`,
    ],
    { stdio: "inherit" },
  );
  console.log(`[tmux] server A pane started (attach: tmux -L ${SOCKET} attach -t ${SESSION})`);

  // Server B in a second pane.
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
      `${[
        `GROVE_DIR=${groveB}`,
        `PORT=${PORT_B}`,
        `GOSSIP_PEER_ID=peer-b`,
        `GOSSIP_ADDRESS=${baseB}`,
        `GOSSIP_SEEDS=peer-a@${baseA}`,
        `GROVE_GOSSIP_HMAC_SECRET=${HMAC_SECRET}`,
        `GROVE_GOSSIP_ALLOW_PRIVATE_IPS=true`,
        `GROVE_GOSSIP_INTERVAL_MS=${GOSSIP_INTERVAL_MS}`,
        `bun run ${join(PROJECT_ROOT, "src/server/serve.ts")} 2>&1`,
      ].join(" ")}; cat`,
    ],
    { stdio: "inherit" },
  );
  console.log("[tmux] server B pane started");

  if (ATTACH) {
    console.log(`\nAttach: tmux -L ${SOCKET} attach -t ${SESSION}\n`);
    await sleep(BUDGET_MS);
    return;
  }

  // 1. Wait for both servers to be listening.
  await waitForPane(`${SESSION}.0`, (p) => /listening/i.test(p), "server-A-listen", 30_000);
  await waitForPane(`${SESSION}.1`, (p) => /listening/i.test(p), "server-B-listen", 30_000);

  // 2. Submit a contribution + artifact to server A (multipart).
  const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70]);
  const artifactHash = blake3Of(bytes);
  console.log(`[step] uploading artifact to A; declared hash=${artifactHash.slice(0, 18)}…`);

  const form = new FormData();
  const manifest = {
    kind: "work",
    mode: "evaluation",
    summary: "Federation e2e: origin contribution on server A",
    artifacts: {},
    relations: [],
    tags: ["fed-e2e"],
    agent: { agentId: "fed-e2e-agent", agentName: "fed-e2e", platform: "tmux-e2e" },
  };
  form.append("manifest", JSON.stringify(manifest));
  form.append("artifact:payload.bin", new Blob([bytes], { type: "application/octet-stream" }));
  const submitRes = await fetch(`${baseA}/api/contributions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenA}` },
    body: form,
  });
  if (submitRes.status !== 201) {
    throw new Error(
      `POST /api/contributions on A → HTTP ${submitRes.status}: ${await submitRes.text()}`,
    );
  }
  const submitted = (await submitRes.json()) as { cid: string };
  const cid = submitted.cid;
  console.log(`[step] A has cid=${cid}`);

  // 3. Confirm B does NOT have it yet.
  const beforeRes = await getJson(`${baseB}/api/contributions/${encodeURIComponent(cid)}`, tokenB);
  if (beforeRes.status !== 404) {
    throw new Error(`expected B to 404 before fetch; got ${beforeRes.status}`);
  }
  console.log("[step] B confirmed empty (404)");

  // 4. Wait for gossip cycle so B records the advertisement.
  console.log(`[step] waiting ${GOSSIP_INTERVAL_MS * 3}ms for gossip round`);
  await sleep(GOSSIP_INTERVAL_MS * 3);

  // 5. Trigger federation fetch on B.
  const fetchRes = await postJson(
    `${baseB}/api/gossip/fetch/${encodeURIComponent(cid)}`,
    tokenB,
    {},
  );
  const fetchJson = (await fetchRes.json()) as { kind: string; cid: string; reason?: string };
  console.log(`[step] B fetch → HTTP ${fetchRes.status}, kind=${fetchJson.kind}`);
  if (fetchRes.status !== 200 || (fetchJson.kind !== "ok" && fetchJson.kind !== "already-local")) {
    throw new Error(`B fetch failed: ${JSON.stringify(fetchJson)}`);
  }

  // 6. Verify B now holds the contribution.
  const afterRes = await getJson(`${baseB}/api/contributions/${encodeURIComponent(cid)}`, tokenB);
  if (afterRes.status !== 200) {
    throw new Error(`B should have contribution after fetch; got ${afterRes.status}`);
  }
  const stored = (await afterRes.json()) as { cid: string; artifacts: Record<string, string> };
  if (stored.cid !== cid) throw new Error("stored cid mismatch");
  if (stored.artifacts["payload.bin"] !== artifactHash) {
    throw new Error(`stored artifact hash mismatch; got ${stored.artifacts["payload.bin"]}`);
  }
  console.log("[step] B has the contribution manifest");

  // 7. Verify B has the artifact bytes via the contribution-scoped route
  //    (the only federation-facing read path; hash-keyed CAS reads were
  //    removed to keep zone-shared CAS blobs from leaking by hash).
  const blobRes = await getJson(
    `${baseB}/api/contributions/${encodeURIComponent(cid)}/artifacts/payload.bin`,
    tokenB,
  );
  if (blobRes.status !== 200) {
    throw new Error(`B should have artifact bytes; got ${blobRes.status}`);
  }
  const blob = new Uint8Array(await blobRes.arrayBuffer());
  if (blob.byteLength !== bytes.byteLength) {
    throw new Error(`artifact size mismatch: ${blob.byteLength} vs ${bytes.byteLength}`);
  }
  for (let i = 0; i < bytes.byteLength; i++) {
    if (blob[i] !== bytes[i]) throw new Error(`artifact byte mismatch at index ${i}`);
  }
  console.log("[step] B has the artifact bytes (byte-perfect)");

  console.log("\n✅ federation tmux e2e PASS");
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ federation tmux e2e FAIL:", err);
    if (!KEEP) {
      console.log("\n[diag] dumping panes before cleanup");
      console.log(`\n--- pane 0 (A) ---\n${capturePane(`${SESSION}.0`)}`);
      console.log(`\n--- pane 1 (B) ---\n${capturePane(`${SESSION}.1`)}`);
    }
    cleanup();
    process.exit(1);
  });
