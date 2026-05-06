/**
 * Periodic local-store maintenance. Lifted out of src/tui/main.ts so the
 * acceptance grep `grep -r setInterval src/tui` returns zero (#391 / A8.5 PR5).
 */
import type { ClaimStore } from "../core/store.js";
import {
  runArtifactGc as defaultRunArtifactGc,
  runCleanup as defaultRunCleanup,
  runSessionGc as defaultRunSessionGc,
} from "./cleanup.js";
import type { FsCas } from "./fs-cas.js";
import type { GoalSessionStore } from "./sqlite-goal-session-store.js";
import type { SqliteContributionStore } from "./sqlite-store.js";

export interface CleanupRuntime {
  readonly claimStore: ClaimStore;
  readonly contributionStore: SqliteContributionStore;
  readonly cas: FsCas;
  readonly goalSessionStore: GoalSessionStore;
}

export interface CleanupSchedulerOptions {
  readonly runtime: CleanupRuntime;
  readonly claimIntervalMs?: number;
  readonly blobGcIntervalMs?: number;
  readonly sessionGcIntervalMs?: number;
  readonly onLog?: (line: string) => void;
  readonly runners?: {
    runCleanup?: typeof defaultRunCleanup;
    runArtifactGc?: typeof defaultRunArtifactGc;
    runSessionGc?: typeof defaultRunSessionGc;
  };
}

/**
 * Start the periodic cleanup scheduler. Returns a stop callback that clears
 * all underlying timers. Runner errors are swallowed (non-fatal) — callers
 * who need visibility should use the `onLog` hook.
 *
 * The session GC runs once eagerly on start so the session picker is clean
 * immediately, then on its interval thereafter (matches prior TUI behavior).
 */
export function startCleanupScheduler(opts: CleanupSchedulerOptions): () => void {
  const claimMs = opts.claimIntervalMs ?? 60_000;
  const blobMs = opts.blobGcIntervalMs ?? 10 * 60_000;
  const sessionMs = opts.sessionGcIntervalMs ?? 5 * 60_000;
  const log = opts.onLog ?? (() => undefined);
  const runCleanup = opts.runners?.runCleanup ?? defaultRunCleanup;
  const runArtifactGc = opts.runners?.runArtifactGc ?? defaultRunArtifactGc;
  const runSessionGc = opts.runners?.runSessionGc ?? defaultRunSessionGc;

  const claimTimer = setInterval(async () => {
    try {
      const result = await runCleanup({ claimStore: opts.runtime.claimStore });
      if (result.expiredClaims > 0 || result.cleanedClaims > 0) {
        log(
          `expired ${result.expiredClaims} stale claim(s), cleaned ${result.cleanedClaims} old claim(s)`,
        );
      }
    } catch {
      // non-fatal
    }
  }, claimMs);

  const gcTimer = setInterval(async () => {
    try {
      const result = await runArtifactGc({
        contributionStore: opts.runtime.contributionStore,
        cas: opts.runtime.cas,
      });
      if (result.deletedBlobs > 0) {
        log(`garbage-collected ${result.deletedBlobs} unreferenced blob(s)`);
      }
    } catch {
      // non-fatal
    }
  }, blobMs);

  const runSessionGcOnce = (): void => {
    try {
      const result = runSessionGc({ goalSessionStore: opts.runtime.goalSessionStore });
      if (result.archivedSessions > 0) {
        log(`archived ${result.archivedSessions} stale session(s)`);
      }
    } catch {
      // non-fatal
    }
  };
  runSessionGcOnce();
  const sessionTimer = setInterval(runSessionGcOnce, sessionMs);

  return () => {
    clearInterval(claimTimer);
    clearInterval(gcTimer);
    clearInterval(sessionTimer);
  };
}
