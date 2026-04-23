/**
 * End-to-end flow for the bare-clone repo cache:
 *   resolveRepo(RepoRef) → provisionWorkspace(bareClonePath) → agent commits → pushes back to bare.
 *
 * Uses a `file://` fixture bare repo to avoid any real network.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepo } from "../../src/core/repo-cache.js";
import { provisionWorkspace } from "../../src/core/workspace-provisioner.js";

let fixture: string;
let cacheRoot: string;
let groveDir: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "grove-e2e-fx-"));
  execSync("git -c init.defaultBranch=main init --bare", { cwd: fixture, stdio: "pipe" });
  const scratch = mkdtempSync(join(tmpdir(), "grove-e2e-scratch-"));
  execSync(`git clone "${fixture}" "${scratch}"`, { stdio: "pipe" });
  execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
  execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: scratch, stdio: "pipe" });
  execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
  rmSync(scratch, { recursive: true, force: true });

  cacheRoot = mkdtempSync(join(tmpdir(), "grove-e2e-cache-"));
  groveDir = mkdtempSync(join(tmpdir(), "grove-e2e-dir-"));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(cacheRoot, { recursive: true, force: true });
  rmSync(groveDir, { recursive: true, force: true });
});

test("resolve → provision → commit → push flow against a bare-clone fixture", async () => {
  const resolved = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
  expect(resolved.fetched).toBe(true);
  expect(resolved.bareClonePath.startsWith(cacheRoot)).toBe(true);

  const ws = await provisionWorkspace({
    role: "coder",
    sessionId: "e2esess00000000",
    baseDir: join(groveDir, "workspaces"),
    bareClonePath: resolved.bareClonePath,
  });

  // Agent edits, commits, and pushes back to the bare clone.
  execSync(`bash -c 'echo hello > ${ws.path}/hello.txt'`, { stdio: "pipe" });
  execSync('git config user.email "agent@t"', { cwd: ws.path, stdio: "pipe" });
  execSync('git config user.name "agent"', { cwd: ws.path, stdio: "pipe" });
  execSync("git add hello.txt && git commit -m 'add hello'", { cwd: ws.path, stdio: "pipe" });
  execSync(`git push origin ${ws.branch}`, { cwd: ws.path, stdio: "pipe" });

  // Branch landed in the bare clone.
  const branches = execSync(`git -C "${resolved.bareClonePath}" branch`, { encoding: "utf-8" });
  expect(branches).toContain(ws.branch);
  expect(existsSync(join(ws.path, "hello.txt"))).toBe(true);
});
