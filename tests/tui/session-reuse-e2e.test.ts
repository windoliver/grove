/**
 * E2E test for session reuse flow using tmux capture-pane.
 *
 * Renders ScreenManager starting on the COMPLETE screen (Screen 5) with
 * preset/roleMapping state preserved. Verifies that pressing Enter skips
 * to goal-input (Screen 3) — NOT back to preset-select (Screen 1).
 *
 * This is the core behavioral change from #141: session reuse preserves
 * preset + detection state and skips directly to goal input.
 *
 * Requires tmux to be installed. Skipped otherwise.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Tmux helpers
// ---------------------------------------------------------------------------

const TMUX_SOCKET = "grove-reuse-e2e";
const SESSION = "reuse-test";
const PROJECT_ROOT = join(import.meta.dir, "..", "..");

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
    timeout: 10000,
  }).trim();
}

function capturePane(): string {
  return tmux(`capture-pane -t ${SESSION} -p`);
}

function capturePaneOrEmpty(): string {
  try {
    return capturePane();
  } catch {
    return "";
  }
}

function sendKeys(keys: string): void {
  tmux(`send-keys -t ${SESSION} ${keys}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPane(
  predicate: (output: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePaneOrEmpty();
    if (predicate(last)) return last;
    await sleep(500);
  }
  return last;
}

function launchHarness(): void {
  tmux(
    `new-session -d -s ${SESSION} -x 120 -y 40 -c "${PROJECT_ROOT}" "bun run tests/tui/reuse-harness.tsx 2>/dev/null"`,
  );
}

function killSession(): void {
  try {
    tmux(`kill-session -t ${SESSION}`);
  } catch {
    // Already dead
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const hasTmux = tmuxAvailable();

describe.skipIf(!hasTmux)("Session reuse E2E — tmux capture-pane", () => {
  beforeAll(() => {
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Expected
    }
  });

  afterEach(() => {
    killSession();
  });

  afterAll(() => {
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Best-effort
    }
  });

  test("Starts on complete screen (Screen 5) with session stats", async () => {
    launchHarness();

    const output = await waitForPane((pane) => pane.includes("Session Complete"), 8000);
    expect(output).toContain("Session Complete");
    expect(output).toContain("signaled done");
    expect(output).toContain("7"); // 7 contributions
    expect(output).toContain("review-loop");
    expect(output).toContain("Enter:new session");
  }, 10000);

  test("Enter on complete → goal-input (NOT preset-select) — session reuse", async () => {
    launchHarness();

    // Verify we're on complete screen
    const before = await waitForPane((pane) => pane.includes("Session Complete"), 8000);
    expect(before).toContain("Session Complete");

    // Press Enter — should reuse preset and skip to goal-input
    sendKeys("Enter");

    const after = await waitForPane(
      (pane) => !pane.includes("Session Complete") && pane.toLowerCase().includes("goal"),
      8000,
    );
    // Should be on goal-input (Screen 3), NOT preset-select (Screen 1)
    expect(after).not.toContain("Session Complete"); // Left the complete screen
    expect(after).not.toContain("Pick a preset"); // Did NOT go to preset-select
    expect(after.toLowerCase()).toContain("goal"); // Landed on goal-input
  }, 10000);

  test("Goal-input after reuse shows agent spawn preview with preserved roles", async () => {
    launchHarness();
    await waitForPane((pane) => pane.includes("Session Complete"), 8000);

    // Navigate: complete → goal-input via Enter
    sendKeys("Enter");

    const output = await waitForPane((pane) => pane.includes("agents will be configured"), 8000);
    // Goal-input should show the spawn preview with the preserved role mapping
    expect(output).toContain("coder");
    expect(output).toContain("reviewer");
    expect(output).toContain("agents will be configured");
  }, 10000);
});
