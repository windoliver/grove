/**
 * Producer-side `github.pr.changed` publisher (#390 / A8.4).
 *
 * Polls a `getActivePR()` fetcher at the producer level (out of `src/tui/`)
 * and publishes a coarse `github.pr.changed` event whenever the resolved
 * PR number, state, head SHA, or check status mutates. The TUI github-panel
 * subscribes through the global RefreshContext fan-out — replacing its own
 * `usePolledData` interval timer.
 *
 * Lives outside `src/tui/` so the A8 acceptance grep stays clean. The
 * polling cadence here can be much slower than the previous TUI poll
 * (default 60 s) because the publisher is the only consumer of the
 * upstream API, not every render.
 *
 * Real production deployments should replace this with a webhook ingest;
 * the contract at the bus boundary (`github.pr.changed` event keyed to
 * TUI_REFRESH_ROLE) is identical either way.
 */

import { type EventBus, type GroveEvent, TUI_REFRESH_ROLE } from "../core/event-bus.js";

/** Snapshot fields used to detect change. Anything semantically observable. */
export interface PrSnapshot {
  readonly number: number;
  readonly state: string;
  readonly headSha?: string | undefined;
  readonly checksStatus?: string | undefined;
  readonly reviewStatus?: string | undefined;
}

/** Options for `startGitHubPrPublisher`. */
export interface GitHubPrPublisherOptions {
  readonly eventBus: EventBus;
  /** Returns the current active PR snapshot, or `undefined` when none. */
  readonly getActivePR: () => Promise<PrSnapshot | undefined>;
  /** Poll interval in ms. Default: 60_000 (60 s). */
  readonly pollMs?: number;
  /** Source role label used on the published event. Default: `"github"`. */
  readonly sourceRole?: string;
}

/** Handle returned by the publisher; call `stop()` to detach. */
export interface GitHubPrPublisherHandle {
  readonly stop: () => void;
}

function snapshotKey(s: PrSnapshot | undefined): string {
  if (!s) return "none";
  return [s.number, s.state, s.headSha ?? "", s.checksStatus ?? "", s.reviewStatus ?? ""].join("|");
}

/**
 * Start the GitHub PR watcher. Each tick fetches the active PR and emits
 * a `github.pr.changed` event when the snapshot key differs from the last
 * one. First successful tick always emits so subscribers replace their
 * loading state.
 */
export function startGitHubPrPublisher(opts: GitHubPrPublisherOptions): GitHubPrPublisherHandle {
  const pollMs = opts.pollMs ?? 60_000;
  const sourceRole = opts.sourceRole ?? "github";
  let lastKey: string | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const publish = (): void => {
    const event: GroveEvent = {
      type: "github.pr.changed",
      sourceRole,
      targetRole: TUI_REFRESH_ROLE,
      payload: {},
      timestamp: new Date().toISOString(),
    };
    void opts.eventBus.publish(event);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const snap = await opts.getActivePR();
      const key = snapshotKey(snap);
      if (key !== lastKey) {
        lastKey = key;
        publish();
      }
    } catch {
      // Transient network / auth errors — try again next tick.
    }
  };

  timer = setInterval(() => void tick(), pollMs);
  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
