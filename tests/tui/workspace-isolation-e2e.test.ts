/**
 * E2E test for workspace isolation — verifies that workspace provisioning
 * policy enforcement is visible in the TUI spawn-progress screen.
 *
 * Regression test for windoliver/grove#208: workspace provisioning failures
 * were silently swallowed, causing agents to share the project root.
 *
 * Fix: WorkspaceIsolationPolicy + WorkspaceMode tagged union.
 *   strict    → spawn throws  → agent shows "failed: Workspace provisioning failed"
 *   fallback  → degrades       → agent shows "started" (fallback_workspace mode)
 *
 * Requires tmux. Skipped on machines without it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Tmux helpers
// ---------------------------------------------------------------------------

const TMUX_SOCKET = "grove-ws-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const HARNESS = join(import.meta.dir, "workspace-isolation-harness.tsx");

function tmuxAvailable(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tmux(args: string): string {
  return execSync(`tmux -L ${TMUX_SOCKET} ${args}`, {
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();
}

function capturePane(session: string): string {
  return tmux(`capture-pane -t ${session} -p`);
}

function launchHarness(session: string, extraArgs = ""): void {
  tmux(
    `new-session -d -s ${session} -x 140 -y 40 -c "${PROJECT_ROOT}" ` +
      `"bun run ${HARNESS} ${extraArgs} 2>/tmp/ws-e2e-stderr.log"`,
  );
}

function killSession(session: string): void {
  try {
    tmux(`kill-session -t ${session}`);
  } catch {
    // Already dead
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll capture-pane until the harness writes "HARNESS_RESOLVED" to stdout
 * (meaning all agents resolved) or timeout expires.
 */
async function waitForResolved(session: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = capturePane(session);
    if (output.includes("HARNESS_RESOLVED") || output.includes("started") || output.includes("failed")) {
      // Give one extra render tick to ensure final state is painted
      await sleep(800);
      return capturePane(session);
    }
    await sleep(500);
  }
  return capturePane(session);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const hasTmux = tmuxAvailable();

describe.skipIf(!hasTmux)("Workspace isolation E2E — tmux capture-pane", () => {
  beforeAll(() => {
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Expected when no server running
    }
  });

  afterEach(() => {
    killSession("grove-ws-test");
  });

  afterAll(() => {
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Best-effort
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: allow-fallback + non-git dir → agents start (fallback_workspace)
  // -------------------------------------------------------------------------

  test(
    "allow-fallback + non-git dir: both agents show started",
    async () => {
      launchHarness("grove-ws-test", "--policy allow-fallback");

      // Poll until harness resolves (fallback path ~2-4s)
      const output = await waitForResolved("grove-ws-test", 15_000);

      // Screen must be visible
      expect(output).toContain("Starting session");

      // Both agents should reach "started" — fallback_workspace mode continues
      expect(output).toContain("started");

      // Degraded badge must be visible — operator sees the workspace degradation
      expect(output).toContain("[shared workspace]");

      // Reason hint must be shown inline
      expect(output).toContain("Command failed:");
    },
    20_000,
  );

  // -------------------------------------------------------------------------
  // Test 2: strict + non-git dir → agents show "failed: Workspace provisioning failed"
  // -------------------------------------------------------------------------

  test(
    "strict + non-git dir: both agents show failed with provisioning error",
    async () => {
      launchHarness("grove-ws-test", "--policy strict");

      // Poll until spawns reject (git error ~1-2s)
      const output = await waitForResolved("grove-ws-test", 10_000);

      expect(output).toContain("Starting session");

      // Both agents should fail
      expect(output).toContain("failed");

      // Error message must mention provisioning
      expect(output).toContain("Workspace provisioning failed");

      // No agent should have started
      expect(output).not.toContain("● coder");
      expect(output).not.toContain("● reviewer");
    },
    15_000,
  );

  // -------------------------------------------------------------------------
  // Test 3: allow-fallback + real git repo → agents start (isolated_worktree)
  // -------------------------------------------------------------------------

  test(
    "allow-fallback + real git repo: both agents show started (isolated worktree)",
    async () => {
      launchHarness("grove-ws-test", "--policy allow-fallback --use-git-repo");

      // Git worktree creation takes longer — poll up to 20s
      const output = await waitForResolved("grove-ws-test", 20_000);

      expect(output).toContain("Starting session");

      // Both agents should reach "started" — real worktree provisioned
      expect(output).toContain("started");

      // No degraded badge — this is the happy path
      expect(output).not.toContain("[shared workspace]");
      expect(output).not.toContain("[no config]");

      // No agent status failure
      expect(output).not.toContain("failed:");
    },
    25_000,
  );
});
