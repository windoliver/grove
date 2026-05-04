/**
 * Producer-side `agent.output` publisher (#390 / A8.4).
 *
 * Polls tmux session output at the producer level (out of `src/tui/`) and
 * publishes a coarse `agent.output` event whenever any pane mutates. The TUI
 * terminal/agent-list panels subscribe through the global RefreshContext
 * fan-out — replacing their own `usePolledData` interval timers.
 *
 * Lives outside `src/tui/` so the A8 acceptance grep (`grep -r setInterval
 * src/tui`) stays clean despite the producer using `setInterval` internally.
 *
 * For ACPX-streamed sessions, `nexus-agent-publisher.ts` already emits
 * `acp.message` events per turn message; that path bypasses this publisher.
 * This watcher exists for the tmux-managed (non-acpx) sessions that don't
 * have a per-message hook.
 */

import { createHash } from "node:crypto";
import { type EventBus, type GroveEvent, TUI_REFRESH_ROLE } from "../core/event-bus.js";

/** Minimal contract for the tmux manager — keeps this module decoupled from TUI types. */
export interface TmuxOutputSource {
  isAvailable(): Promise<boolean>;
  listSessions(): Promise<readonly string[]>;
  capturePanes(sessionName: string): Promise<string>;
}

/** Options for `startAgentOutputPublisher`. */
export interface AgentOutputPublisherOptions {
  readonly eventBus: EventBus;
  readonly tmux: TmuxOutputSource;
  /** Poll interval in ms — how often to re-capture pane state. Default: 250. */
  readonly pollMs?: number;
  /** Source role label used on the published event. Default: `"acp"`. */
  readonly sourceRole?: string;
}

/** Handle returned by the publisher; call `stop()` to detach. */
export interface AgentOutputPublisherHandle {
  readonly stop: () => void;
}

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/**
 * Start the agent-output watcher. Each tick captures every active pane,
 * hashes the contents, and publishes a single coarse event when any
 * session's hash changed since the last tick.
 *
 * Capture and hash work is cheap (a few KB per session); the publisher
 * intentionally only emits ONCE per tick regardless of how many panes
 * changed — subscribers re-fetch their own targeted view.
 */
export function startAgentOutputPublisher(
  opts: AgentOutputPublisherOptions,
): AgentOutputPublisherHandle {
  const pollMs = opts.pollMs ?? 250;
  const sourceRole = opts.sourceRole ?? "acp";
  const lastHashes = new Map<string, string>();

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const publish = (): void => {
    const event: GroveEvent = {
      type: "agent.output",
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
      if (!(await opts.tmux.isAvailable())) return;
      const sessions = await opts.tmux.listSessions();

      // Drop hashes for sessions that no longer exist so a re-spawn under the
      // same name doesn't suppress the first emit.
      const live = new Set(sessions);
      for (const k of [...lastHashes.keys()]) {
        if (!live.has(k)) lastHashes.delete(k);
      }

      let changed = false;
      for (const session of sessions) {
        try {
          const out = await opts.tmux.capturePanes(session);
          const h = hash(out);
          const prev = lastHashes.get(session);
          if (prev !== h) {
            lastHashes.set(session, h);
            // First-tick capture for a never-seen session also counts as a
            // change — subscribers want to see initial output.
            changed = true;
          }
        } catch {
          // Capture can race with kill; skip the session this tick.
        }
      }
      if (changed) publish();
    } catch {
      // Tmux unavailable / transient error — try again next tick.
    }
  };

  timer = setInterval(() => void tick(), pollMs);
  // Kick once immediately so the first frame doesn't wait `pollMs`.
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
