/**
 * Real E2E test: AcpxRuntime + provisioned worktrees + delegates edge.
 *
 * Proves:
 *   1. acpx agent actually starts in the provisioned worktree (not project root)
 *   2. Coder's worktree is based on HEAD
 *   3. Reviewer's worktree is based on coder's branch (delegates edge)
 *   4. After coder commits, reviewer sees the commit
 *
 * Usage:
 *   bun run tests/tui/acpx-worktree-e2e.ts --repo /tmp/grove-acpx-e2e-XXXXX
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { AcpxRuntime } from "../../src/core/acpx-runtime.js";
import { provisionWorkspace } from "../../src/core/workspace-provisioner.js";
import { resolveRoleWorkspaceStrategies } from "../../src/core/topology.js";
import type { AgentTopology } from "../../src/core/topology.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { repo: { type: "string" } },
  strict: false,
});
const repoRoot = values.repo as string;
if (!repoRoot || !existsSync(repoRoot)) {
  console.error("--repo is required and must exist");
  process.exit(1);
}

const SESSION_ID = `acpx-e2e-${Date.now().toString(36)}`;
const baseDir = join(repoRoot, ".grove", "workspaces");

// Topology: coder → reviewer (delegates)
const topology: AgentTopology = {
  structure: "graph",
  roles: [
    { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" }] },
    { name: "reviewer" },
  ],
};

const strategies = resolveRoleWorkspaceStrategies(topology, SESSION_ID);

// ---------------------------------------------------------------------------
// Test functions
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Step 1: Provision coder worktree (base: HEAD)
// ---------------------------------------------------------------------------

console.log("\n=== Step 1: Provision coder worktree (base: HEAD) ===");
const coderBaseBranch = strategies.get("coder")!;
assert(coderBaseBranch === "HEAD", `coder baseBranch = ${coderBaseBranch}`);

const coderWs = await provisionWorkspace({
  role: "coder",
  sessionId: SESSION_ID,
  baseDir,
  repoRoot,
  baseBranch: coderBaseBranch,
});
console.log(`  coder worktree: ${coderWs.path}`);
console.log(`  coder branch:   ${coderWs.branch}`);
assert(existsSync(coderWs.path), "coder worktree exists on disk");
assert(existsSync(join(coderWs.path, "README.md")), "coder sees README.md from HEAD");

// ---------------------------------------------------------------------------
// Step 2: Spawn coder via AcpxRuntime in the worktree
// ---------------------------------------------------------------------------

console.log("\n=== Step 2: Spawn coder agent (acpx codex) in worktree ===");
const runtime = new AcpxRuntime({ agent: "codex", logDir: join(repoRoot, ".grove", "logs") });
const available = await runtime.isAvailable();
assert(available, "acpx is available");

const coderSession = await runtime.spawn("coder", {
  role: "coder",
  command: "codex",
  cwd: coderWs.path,
  goal: "Create a file called proof-coder.txt with the content 'coder was here'. Then stop.",
  env: { GROVE_SESSION_ID: SESSION_ID, GROVE_ROLE: "coder" },
});
console.log(`  acpx session: ${coderSession.id}`);
console.log(`  status:       ${coderSession.status}`);
assert(coderSession.id.startsWith("grove-coder-"), `session name starts with grove-coder-`);

// Verify via acpx sessions list
const sessionList = execSync("acpx codex sessions list", { encoding: "utf-8", cwd: coderWs.path });
assert(sessionList.includes(coderSession.id), `acpx sessions list includes ${coderSession.id}`);

// Wait for agent to finish (poll for proof-coder.txt, max 60s)
console.log("  Waiting for coder agent to create proof-coder.txt...");
const coderDeadline = Date.now() + 60_000;
while (Date.now() < coderDeadline) {
  if (existsSync(join(coderWs.path, "proof-coder.txt"))) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const coderProofExists = existsSync(join(coderWs.path, "proof-coder.txt"));
assert(coderProofExists, "proof-coder.txt created in coder worktree");
if (coderProofExists) {
  const content = readFileSync(join(coderWs.path, "proof-coder.txt"), "utf-8");
  console.log(`  proof-coder.txt content: "${content.trim()}"`);
  assert(content.includes("coder"), "proof-coder.txt mentions coder");
}

// Commit coder's work
if (coderProofExists) {
  execSync("git add -A && git -c user.email=test@grove.test -c user.name=Grove-E2E commit -m 'coder: add proof' --quiet", {
    cwd: coderWs.path,
    stdio: "ignore",
  });
  console.log("  Committed coder's work to branch");
}

// Close coder session
await runtime.close(coderSession);
console.log("  Closed coder acpx session");

// ---------------------------------------------------------------------------
// Step 3: Provision reviewer worktree (base: coder's branch — delegates)
// ---------------------------------------------------------------------------

console.log("\n=== Step 3: Provision reviewer worktree (base: coder's branch) ===");
const reviewerBaseBranch = strategies.get("reviewer")!;
console.log(`  reviewer baseBranch: ${reviewerBaseBranch}`);
assert(reviewerBaseBranch.includes("/coder"), `reviewer branches off coder: ${reviewerBaseBranch}`);

const reviewerWs = await provisionWorkspace({
  role: "reviewer",
  sessionId: SESSION_ID,
  baseDir,
  repoRoot,
  baseBranch: reviewerBaseBranch,
});
console.log(`  reviewer worktree: ${reviewerWs.path}`);
console.log(`  reviewer branch:   ${reviewerWs.branch}`);
assert(existsSync(reviewerWs.path), "reviewer worktree exists on disk");

// Key proof: reviewer sees coder's committed file
const reviewerSeesProof = existsSync(join(reviewerWs.path, "proof-coder.txt"));
assert(reviewerSeesProof, "reviewer worktree contains proof-coder.txt from coder's branch");
if (reviewerSeesProof) {
  const content = readFileSync(join(reviewerWs.path, "proof-coder.txt"), "utf-8");
  console.log(`  reviewer reads proof-coder.txt: "${content.trim()}"`);
}

// Verify git log in reviewer worktree shows coder's commit
const reviewerLog = execSync("git log --oneline", { cwd: reviewerWs.path, encoding: "utf-8" });
console.log(`  reviewer git log:\n${reviewerLog.split("\n").map(l => `    ${l}`).join("\n")}`);
assert(reviewerLog.includes("coder: add proof"), "reviewer git log shows coder's commit");

// ---------------------------------------------------------------------------
// Step 4: Spawn reviewer agent in reviewer worktree
// ---------------------------------------------------------------------------

console.log("\n=== Step 4: Spawn reviewer agent (acpx codex) in reviewer worktree ===");
const reviewerSession = await runtime.spawn("reviewer", {
  role: "reviewer",
  command: "codex",
  cwd: reviewerWs.path,
  goal: "Read proof-coder.txt and create a file called review-result.txt with 'reviewed: ' followed by the content of proof-coder.txt. Then stop.",
  env: { GROVE_SESSION_ID: SESSION_ID, GROVE_ROLE: "reviewer" },
});
console.log(`  acpx session: ${reviewerSession.id}`);
assert(reviewerSession.id.startsWith("grove-reviewer-"), `session name starts with grove-reviewer-`);

// Wait for reviewer to finish
console.log("  Waiting for reviewer agent to create review-result.txt...");
const reviewerDeadline = Date.now() + 60_000;
while (Date.now() < reviewerDeadline) {
  if (existsSync(join(reviewerWs.path, "review-result.txt"))) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const reviewResultExists = existsSync(join(reviewerWs.path, "review-result.txt"));
assert(reviewResultExists, "review-result.txt created in reviewer worktree");
if (reviewResultExists) {
  const content = readFileSync(join(reviewerWs.path, "review-result.txt"), "utf-8");
  console.log(`  review-result.txt content: "${content.trim()}"`);
  assert(content.includes("coder"), "review-result.txt references coder's work");
}

// Close reviewer session
await runtime.close(reviewerSession);
console.log("  Closed reviewer acpx session");

// ---------------------------------------------------------------------------
// Step 5: Show final state
// ---------------------------------------------------------------------------

console.log("\n=== Final state ===");
console.log("  Worktree list:");
const wtList = execSync("git worktree list", { cwd: repoRoot, encoding: "utf-8" });
for (const line of wtList.trim().split("\n")) {
  console.log(`    ${line}`);
}
console.log("\n  Coder worktree files:");
const coderFiles = execSync("ls -la", { cwd: coderWs.path, encoding: "utf-8" });
for (const line of coderFiles.trim().split("\n")) {
  console.log(`    ${line}`);
}
console.log("\n  Reviewer worktree files:");
const reviewerFiles = execSync("ls -la", { cwd: reviewerWs.path, encoding: "utf-8" });
for (const line of reviewerFiles.trim().split("\n")) {
  console.log(`    ${line}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
