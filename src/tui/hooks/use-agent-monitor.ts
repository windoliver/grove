/**
 * Hook for agent monitoring — log polling, tmux capture, permissions, IPC, spinner.
 *
 * Extracted from RunningView (issue #175) so the main screen can remain
 * a thin composition layer. All I/O is async to avoid blocking the render thread.
 */

import { useEffect, useState } from "react";
import type { EventBus, GroveEvent } from "../../core/event-bus.js";
import type { AgentTopology } from "../../core/topology.js";
import { stripAnsi } from "../../shared/format.js";
import { BRAILLE_SPINNER } from "../theme.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pending permission prompt from an agent. */
export interface PermissionPrompt {
  readonly sessionName: string;
  readonly agentRole: string;
  readonly command: string;
}

/** IPC message entry for the message log. */
export interface IpcMessage {
  readonly timestamp: string;
  readonly sourceRole: string;
  readonly targetRole: string;
  readonly type: string;
  readonly summary: string;
}

/** Options for the agent monitor hook. */
export interface AgentMonitorOptions {
  /** Path to .grove directory (for reading agent log files). */
  readonly groveDir?: string | undefined;
  /** Tmux manager for pane capture and permission detection. */
  readonly tmux?: import("../agents/tmux-manager.js").TmuxManager | undefined;
  /** EventBus for IPC message subscription. */
  readonly eventBus?: EventBus | undefined;
  /** Agent topology defining roles to monitor. */
  readonly topology?: AgentTopology | undefined;
  /** Max lines of output to keep per agent. Default: 8. */
  readonly maxOutputLines?: number | undefined;
}

/** State returned by the agent monitor hook. */
export interface AgentMonitorState {
  /** Per-role output lines (last N lines from logs or tmux capture). */
  readonly agentOutputs: ReadonlyMap<string, readonly string[]>;
  /** Pending permission prompts detected in tmux panes. */
  readonly pendingPermissions: readonly PermissionPrompt[];
  /** Recent IPC messages from the EventBus. */
  readonly ipcMessages: readonly IpcMessage[];
  /** Current spinner frame index (braille animation). */
  readonly spinnerFrame: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MAX_IPC_MESSAGES = 50;
const POLL_INTERVAL_MS = 2000;
const SPINNER_INTERVAL_MS = 80;

/** Hook that monitors agent activity via log files, tmux, and IPC events. */
export function useAgentMonitor(options: AgentMonitorOptions): AgentMonitorState {
  const { groveDir, tmux, eventBus, topology, maxOutputLines = 8 } = options;

  const [agentOutputs, setAgentOutputs] = useState<ReadonlyMap<string, readonly string[]>>(
    new Map(),
  );
  const [pendingPermissions, setPendingPermissions] = useState<readonly PermissionPrompt[]>([]);
  const [ipcMessages, setIpcMessages] = useState<readonly IpcMessage[]>([]);
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Braille spinner animation
  useEffect(() => {
    const timer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // Subscribe to EventBus for IPC message log
  useEffect(() => {
    if (!eventBus || !topology) return;
    const handlers: Array<{ role: string; handler: (e: GroveEvent) => void }> = [];
    for (const role of topology.roles) {
      const handler = (event: GroveEvent) => {
        const msg: IpcMessage = {
          timestamp: event.timestamp,
          sourceRole: event.sourceRole,
          targetRole: event.targetRole,
          type: event.type,
          summary: typeof event.payload.summary === "string" ? event.payload.summary : event.type,
        };
        setIpcMessages((prev) => [...prev.slice(-(MAX_IPC_MESSAGES - 1)), msg]);
      };
      handlers.push({ role: role.name, handler });
      eventBus.subscribe(role.name, handler);
    }
    return () => {
      for (const { role, handler } of handlers) {
        eventBus.unsubscribe(role, handler);
      }
    };
  }, [eventBus, topology]);

  // Poll agent log files for live output (async to avoid blocking render thread)
  useEffect(() => {
    if (!groveDir) return;
    const logDir = `${groveDir}/agent-logs`;
    let mounted = true;

    const poll = async () => {
      try {
        const fs = await import("node:fs/promises");
        const { existsSync } = await import("node:fs");
        if (!existsSync(logDir)) return;

        const entries = await fs.readdir(logDir);
        const files = entries.filter((f: string) => f.endsWith(".log"));

        // Accumulate lines across all log files for each role
        const accumulated = new Map<string, string[]>();
        for (const file of files) {
          const role = file.replace(/\.log$/, "").replace(/-\d+$/, "");
          try {
            const content = await fs.readFile(`${logDir}/${file}`, "utf-8");
            const lines = content
              .split("\n")
              .filter((l: string) => {
                const t = l.trim();
                return (
                  t.length > 0 &&
                  !t.startsWith("[stderr]") &&
                  !t.startsWith("[20") &&
                  !t.startsWith(">>> PROMPT") &&
                  !t.startsWith("<<< END PROMPT") &&
                  !t.includes("=== IDLE") &&
                  !t.includes("=== CRASHED") &&
                  !t.includes("=== Session")
                );
              })
              .map((l: string) => stripAnsi(l));
            const existing = accumulated.get(role) ?? [];
            accumulated.set(role, [...existing, ...lines]);
          } catch {
            // File might be being written to
          }
        }

        // Take last N lines per role
        const outputs = new Map<string, string[]>();
        for (const [role, lines] of accumulated) {
          outputs.set(role, lines.slice(-maxOutputLines));
        }
        if (mounted && outputs.size > 0) {
          setAgentOutputs(outputs);
        }
      } catch {
        // Non-fatal
      }
    };

    void poll(); // Initial read
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [groveDir, maxOutputLines]);

  // Poll agent tmux panes for live output (fallback when no log files)
  useEffect(() => {
    if (!tmux || groveDir) return; // Skip if log files are available
    const timer = setInterval(async () => {
      try {
        const sessions = await tmux.listSessions();
        const outputs = new Map<string, string[]>();
        for (const sess of sessions) {
          if (!sess.startsWith("grove-")) continue;
          const pane = await tmux.capturePanes(sess);
          const lines = pane.split("\n").filter((l) => l.trim().length > 0);
          const role = sess.replace("grove-", "").replace(/-[a-z0-9]+$/i, "");
          outputs.set(role, lines.slice(-maxOutputLines).map(stripAnsi));
        }
        setAgentOutputs(outputs);
      } catch {
        // Non-fatal
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [tmux, groveDir, maxOutputLines]);

  // Poll agent tmux panes for permission prompts
  useEffect(() => {
    if (!tmux) return;
    const timer = setInterval(async () => {
      try {
        const sessions = await tmux.listSessions();
        const prompts: PermissionPrompt[] = [];
        for (const sess of sessions) {
          if (!sess.startsWith("grove-")) continue;
          const pane = await tmux.capturePanes(sess);
          if (pane.includes("Do you want to proceed")) {
            const lines = pane.split("\n");
            let cmd = "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (
                trimmed &&
                !trimmed.startsWith("Permission") &&
                !trimmed.startsWith("Do you") &&
                !trimmed.startsWith("\u276f") &&
                !trimmed.startsWith("Esc")
              ) {
                cmd = trimmed;
              }
            }
            const role = sess.replace("grove-", "").replace(/-[a-z0-9]+$/, "");
            prompts.push({ sessionName: sess, agentRole: role, command: cmd.slice(0, 80) });
          }
        }
        setPendingPermissions(prompts);
      } catch {
        // Polling errors are non-fatal
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [tmux]);

  return { agentOutputs, pendingPermissions, ipcMessages, spinnerFrame };
}
