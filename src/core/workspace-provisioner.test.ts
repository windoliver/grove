/**
 * Tests for the workspace provisioner.
 *
 * Each test creates a real temporary git repository to exercise actual
 * git-worktree operations end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupSessionWorkspaces,
  provisionSessionWorkspaces,
  provisionWorkspace,
} from "./workspace-provisioner.js";

describe("WorkspaceProvisioner", () => {
  let repoDir: string;
  let baseDir: string;

  beforeEach(() => {
    // Create a bare clone with a seeded initial commit — matches the new
    // workspace-provisioner contract (worktrees are added from a bare clone).
    repoDir = mkdtempSync(join(tmpdir(), "grove-wp-bare-"));
    execSync("git -c init.defaultBranch=main init --bare", { cwd: repoDir, stdio: "pipe" });

    const scratch = mkdtempSync(join(tmpdir(), "grove-wp-scratch-"));
    execSync(`git clone "${repoDir}" "${scratch}"`, { stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: scratch, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: scratch, stdio: "pipe" });
    execSync("git commit --allow-empty -m 'init'", { cwd: scratch, stdio: "pipe" });
    execSync("git branch -M main", { cwd: scratch, stdio: "pipe" });
    execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
    rmSync(scratch, { recursive: true, force: true });

    baseDir = join(tmpdir(), `grove-wp-base-${Date.now()}`);
  });

  afterEach(() => {
    // Clean up worktrees before removing the repo
    try {
      const worktrees = execSync("git worktree list --porcelain", {
        cwd: repoDir,
        encoding: "utf-8",
      });
      for (const line of worktrees.split("\n")) {
        if (line.startsWith("worktree ")) {
          const path = line.replace("worktree ", "");
          if (path !== repoDir) {
            try {
              execSync(`git worktree remove "${path}" --force`, {
                cwd: repoDir,
                stdio: "pipe",
              });
            } catch {
              // already removed
            }
          }
        }
      }
    } catch {
      // repo may already be gone
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("provisionWorkspace creates a worktree with a clean git status", async () => {
    const sessionId = "abcdef1234567890";
    const result = await provisionWorkspace({
      role: "coder",
      sessionId,
      baseDir,
      bareClonePath: repoDir,
    });

    expect(result.role).toBe("coder");
    expect(result.sessionId).toBe(sessionId);
    expect(result.branch).toBe(`grove/${sessionId}/coder`);
    expect(existsSync(result.path)).toBe(true);

    // Verify the worktree has a clean git status
    const status = execSync("git status --porcelain", {
      cwd: result.path,
      encoding: "utf-8",
    });
    expect(status.trim()).toBe("");

    // Verify the branch exists
    const branches = execSync("git branch", {
      cwd: repoDir,
      encoding: "utf-8",
    });
    expect(branches).toContain(`grove/${sessionId}/coder`);
  });

  test("provisionWorkspace writes .mcp.json when mcpConfig is provided", async () => {
    const mcpConfig = {
      mcpServers: { grove: { command: "grove-mcp", args: ["--session", "s1"] } },
    };

    const result = await provisionWorkspace({
      role: "reviewer",
      sessionId: "sess00001111222233",
      baseDir,
      bareClonePath: repoDir,
      mcpConfig,
    });

    const mcpPath = join(result.path, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);

    const contents = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(contents).toEqual(mcpConfig);
  });

  test("provisionSessionWorkspaces creates multiple worktrees in parallel", async () => {
    const roles = ["architect", "coder", "reviewer"];
    const sessionId = "parallel-session-01";

    const session = await provisionSessionWorkspaces(roles, sessionId, baseDir, repoDir);

    expect(session.sessionId).toBe(sessionId);
    expect(session.workspaces).toHaveLength(3);
    expect(session.errors).toHaveLength(0);
    expect(session.durationMs).toBeGreaterThanOrEqual(0);

    // Verify each workspace exists and has the correct role
    const provisionedRoles = session.workspaces.map((ws) => ws.role).sort();
    expect(provisionedRoles).toEqual(["architect", "coder", "reviewer"]);

    for (const ws of session.workspaces) {
      expect(existsSync(ws.path)).toBe(true);
    }
  });

  test("provisionSessionWorkspaces handles errors gracefully", async () => {
    const session = await provisionSessionWorkspaces(
      ["good-role", "bad-role"],
      "err-session-01234567",
      baseDir,
      "/nonexistent/repo/path",
    );

    // All roles should fail since the repo path is invalid
    expect(session.workspaces).toHaveLength(0);
    expect(session.errors).toHaveLength(2);
    expect(session.errors[0]!.role).toBe("good-role");
    expect(session.errors[1]!.role).toBe("bad-role");
    expect(session.errors[0]!.message).toBeTruthy();
  });

  test("cleanupSessionWorkspaces removes worktrees and branches", async () => {
    const sessionId = "cleanup-session-01";
    const roles = ["dev", "qa"];

    // Provision first
    const workspaces = await Promise.all(
      roles.map((role) => provisionWorkspace({ role, sessionId, baseDir, bareClonePath: repoDir })),
    );

    // Verify they exist
    for (const ws of workspaces) {
      expect(existsSync(ws.path)).toBe(true);
    }

    // Clean up
    await cleanupSessionWorkspaces(workspaces, repoDir);

    // Verify worktree directories are gone
    for (const ws of workspaces) {
      expect(existsSync(ws.path)).toBe(false);
    }

    // Verify branches are deleted
    const branches = execSync("git branch", {
      cwd: repoDir,
      encoding: "utf-8",
    });
    for (const ws of workspaces) {
      expect(branches).not.toContain(ws.branch);
    }
  });

  test("worktree paths use role + sessionId prefix", async () => {
    const sessionId = "abcdef1234567890abcdef1234567890";

    const result = await provisionWorkspace({
      role: "planner",
      sessionId,
      baseDir,
      bareClonePath: repoDir,
    });

    // Path should be <baseDir>/<role>-<first 8 chars of sessionId>
    const expectedPath = join(baseDir, `planner-${sessionId.slice(0, 8)}`);
    expect(result.path).toBe(expectedPath);
  });

  test("provisionWorkspace respects baseBranch option", async () => {
    // Create a scratch clone to produce a second branch, then push it to the bare.
    const scratch = mkdtempSync(join(tmpdir(), "grove-wp-scratch2-"));
    execSync(`git clone "${repoDir}" "${scratch}"`, { stdio: "pipe" });
    execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
    execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
    execSync("git checkout -b feature-base", { cwd: scratch, stdio: "pipe" });
    execSync("git commit --allow-empty -m 'feature commit'", { cwd: scratch, stdio: "pipe" });
    execSync("git push origin feature-base", { cwd: scratch, stdio: "pipe" });
    rmSync(scratch, { recursive: true, force: true });

    const result = await provisionWorkspace({
      role: "tester",
      sessionId: "base-branch-session",
      baseDir,
      bareClonePath: repoDir,
      baseBranch: "feature-base",
    });

    expect(existsSync(result.path)).toBe(true);
    const log = execSync("git log --oneline", { cwd: result.path, encoding: "utf-8" });
    expect(log).toContain("feature commit");
  });

  test("provisionSessionWorkspaces records durationMs", async () => {
    const session = await provisionSessionWorkspaces(
      ["solo"],
      "timing-session-0123",
      baseDir,
      repoDir,
    );

    expect(typeof session.durationMs).toBe("number");
    expect(session.durationMs).toBeGreaterThanOrEqual(0);
  });
});
