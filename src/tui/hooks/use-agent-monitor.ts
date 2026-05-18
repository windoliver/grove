/**
 * Hook for agent monitoring — log polling, tmux capture, permissions, IPC, spinner.
 *
 * Extracted from RunningView (issue #175) so the main screen can remain
 * a thin composition layer. All I/O is async to avoid blocking the render thread.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { EventBus, GroveEvent } from "../../core/event-bus.js";
import { parseSessionId } from "../../core/session-id.js";
import type { AgentTopology } from "../../core/topology.js";
import { useInterval } from "../../local/use-interval.js";
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
  /** ISO timestamp of the most recent change per role. Updated only when the
   *  role's line array differs from its prior value. */
  readonly agentOutputTimestamps: ReadonlyMap<string, string>;
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

// ---------------------------------------------------------------------------
// Pure parsing functions (exported for testing)
// ---------------------------------------------------------------------------

/** Check whether a log line should be kept (not noise). */
export function isLogLineKept(line: string): boolean {
  const t = line.trim();
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
}

/** Extract role name from a log filename (e.g. "coder-0.log" → "coder"). */
export function roleFromLogFilename(filename: string): string {
  return filename.replace(/\.log$/, "").replace(/-\d+$/, "");
}

/**
 * Extract role name from a grove session name.
 *
 * Prefers the canonical {@link parseSessionId} contract
 * (`grove-<role>-<counter>-<base36>`). Falls back to a legacy single-suffix
 * strip for sessions named via the older TUI `tmuxSessionName(agentId)` path.
 */
export function roleFromSessionName(sessionName: string): string {
  const parsed = parseSessionId(sessionName);
  if (parsed) return parsed.role;
  return sessionName.replace("grove-", "").replace(/-[a-z0-9]+$/i, "");
}

/** Parse a permission prompt from tmux pane output. Returns the command string if detected, null otherwise. */
export function parsePermissionPrompt(paneOutput: string): string | null {
  if (!paneOutput.includes("Do you want to proceed")) return null;
  const lines = paneOutput.split("\n");
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
  return cmd.slice(0, 80);
}

/**
 * Parse raw log content into filtered, ANSI-stripped lines.
 * Exported for testing — used by the log polling effect.
 */
export function parseLogContent(content: string, maxLines: number): readonly string[] {
  const lines = content
    .split("\n")
    .filter(isLogLineKept)
    .map((l: string) => stripAnsi(l));
  return lines.slice(-maxLines);
}

/**
 * Merge a fresh outputs snapshot with the prior state and produce a parallel
 * timestamp map. A role's timestamp is bumped to `now` only when its line
 * array changed. Pure — exported for testing.
 */
export function mergeOutputs(
  priorOutputs: ReadonlyMap<string, readonly string[]>,
  priorTimestamps: ReadonlyMap<string, string>,
  nextOutputs: ReadonlyMap<string, readonly string[]>,
  now: string,
): {
  readonly outputs: ReadonlyMap<string, readonly string[]>;
  readonly timestamps: ReadonlyMap<string, string>;
} {
  const timestamps = new Map<string, string>(priorTimestamps);
  for (const [role, lines] of nextOutputs) {
    const prior = priorOutputs.get(role);
    const changed =
      !prior || prior.length !== lines.length || prior.some((line, i) => line !== lines[i]);
    if (changed) timestamps.set(role, now);
  }
  return { outputs: nextOutputs, timestamps };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Hook that monitors agent activity via log files, tmux, and IPC events. */
export function useAgentMonitor(options: AgentMonitorOptions): AgentMonitorState {
  const { groveDir, tmux, eventBus, topology, maxOutputLines = 8 } = options;

  const [agentOutputs, setAgentOutputs] = useState<ReadonlyMap<string, readonly string[]>>(
    new Map(),
  );
  const [agentOutputTimestamps, setAgentOutputTimestamps] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [pendingPermissions, setPendingPermissions] = useState<readonly PermissionPrompt[]>([]);
  const [ipcMessages, setIpcMessages] = useState<readonly IpcMessage[]>([]);
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Braille spinner animation
  useInterval(() => setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length), SPINNER_INTERVAL_MS);

  // Subscribe to EventBus for IPC message log.
  // Deduplicate: MCP TopologyRouter AND TUI wsBridge.send BOTH write into
  // the kernel-VFS inbox via /api/v2/files/write → SSE → same handler
  // fires twice per routing.
  // Use source→target with a time window to collapse duplicates.
  useEffect(() => {
    if (!eventBus || !topology) return;
    const lastSeen = new Map<string, number>(); // key → timestamp ms
    const DEDUP_WINDOW_MS = 30_000;
    const handlers: Array<{ role: string; handler: (e: GroveEvent) => void }> = [];
    for (const role of topology.roles) {
      const handler = (event: GroveEvent) => {
        const pairKey = `${event.sourceRole}→${event.targetRole}`;
        const now = Date.now();
        const lastTime = lastSeen.get(pairKey) ?? 0;
        if (now - lastTime < DEDUP_WINDOW_MS) return; // Skip duplicate within window
        lastSeen.set(pairKey, now);
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
  const logPoll = useCallback(async () => {
    if (!groveDir) return;
    const logDir = `${groveDir}/agent-logs`;
    try {
      const fs = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      if (!existsSync(logDir)) return;

      const entries = await fs.readdir(logDir);
      const files = entries.filter((f: string) => f.endsWith(".log"));

      const accumulated = new Map<string, string[]>();
      for (const file of files) {
        const role = roleFromLogFilename(file);
        try {
          const content = await fs.readFile(`${logDir}/${file}`, "utf-8");
          const lines = content.split("\n").filter(isLogLineKept).map(stripAnsi);
          const existing = accumulated.get(role) ?? [];
          accumulated.set(role, [...existing, ...lines]);
        } catch {
          // File might be being written to
        }
      }

      const outputs = new Map<string, string[]>();
      for (const [role, lines] of accumulated) {
        outputs.set(role, lines.slice(-maxOutputLines));
      }
      if (mountedRef.current && outputs.size > 0) {
        const now = new Date().toISOString();
        setAgentOutputs((prior) => {
          const merged = mergeOutputs(prior, agentOutputTimestamps, outputs, now);
          setAgentOutputTimestamps(merged.timestamps);
          return merged.outputs;
        });
      }
    } catch {
      // Non-fatal
    }
  }, [groveDir, maxOutputLines, agentOutputTimestamps]);

  useEffect(() => {
    void logPoll();
  }, [logPoll]);

  useInterval(() => void logPoll(), POLL_INTERVAL_MS, Boolean(groveDir));

  // Poll agent tmux panes for live output (fallback when no log files)
  const tmuxPoll = useCallback(async () => {
    if (!tmux || groveDir) return;
    try {
      const sessions = await tmux.listSessions();
      const outputs = new Map<string, string[]>();
      for (const sess of sessions) {
        if (!sess.startsWith("grove-")) continue;
        const pane = await tmux.capturePanes(sess);
        const lines = pane.split("\n").filter((l) => l.trim().length > 0);
        const role = roleFromSessionName(sess);
        outputs.set(role, lines.slice(-maxOutputLines).map(stripAnsi));
      }
      if (mountedRef.current) {
        const now = new Date().toISOString();
        setAgentOutputs((prior) => {
          const merged = mergeOutputs(prior, agentOutputTimestamps, outputs, now);
          setAgentOutputTimestamps(merged.timestamps);
          return merged.outputs;
        });
      }
    } catch {
      // Non-fatal
    }
  }, [tmux, groveDir, maxOutputLines, agentOutputTimestamps]);

  useInterval(() => void tmuxPoll(), POLL_INTERVAL_MS, Boolean(tmux) && !groveDir);

  // Poll agent tmux panes for permission prompts
  const permissionPoll = useCallback(async () => {
    if (!tmux) return;
    try {
      const sessions = await tmux.listSessions();
      const prompts: PermissionPrompt[] = [];
      for (const sess of sessions) {
        if (!sess.startsWith("grove-")) continue;
        const pane = await tmux.capturePanes(sess);
        const cmd = parsePermissionPrompt(pane);
        if (cmd !== null) {
          const role = roleFromSessionName(sess);
          prompts.push({ sessionName: sess, agentRole: role, command: cmd });
        }
      }
      if (mountedRef.current) {
        setPendingPermissions(prompts);
      }
    } catch {
      // Polling errors are non-fatal
    }
  }, [tmux]);

  useInterval(() => void permissionPoll(), POLL_INTERVAL_MS, Boolean(tmux));

  return { agentOutputs, agentOutputTimestamps, pendingPermissions, ipcMessages, spinnerFrame };
}
