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
    // Create a real git repo with an initial commit
    repoDir = mkdtempSync(join(tmpdir(), "grove-wp-test-"));
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync("git commit --allow-empty -m 'init'", {
      cwd: repoDir,
      stdio: "pipe",
    });
    baseDir = join(repoDir, ".grove", "workspaces");
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

  test("provisionWorkspace creates a worktree with a clean git status", () => {
    const sessionId = "abcdef1234567890";
    const result = provisionWorkspace({
      role: "coder",
      sessionId,
      baseDir,
      repoRoot: repoDir,
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

  test("provisionWorkspace writes .mcp.json when mcpConfig is provided", () => {
    const mcpConfig = {
      mcpServers: { grove: { command: "grove-mcp", args: ["--session", "s1"] } },
    };

    const result = provisionWorkspace({
      role: "reviewer",
      sessionId: "sess00001111222233",
      baseDir,
      repoRoot: repoDir,
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

    const session = await provisionSessionWorkspaces(
      roles,
      sessionId,
      baseDir,
      repoDir,
    );

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

  test("cleanupSessionWorkspaces removes worktrees and branches", () => {
    const sessionId = "cleanup-session-01";
    const roles = ["dev", "qa"];

    // Provision first
    const workspaces = roles.map((role) =>
      provisionWorkspace({ role, sessionId, baseDir, repoRoot: repoDir }),
    );

    // Verify they exist
    for (const ws of workspaces) {
      expect(existsSync(ws.path)).toBe(true);
    }

    // Clean up
    cleanupSessionWorkspaces(workspaces, repoDir);

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

  test("worktree paths use role + sessionId prefix", () => {
    const sessionId = "abcdef1234567890abcdef1234567890";

    const result = provisionWorkspace({
      role: "planner",
      sessionId,
      baseDir,
      repoRoot: repoDir,
    });

    // Path should be <baseDir>/<role>-<first 8 chars of sessionId>
    const expectedPath = join(baseDir, `planner-${sessionId.slice(0, 8)}`);
    expect(result.path).toBe(expectedPath);
  });

  test("provisionWorkspace respects baseBranch option", () => {
    // Create a new branch in the repo
    execSync("git checkout -b feature-base", { cwd: repoDir, stdio: "pipe" });
    execSync("git commit --allow-empty -m 'feature commit'", {
      cwd: repoDir,
      stdio: "pipe",
    });
    execSync("git checkout -", { cwd: repoDir, stdio: "pipe" });

    const result = provisionWorkspace({
      role: "tester",
      sessionId: "base-branch-session",
      baseDir,
      repoRoot: repoDir,
      baseBranch: "feature-base",
    });

    // The worktree should exist and its branch should be based on feature-base
    expect(existsSync(result.path)).toBe(true);

    // Verify the commit from feature-base is in the worktree history
    const log = execSync("git log --oneline", {
      cwd: result.path,
      encoding: "utf-8",
    });
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
