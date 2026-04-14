/**
 * E2E test for edge-type-aware workspace provisioning in the TUI.
 *
 * Verifies that the spawn-progress screen shows the correct workspace mode
 * based on the topology edge type between roles.
 *
 *   Scenario 1: delegates + real git repo
 *     → both agents "started", no degraded badge (isolated_worktree)
 *
 *   Scenario 2: feedback + real git repo
 *     → both agents "started", no degraded badge (independent isolated_worktrees)
 *
 *   Scenario 3: delegates + no git dir
 *     → both agents "started [shared workspace]" (fallback_workspace)
 *
 * Requires tmux. Skipped on machines without it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Tmux helpers
// ---------------------------------------------------------------------------

const TMUX_SOCKET = "grove-edge-e2e";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const HARNESS = join(import.meta.dir, "edge-workspace-harness.tsx");

function tmuxAvailable(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tmux(args: string): string {
  return execSync(`tmux -L ${TMUX_SOCKET} ${args}`, { encoding: "utf-8", timeout: 10_000 }).trim();
}

function capturePane(session: string): string {
  return tmux(`capture-pane -t ${session} -p`);
}

function launchHarness(session: string, extraArgs = ""): void {
  tmux(
    `new-session -d -s ${session} -x 140 -y 40 -c "${PROJECT_ROOT}" ` +
      `"bun run ${HARNESS} ${extraArgs} 2>/tmp/edge-e2e-stderr.log"`,
  );
}

function killSession(session: string): void {
  try {
    tmux(`kill-session -t ${session}`);
  } catch {
    /* already dead */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForResolved(session: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = capturePane(session);
    if (output.includes("started") || output.includes("failed")) {
      await sleep(800);
      return capturePane(session);
    }
    await sleep(500);
  }
  return capturePane(session);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const hasTmux = tmuxAvailable();

describe.skipIf(!hasTmux)("Edge-type workspace E2E — tmux capture-pane", () => {
  beforeAll(() => {
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      /* ok */
    }
  });

  afterEach(() => {
    killSession("grove-edge-test");
  });

  afterAll(() => {
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      /* ok */
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 1: delegates + real git repo → isolated worktrees, no badge
  // -------------------------------------------------------------------------

  test("delegates + real git: both agents started with isolated worktrees", async () => {
    launchHarness("grove-edge-test", "--edge-type delegates --use-git-repo");

    // Allow time for 2 sequential git worktree provisions
    const output = await waitForResolved("grove-edge-test", 25_000);

    expect(output).toContain("Starting session");
    expect(output).toContain("started");

    // No degraded badge — both worktrees provisioned cleanly
    expect(output).not.toContain("[shared workspace]");
    expect(output).not.toContain("[no config]");
    expect(output).not.toContain("failed:");
  }, 35_000);

  // -------------------------------------------------------------------------
  // Scenario 2: feedback + real git repo → independent isolated worktrees
  // -------------------------------------------------------------------------

  test("feedback + real git: both agents started with independent worktrees", async () => {
    launchHarness("grove-edge-test", "--edge-type feedback --use-git-repo");

    const output = await waitForResolved("grove-edge-test", 25_000);

    expect(output).toContain("Starting session");
    expect(output).toContain("started");

    // Independent worktrees — no badge
    expect(output).not.toContain("[shared workspace]");
    expect(output).not.toContain("failed:");
  }, 35_000);

  // -------------------------------------------------------------------------
  // Scenario 3: delegates + no git → fallback mode, badge visible
  // -------------------------------------------------------------------------

  test("delegates + no git: both agents show [shared workspace] badge", async () => {
    launchHarness("grove-edge-test", "--edge-type delegates");

    const output = await waitForResolved("grove-edge-test", 15_000);

    expect(output).toContain("Starting session");
    expect(output).toContain("started");

    // Fallback badge visible — operator sees the degradation
    expect(output).toContain("[shared workspace]");
    // Reason hint visible (git error starts with "Command failed:")
    expect(output).toContain("Command failed:");
  }, 20_000);
});
