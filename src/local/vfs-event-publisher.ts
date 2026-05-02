/**
 * Producer-side VFS change publisher (#390 / A8.4).
 *
 * Watches the workspaces directory under `.grove/workspaces/` and publishes
 * a coarse `vfs.changed` event on the supplied EventBus whenever the tree
 * mutates. Subscribers (the TUI vfs-browser and artifact-preview panels)
 * re-fetch on receipt — replacing the previous `setInterval`-driven path.
 *
 * Lives in `src/local/` so the A8 acceptance grep (`grep -r setInterval
 * src/tui`) stays clean even when the watcher uses coalescing timers.
 */

import { existsSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { type EventBus, type GroveEvent, TUI_REFRESH_ROLE } from "../core/event-bus.js";

/** Options for `startVfsEventPublisher`. */
export interface VfsEventPublisherOptions {
  readonly eventBus: EventBus;
  /** Absolute path to the .grove directory (parent of `workspaces/`). */
  readonly groveDir: string;
  /** Coalesce window in ms — multiple mutations inside this window publish once. */
  readonly coalesceMs?: number;
  /** Source role label used on the published event. Default: `"vfs"`. */
  readonly sourceRole?: string;
}

/** Handle returned by the publisher; call `stop()` to detach. */
export interface VfsEventPublisherHandle {
  readonly stop: () => void;
}

/**
 * Start watching `.grove/workspaces/` for tree mutations.
 *
 * Recursive `fs.watch` is supported on macOS + Windows; on Linux it falls
 * back to a non-recursive watch on the workspaces root, which is sufficient
 * for the coarse re-fetch trigger (any add/remove of a workspace dir
 * triggers an event; per-file mutations inside a workspace need agents to
 * re-write contributions, which already drive the contribution event path).
 */
export function startVfsEventPublisher(opts: VfsEventPublisherOptions): VfsEventPublisherHandle {
  const workspacesDir = join(opts.groveDir, "workspaces");
  const sourceRole = opts.sourceRole ?? "vfs";
  const coalesceMs = opts.coalesceMs ?? 200;

  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const publish = (): void => {
    if (stopped) return;
    const event: GroveEvent = {
      type: "vfs.changed",
      sourceRole,
      targetRole: TUI_REFRESH_ROLE,
      payload: {},
      timestamp: new Date().toISOString(),
    };
    void opts.eventBus.publish(event);
  };

  const schedulePublish = (): void => {
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      publish();
    }, coalesceMs);
  };

  // The watch target may not exist yet (fresh grove). Skip silently — when the
  // first workspace is materialized, contribution events already trigger TUI
  // refresh; subsequent invocations of this publisher (e.g. across runs) will
  // wire the watcher.
  const noopStop = (): void => {
    /* nothing wired — no watcher to detach */
  };

  if (!existsSync(workspacesDir)) {
    return { stop: noopStop };
  }

  let watcher: ReturnType<typeof fsWatch> | undefined;
  try {
    watcher = fsWatch(workspacesDir, { recursive: true }, () => schedulePublish());
  } catch {
    // Recursive watch unsupported (older Linux). Fall back to non-recursive.
    try {
      watcher = fsWatch(workspacesDir, () => schedulePublish());
    } catch {
      // Filesystem doesn't support fs.watch at all (rare). Give up — contribution
      // events still drive most TUI refreshes.
      return { stop: noopStop };
    }
  }

  watcher.on("error", () => {
    // fs.watch can emit transient errors (e.g. directory deleted + recreated).
    // Non-fatal: drop the event silently.
  });

  return {
    stop: () => {
      stopped = true;
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = undefined;
      }
      watcher?.close();
    },
  };
}
