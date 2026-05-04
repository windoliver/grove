/**
 * Tests for `startCleanupScheduler` (#391 / A8.5 PR5).
 *
 * Uses real (short) timers instead of fake-timer APIs because bun:test does
 * not ship vitest's `advanceTimersByTimeAsync`.
 */

import { describe, expect, mock, test } from "bun:test";
import { startCleanupScheduler } from "./cleanup-scheduler.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRuntime() {
  return {
    claimStore: {} as unknown,
    contributionStore: {} as unknown,
    cas: {} as unknown,
    goalSessionStore: {} as unknown,
  };
}

describe("startCleanupScheduler", () => {
  test("runs claim cleanup on its interval and stops on close", async () => {
    const runCleanup = mock(() => Promise.resolve({ expiredClaims: 0, cleanedClaims: 0 }));
    const runArtifactGc = mock(() => Promise.resolve({ deletedBlobs: 0 }));
    const runSessionGc = mock(() => ({ archivedSessions: 0 }));

    const stop = startCleanupScheduler({
      runtime: makeRuntime() as never,
      claimIntervalMs: 30,
      blobGcIntervalMs: 90,
      sessionGcIntervalMs: 1_000_000, // never fires from interval during test
      onLog: () => undefined,
      runners: { runCleanup, runArtifactGc, runSessionGc },
    });

    // Eager session GC fired once on start.
    expect(runSessionGc.mock.calls.length).toBe(1);

    // Wait long enough for claim timer to fire at least once but blob timer not yet.
    await sleep(50);
    expect(runCleanup.mock.calls.length).toBeGreaterThanOrEqual(1);
    const claimAfterFirst = runCleanup.mock.calls.length;

    // Wait long enough for the blob/artifact timer to fire at least once.
    await sleep(80);
    expect(runArtifactGc.mock.calls.length).toBeGreaterThanOrEqual(1);

    stop();
    const claimAtStop = runCleanup.mock.calls.length;
    expect(claimAtStop).toBeGreaterThanOrEqual(claimAfterFirst);

    // No further calls after stop.
    await sleep(80);
    expect(runCleanup.mock.calls.length).toBe(claimAtStop);
  });

  test("swallows runner errors", async () => {
    const runCleanup = mock(() => Promise.reject(new Error("boom")));
    const runArtifactGc = mock(() => Promise.resolve({ deletedBlobs: 0 }));
    const runSessionGc = mock(() => ({ archivedSessions: 0 }));

    const stop = startCleanupScheduler({
      runtime: makeRuntime() as never,
      claimIntervalMs: 20,
      blobGcIntervalMs: 1_000_000,
      sessionGcIntervalMs: 1_000_000,
      onLog: () => undefined,
      runners: { runCleanup, runArtifactGc, runSessionGc },
    });

    await sleep(60);
    stop();
    expect(runCleanup.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
