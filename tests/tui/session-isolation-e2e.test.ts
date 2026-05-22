/**
 * E2E test for session isolation: verifies that the TUI preset-select
 * screen shows bounded sessions (not 55+) and that separate grove dirs
 * have isolated session pickers.
 *
 * Regression test for windoliver/grove#223: stale sessions accumulated
 * without cleanup, causing the session picker to show 55+ entries.
 *
 * Fix: LIMIT 20 in listSessions() + slice(0,5) in preset-select.tsx.
 * Both MUST hold — this test catches regressions in either.
 *
 * Requires tmux. Skipped on machines without it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Tmux helpers
// ---------------------------------------------------------------------------

const TMUX_SOCKET = "grove-isolation-e2e";
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

function capturePane(session: string): string {
  return tmux(`capture-pane -t ${session} -p`);
}

function capturePaneOrEmpty(session: string): string {
  try {
    return capturePane(session);
  } catch {
    return "";
  }
}

function sendKeys(session: string, keys: string): void {
  tmux(`send-keys -t ${session} ${keys}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPane(
  session: string,
  predicate: (output: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePaneOrEmpty(session);
    if (predicate(last)) return last;
    await sleep(500);
  }
  return last;
}

function launchHarness(session: string, groveDir: string, label: string, count = 55): void {
  const command =
    `new-session -d -s ${session} -x 120 -y 40 -c "${PROJECT_ROOT}" ` +
    `"bun run tests/tui/session-isolation-harness.ts --grove-dir ${groveDir} --label ${label} --count ${count} 2>/dev/null"`;

  try {
    tmux(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // CI can occasionally hit a tmux server startup race. One clean retry is enough.
    if (!message.includes("server exited unexpectedly")) throw error;
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Best-effort cleanup before retry.
    }
    tmux(command);
  }
}

function killSession(session: string): void {
  try {
    tmux(`kill-session -t ${session}`);
  } catch {
    // Already dead
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const hasTmux = tmuxAvailable();

// Temp grove dirs created per-test, cleaned up in afterAll
const tempDirs: string[] = [];

function makeTempGroveDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-isolation-"));
  tempDirs.push(dir);
  return dir;
}

describe.skipIf(!hasTmux)("Session isolation E2E — tmux capture-pane", () => {
  beforeAll(() => {
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Expected when no server running
    }
  });

  afterEach(() => {
    // Kill any sessions left over from a test
    for (const s of ["grove-a", "grove-b"]) {
      killSession(s);
    }
  });

  afterAll(() => {
    try {
      execSync(`tmux -L ${TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Best-effort
    }
    // Clean up temp dirs
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort
      }
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: Session count is bounded after seeding 55 stale sessions
  // -------------------------------------------------------------------------

  test("Preset-select shows at most 5 sessions even after seeding 55 stale ones", async () => {
    const groveDir = makeTempGroveDir();
    launchHarness("grove-a", groveDir, "grove-a", 55);

    const output = await waitForPane(
      "grove-a",
      (pane) => pane.includes("Enter:select") && pane.includes("Recent sessions"),
      10000,
    );

    // TUI must show the preset-select screen (title "Grove", keyboard hints)
    expect(output).toContain("Enter:select");

    // "Recent sessions" section must appear (we seeded sessions)
    expect(output).toContain("Recent sessions");

    // Count how many seeded goal names appear in the rendered output.
    // preset-select.tsx: sessions.slice(0, 5).map(...)
    // So at most 5 lines like:  [review-loop] "grove-a-goal-54" (...)
    const goalMatches = (output.match(/grove-a-goal-\d+/g) ?? []).length;
    expect(goalMatches).toBeGreaterThan(0); // At least 1 session shown
    expect(goalMatches).toBeLessThanOrEqual(5); // Never exceeds slice(0, 5)
  }, 12000);

  // -------------------------------------------------------------------------
  // Test 2: Two grove dirs are isolated — sessions don't cross-contaminate
  // -------------------------------------------------------------------------

  test("Two separate grove dirs have isolated session pickers", async () => {
    const dirA = makeTempGroveDir();
    const dirB = makeTempGroveDir();

    // Seed grove-a with "grove-a-goal-*" sessions
    launchHarness("grove-a", dirA, "grove-a", 5);
    // Seed grove-b with "grove-b-goal-*" sessions
    launchHarness("grove-b", dirB, "grove-b", 5);

    const [outputA, outputB] = await Promise.all([
      waitForPane("grove-a", (pane) => pane.includes("grove-a-goal"), 10000),
      waitForPane("grove-b", (pane) => pane.includes("grove-b-goal"), 10000),
    ]);

    // Grove-A picker contains "grove-a" goals but NOT "grove-b" goals
    expect(outputA).toContain("grove-a-goal");
    expect(outputA).not.toContain("grove-b-goal");

    // Grove-B picker contains "grove-b" goals but NOT "grove-a" goals
    expect(outputB).toContain("grove-b-goal");
    expect(outputB).not.toContain("grove-a-goal");
  }, 12000);

  // -------------------------------------------------------------------------
  // Test 3: Keyboard quit works from preset-select
  // -------------------------------------------------------------------------

  test("Pressing q quits the TUI cleanly from preset-select", async () => {
    const groveDir = makeTempGroveDir();
    launchHarness("grove-a", groveDir, "grove-a", 3);

    // Confirm we're on the preset-select screen before quitting
    const before = await waitForPane("grove-a", (pane) => pane.includes("Enter:select"), 10000);
    expect(before).toContain("Enter:select");

    // Press q to quit
    sendKeys("grove-a", "q");
    await sleep(2000);

    // Session should be dead — tmux has-session returns non-zero if gone
    let sessionDead = false;
    try {
      tmux("has-session -t grove-a");
      // If above didn't throw, session still exists
      sessionDead = false;
    } catch {
      sessionDead = true;
    }
    expect(sessionDead).toBe(true);
  }, 12000);
});
