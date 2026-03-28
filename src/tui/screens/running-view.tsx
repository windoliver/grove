/**
 * Screen 4: Running view — contribution feed + agent status.
 *
 * Top: Agent status line (braille spinner for working, bullet for active, circle for idle, x for crashed)
 * Middle: Contribution feed (last 50, scrollable with j/k)
 * Bottom: Status bar with [RUNNING] label
 * Tab: toggle to advanced mode (existing App boardroom)
 * Ctrl+F: Nexus folder browser overlay
 * q: confirm quit
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useEffect, useState } from "react";
import type { EventBus, GroveEvent } from "../../core/event-bus.js";
import type { Contribution } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { EmptyState } from "../components/empty-state.js";
import { ProgressBar } from "../components/progress-bar.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { DashboardData, TuiDataProvider } from "../provider.js";
import { isVfsProvider } from "../provider.js";
import { BRAILLE_SPINNER, KIND_ICONS, PLATFORM_COLORS, theme } from "../theme.js";
import { VfsBrowserView } from "../views/vfs-browser.js";

/** A pending permission prompt from an agent. */
interface PermissionPrompt {
  readonly sessionName: string;
  readonly agentRole: string;
  readonly command: string;
}

/** Target metric info for progress bar display. */
export interface TargetMetricInfo {
  readonly metric: string;
  readonly value: number;
  readonly direction: "minimize" | "maximize";
}

/** Props for the RunningView screen. */
export interface RunningViewProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly topology?: AgentTopology | undefined;
  readonly goal?: string | undefined;
  readonly sessionId?: string | undefined;
  /** When set, only show contributions created at or after this ISO timestamp (scopes feed to current session). */
  readonly sessionStartedAt?: string | undefined;
  readonly tmux?: import("../agents/tmux-manager.js").TmuxManager | undefined;
  readonly eventBus?: EventBus | undefined;
  /** Target metric for progress bar (from contract stop conditions). */
  readonly targetMetric?: TargetMetricInfo | undefined;
  /** Path to .grove directory (for reading agent log files). */
  readonly groveDir?: string | undefined;
  /** Callback when a new contribution is detected — used for local IPC routing. */
  readonly onNewContribution?: ((contribution: Contribution) => void) | undefined;
  /** Send a user message to an agent role. Returns true if delivered. */
  readonly onSendToAgent?: ((role: string, message: string) => Promise<boolean>) | undefined;
  /** Active agent roles for the prompt target selector. */
  readonly activeRoles?: readonly string[] | undefined;
  readonly onToggleAdvanced: () => void;
  readonly onComplete: (reason: string) => void;
  readonly onQuit: () => void;
}

/** IPC message entry for the message log. */
interface IpcMessage {
  readonly timestamp: string;
  readonly sourceRole: string;
  readonly targetRole: string;
  readonly type: string;
  readonly summary: string;
}

/** Format a timestamp for display. */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "--:--";
  }
}

const MAX_FEED_ITEMS = 50;

/** Screen 4: running view with contribution feed and agent status. */
export const RunningView: React.NamedExoticComponent<RunningViewProps> = React.memo(
  function RunningView({
    provider,
    intervalMs,
    topology,
    goal,
    sessionStartedAt,
    tmux,
    eventBus,
    targetMetric,
    groveDir,
    onNewContribution,
    onSendToAgent,
    activeRoles,
    onToggleAdvanced,
    onComplete: _onComplete,
    onQuit,
  }: RunningViewProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [showVfs, setShowVfs] = useState(false);
    const [confirmQuit, setConfirmQuit] = useState(false);
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    const [pendingPermissions, setPendingPermissions] = useState<PermissionPrompt[]>([]);
    // Agent output streaming
    const [agentOutputs, setAgentOutputs] = useState<Map<string, string[]>>(new Map());
    const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
    const AGENT_OUTPUT_LINES = 8;
    // User prompt input
    const [promptMode, setPromptMode] = useState(false);
    const [promptText, setPromptText] = useState("");
    const [promptTarget, setPromptTarget] = useState(0); // index into activeRoles
    // IPC message log
    const [ipcMessages, setIpcMessages] = useState<IpcMessage[]>([]);
    // Crashed agents
    const [crashedAgents, setCrashedAgents] = useState<Set<string>>(new Set());

    /** Strip ANSI escape codes from terminal output. */
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
    const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
    const ANSI_OSC_RE = /\x1b\][^\x07]*\x07/g;
    const stripAnsi = React.useCallback(
      (s: string): string => s.replace(ANSI_RE, "").replace(ANSI_OSC_RE, ""),
      [],
    );

    // Braille spinner animation
    useEffect(() => {
      const timer = setInterval(() => {
        setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length);
      }, 80);
      return () => clearInterval(timer);
    }, []);

    // Subscribe to EventBus for IPC message log + crash detection
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
          setIpcMessages((prev) => [...prev.slice(-49), msg]);
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

    // Crash detection via tmux is disabled — it produces false positives when
    // agents use AcpxRuntime (no tmux sessions) or when resuming without spawning.
    // Agent status is shown from the topology; crashes are only meaningful when
    // agents are actively spawned and running.
    const hasTmuxAgents = false;
    useEffect(() => {
      if (!hasTmuxAgents || !topology || !tmux) return;
      const timer = setInterval(async () => {
        try {
          const sessions = await tmux.listSessions();
          const groveSessions = new Set(sessions.filter((s) => s.startsWith("grove-")));
          for (const role of topology.roles) {
            const hasSession = [...groveSessions].some((s) => s.includes(`grove-${role.name}`));
            if (!hasSession) {
              setCrashedAgents((prev) => {
                if (prev.has(role.name)) return prev;
                const next = new Set(prev);
                next.add(role.name);
                return next;
              });
            } else {
              setCrashedAgents((prev) => {
                if (!prev.has(role.name)) return prev;
                const next = new Set(prev);
                next.delete(role.name);
                return next;
              });
            }
          }
        } catch {
          // Non-fatal
        }
      }, 5000);
      return () => clearInterval(timer);
    }, [topology, tmux]);

    // Poll agent log files for live output (AcpxRuntime writes to .grove/agent-logs/)
    useEffect(() => {
      if (!groveDir) return;
      const logDir = `${groveDir}/agent-logs`;
      const { readdirSync, readFileSync, existsSync } =
        require("node:fs") as typeof import("node:fs");

      const poll = () => {
        try {
          if (!existsSync(logDir)) return;
          const files = readdirSync(logDir).filter((f: string) => f.endsWith(".log"));
          const outputs = new Map<string, string[]>();
          for (const file of files) {
            const role = file.replace(/\.log$/, "").replace(/-\d+$/, "");
            try {
              const content = readFileSync(`${logDir}/${file}`, "utf-8");
              const lines = content
                .split("\n")
                .filter((l: string) => {
                  const t = l.trim();
                  // Skip empty, stderr, internal log markers, and timestamp-only lines
                  return (
                    t.length > 0 &&
                    !t.startsWith("[stderr]") &&
                    !t.startsWith("[20") && // timestamp lines like [2026-03-27T...]
                    !t.startsWith(">>> PROMPT") &&
                    !t.startsWith("<<< END PROMPT") &&
                    !t.includes("=== IDLE") &&
                    !t.includes("=== CRASHED") &&
                    !t.includes("=== Session")
                  );
                })
                .map((l: string) => stripAnsi(l))
                .slice(-AGENT_OUTPUT_LINES);
              outputs.set(role, lines);
            } catch {
              // File might be being written to
            }
          }
          if (outputs.size > 0) {
            setAgentOutputs(outputs);
          }
        } catch {
          // Non-fatal
        }
      };

      poll(); // Initial read
      const timer = setInterval(poll, 2000);
      return () => clearInterval(timer);
    }, [groveDir, stripAnsi]);

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
            outputs.set(role, lines.slice(-AGENT_OUTPUT_LINES).map(stripAnsi));
          }
          setAgentOutputs(outputs);
        } catch {
          // Non-fatal
        }
      }, 2000);
      return () => clearInterval(timer);
    }, [tmux, groveDir, stripAnsi]);

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
              // Extract the command from the pane output
              const lines = pane.split("\n");
              let cmd = "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (
                  trimmed &&
                  !trimmed.startsWith("Permission") &&
                  !trimmed.startsWith("Do you") &&
                  !trimmed.startsWith("❯") &&
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
      }, 2000);
      return () => clearInterval(timer);
    }, [tmux]);

    // Data fetching — polling is the baseline, EventBus triggers immediate refresh.
    // MCP server and TUI are separate processes. Polling is the reliable path.
    // When NexusWsBridge SSE connects, events trigger instant re-fetch via EventBus.
    const dashboardFetcher = useCallback(() => provider.getDashboard(), [provider]);
    const contributionsFetcher = useCallback(
      () => provider.getContributions({ limit: MAX_FEED_ITEMS }),
      [provider],
    );

    const dashboardPoll = usePolledData<DashboardData>(dashboardFetcher, intervalMs, true);
    const contributionsPoll = usePolledData<readonly Contribution[]>(
      contributionsFetcher,
      intervalMs,
      true,
    );

    // When EventBus fires (SSE push from Nexus), trigger immediate re-fetch
    useEffect(() => {
      if (!eventBus) return;
      const handler = () => {
        dashboardPoll.refresh();
        contributionsPoll.refresh();
      };
      eventBus.subscribe("system", handler);
      return () => eventBus.unsubscribe("system", handler);
    }, [eventBus, dashboardPoll.refresh, contributionsPoll.refresh]);

    const dashboard = dashboardPoll.data;
    const contributions = contributionsPoll.data;

    // Filter contributions to current session scope (hide old contributions from previous sessions)
    const allContributions = contributions ?? [];
    const feed = sessionStartedAt
      ? allContributions.filter((c) => c.createdAt >= sessionStartedAt)
      : allContributions;

    // Track seen contribution CIDs and route new ones to downstream agents.
    // For NEW sessions (sessionStartedAt set): route all contributions (none are pre-existing).
    // For RESUMED sessions: seed existing CIDs on first fetch, route only new ones after.
    const seenCidsRef = React.useRef<Set<string>>(new Set());
    const initialSeededRef = React.useRef(false);
    useEffect(() => {
      if (!onNewContribution || !feed.length) return;

      if (!initialSeededRef.current && !sessionStartedAt) {
        // Resumed session: seed existing CIDs without routing on first fetch
        for (const c of feed) {
          seenCidsRef.current.add(c.cid);
        }
        initialSeededRef.current = true;
        return;
      }
      initialSeededRef.current = true;

      // Route any unseen CID
      for (const c of feed) {
        if (!seenCidsRef.current.has(c.cid)) {
          seenCidsRef.current.add(c.cid);
          onNewContribution(c);
        }
      }
    }, [feed, onNewContribution, sessionStartedAt]);

    useKeyboard(
      useCallback(
        (key) => {
          // --- Prompt input mode ---
          if (promptMode) {
            if (key.name === "escape") {
              setPromptMode(false);
              setPromptText("");
              return;
            }
            if (key.name === "return" && promptText.trim()) {
              const roles = activeRoles ?? [];
              const targetRole = roles[promptTarget % roles.length];
              if (targetRole && onSendToAgent) {
                void onSendToAgent(targetRole, promptText.trim());
              }
              setPromptMode(false);
              setPromptText("");
              return;
            }
            if (key.name === "tab") {
              // Cycle through target roles
              setPromptTarget((t) => (t + 1) % Math.max(1, (activeRoles ?? []).length));
              return;
            }
            if (key.name === "backspace") {
              setPromptText((t) => t.slice(0, -1));
              return;
            }
            // Regular character input
            if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
              setPromptText((t) => t + key.sequence);
              return;
            }
            if (key.name === "space") {
              setPromptText((t) => `${t} `);
              return;
            }
            return;
          }

          // --- Normal mode ---
          // ':' or 'm': enter prompt mode to send message to agent
          if (
            (key.sequence === ":" || key.name === "m") &&
            onSendToAgent &&
            (activeRoles ?? []).length > 0
          ) {
            setPromptMode(true);
            setPromptText("");
            return;
          }
          // Ctrl+F: toggle VFS browser
          if (key.ctrl && key.name === "f") {
            setShowVfs((v) => !v);
            return;
          }
          // Tab: toggle advanced mode
          if (key.name === "tab") {
            onToggleAdvanced();
            return;
          }
          // Escape: dismiss VFS or quit confirm
          if (key.name === "escape") {
            if (showVfs) {
              setShowVfs(false);
              return;
            }
            if (confirmQuit) {
              setConfirmQuit(false);
              return;
            }
            return;
          }
          // q: quit with confirmation
          if (key.name === "q") {
            if (showVfs) {
              setShowVfs(false);
              return;
            }
            if (confirmQuit) {
              onQuit();
              return;
            }
            setConfirmQuit(true);
            return;
          }
          // y: approve permission prompt (send Enter to agent)
          if (key.name === "y" && pendingPermissions.length > 0) {
            const prompt = pendingPermissions[0];
            if (prompt && tmux) {
              void tmux.sendKeys(prompt.sessionName, "").then(() => {
                const proc = Bun.spawn(
                  ["tmux", "-L", "grove", "send-keys", "-t", prompt.sessionName, "Enter"],
                  { stdout: "pipe", stderr: "pipe" },
                );
                void proc.exited;
              });
            }
            return;
          }
          // n: deny permission prompt (send Escape to agent)
          if (key.name === "n" && pendingPermissions.length > 0) {
            const prompt = pendingPermissions[0];
            if (prompt && tmux) {
              const proc = Bun.spawn(
                ["tmux", "-L", "grove", "send-keys", "-t", prompt.sessionName, "Escape"],
                { stdout: "pipe", stderr: "pipe" },
              );
              void proc.exited;
            }
            return;
          }
          // 1-9: toggle agent output expand/collapse
          if (key.name && key.name >= "1" && key.name <= "9") {
            const idx = Number(key.name) - 1;
            const roleName = (topology?.roles ?? [])[idx]?.name;
            if (roleName) {
              setExpandedAgents((prev) => {
                const next = new Set(prev);
                if (next.has(roleName)) next.delete(roleName);
                else next.add(roleName);
                return next;
              });
            }
            return;
          }
          // r: respond to ask_user question (scroll to it)
          if (key.name === "r") {
            const askIdx = feed.findIndex((c) => c.kind === "ask_user");
            if (askIdx >= 0) {
              setCursor(askIdx);
            }
            return;
          }
          // j/k: scroll feed
          if (key.name === "j" || key.name === "down") {
            setCursor((c) => Math.min(c + 1, Math.max(0, feed.length - 1)));
            return;
          }
          if (key.name === "k" || key.name === "up") {
            setCursor((c) => Math.max(c - 1, 0));
            return;
          }
        },
        [
          showVfs,
          confirmQuit,
          feed,
          promptMode,
          promptText,
          promptTarget,
          activeRoles,
          onSendToAgent,
          onToggleAdvanced,
          onQuit,
          pendingPermissions,
          tmux,
          topology,
        ],
      ),
    );

    // Agent status with expandable output
    const agentSections = (topology?.roles ?? []).map((role, idx) => {
      const activeClaim = dashboard?.activeClaims.find(
        (c) => c.agent.role === role.name || c.agent.agentId.startsWith(role.name),
      );
      const platformColor = PLATFORM_COLORS[role.platform ?? "claude-code"] ?? theme.text;
      const expanded = expandedAgents.has(role.name);
      const output = agentOutputs.get(role.name);
      const lastLine = output && output.length > 0 ? (output[output.length - 1] ?? "") : "";

      const isCrashed = crashedAgents.has(role.name);

      let icon: string;
      let color: string;
      if (isCrashed) {
        icon = theme.agentError;
        color = theme.warning;
      } else if (activeClaim) {
        icon = BRAILLE_SPINNER[spinnerFrame] ?? theme.agentRunning;
        color = theme.running;
      } else {
        icon = theme.agentIdle;
        color = theme.idle;
      }

      return (
        <box key={role.name} flexDirection="column">
          <box flexDirection="row">
            <text color={color}>{icon} </text>
            <text color={platformColor} bold>
              {role.name}
            </text>
            <text color={theme.dimmed}> [{idx + 1}] </text>
            {isCrashed ? (
              <text color={theme.warning}>
                {"\u2717"} crashed {"\u2014"} reconnecting{"\u2026"}
              </text>
            ) : !expanded && lastLine ? (
              <text color={theme.muted}>{lastLine.slice(0, 80)}</text>
            ) : null}
          </box>
          {expanded && output ? (
            <box flexDirection="column" marginLeft={4} marginBottom={1}>
              {output.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                <text key={i} color={theme.muted}>
                  {line.slice(0, 120)}
                </text>
              ))}
            </box>
          ) : null}
        </box>
      );
    });

    // VFS overlay
    if (showVfs) {
      if (isVfsProvider(provider)) {
        return (
          <box
            flexDirection="column"
            width="100%"
            height="100%"
            borderStyle="round"
            borderColor={theme.focus}
          >
            <box flexDirection="row" paddingX={2} paddingTop={1}>
              <text color={theme.focus} bold>
                Nexus Folder Browser
              </text>
              <text color={theme.dimmed}> (Esc to close)</text>
            </box>
            <box flexDirection="column" paddingX={2} flexGrow={1}>
              <VfsBrowserView
                provider={provider}
                intervalMs={intervalMs}
                active={true}
                cursor={cursor}
                navigateTrigger={0}
              />
            </box>
          </box>
        );
      }
      // Fallback: show .grove/ directory hint
      return (
        <box
          flexDirection="column"
          width="100%"
          height="100%"
          borderStyle="round"
          borderColor={theme.focus}
        >
          <box flexDirection="column" paddingX={2} paddingTop={1}>
            <text color={theme.focus} bold>
              File Browser
            </text>
            <EmptyState
              title="VFS requires Nexus backend."
              hint="Browse .grove/ directory locally for session files."
            />
            <box marginTop={1}>
              <text color={theme.dimmed}>Esc:close</text>
            </box>
          </box>
        </box>
      );
    }

    const _contribCount = dashboard?.metadata.contributionCount ?? 0;
    const claimCount = dashboard?.activeClaims.length ?? 0;
    const frontier = dashboard?.frontierSummary;

    // Detect pending ask_user contributions
    const pendingAskUser = feed.find((c) => c.kind === "ask_user");

    // Get current best score for progress bar
    const currentBestScore =
      targetMetric && frontier?.topByMetric
        ? frontier.topByMetric.find((m) => m.metric === targetMetric.metric)?.value
        : undefined;

    return (
      <box flexDirection="column" width="100%" height="100%">
        {/* Agent status with live output */}
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            Agents
          </text>
          {agentSections.length > 0 ? agentSections : <EmptyState title="No roles defined" />}
        </box>

        {/* Goal display */}
        {goal ? (
          <box paddingX={2}>
            <text color={theme.muted}>Goal: {goal}</text>
          </box>
        ) : null}

        {/* Frontier — best contributions by metric */}
        {frontier && frontier.topByMetric.length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.focus} bold>
              Frontier
            </text>
            {frontier.topByMetric.map((entry) => (
              <box key={entry.metric} flexDirection="row">
                <text color={theme.info}>{entry.metric}: </text>
                <text color={theme.text}>{entry.value.toFixed(4)}</text>
                <text color={theme.dimmed}> {entry.summary.slice(0, 50)}</text>
              </box>
            ))}
          </box>
        ) : null}

        {/* ask_user alert */}
        {pendingAskUser ? (
          <box flexDirection="row" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.warning}>
              {KIND_ICONS.ask_user ?? "\u2753"} Question pending {"\u2014"} r:respond
            </text>
          </box>
        ) : null}

        {/* Contribution feed */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
          flexGrow={1}
        >
          <text color={theme.focus} bold>
            Contribution Feed
          </text>
          {feed.length === 0 ? (
            <EmptyState
              title="Waiting for contributions..."
              hint="Agents are working on your goal"
            />
          ) : (
            feed.slice(Math.max(0, cursor - 20), cursor + 30).map((c, i) => {
              const actualIndex = Math.max(0, cursor - 20) + i;
              const selected = actualIndex === cursor;
              const kindColor =
                c.kind === "work"
                  ? theme.work
                  : c.kind === "review"
                    ? theme.review
                    : c.kind === "discussion"
                      ? theme.discussion
                      : c.kind === "adoption"
                        ? theme.adoption
                        : theme.text;
              const kindIcon = KIND_ICONS[c.kind] ?? "\u25a0";
              return (
                <box
                  key={c.cid}
                  flexDirection="row"
                  backgroundColor={selected ? theme.selectedBg : undefined}
                >
                  <text color={theme.dimmed}>{formatTime(c.createdAt)} </text>
                  <text color={kindColor}>{kindIcon} </text>
                  <text color={kindColor}>{c.kind.padEnd(12)}</text>
                  <text color={selected ? theme.text : theme.muted}>{c.summary.slice(0, 60)}</text>
                </box>
              );
            })
          )}
        </box>

        {/* Permission prompts from agents */}
        {pendingPermissions.length > 0 ? (
          <box
            flexDirection="column"
            marginX={2}
            borderStyle="single"
            borderColor={theme.warning}
            paddingX={1}
          >
            <text color={theme.warning} bold>
              Permission Request ({pendingPermissions.length})
            </text>
            {pendingPermissions.map((p) => (
              <box key={p.sessionName} flexDirection="row">
                <text color={theme.focus}>{p.agentRole}</text>
                <text color={theme.muted}> wants to run: </text>
                <text color={theme.text}>{p.command}</text>
              </box>
            ))}
            <text color={theme.dimmed}>y:approve n:deny</text>
          </box>
        ) : null}

        {/* IPC message log */}
        {ipcMessages.length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.dimmed} bold>
              IPC Messages
            </text>
            {ipcMessages.slice(-5).map((msg, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: IPC messages are ephemeral
              <box key={i} flexDirection="row">
                <text color={theme.dimmed}>{formatTime(msg.timestamp)} </text>
                <text color={theme.info}>{msg.sourceRole}</text>
                <text color={theme.dimmed}> {"\u2192"} </text>
                <text color={theme.focus}>{msg.targetRole}</text>
                <text color={theme.muted}> {msg.summary.slice(0, 40)}</text>
              </box>
            ))}
          </box>
        ) : null}

        {/* Quit confirmation */}
        {confirmQuit ? (
          <box paddingX={2}>
            <text color={theme.warning}>Press q again to quit, Esc to cancel</text>
          </box>
        ) : null}

        {/* Progress bar — when target metric defined */}
        {targetMetric && currentBestScore !== undefined ? (
          <ProgressBar
            label={targetMetric.metric}
            value={currentBestScore}
            target={targetMetric.value}
            direction={targetMetric.direction}
          />
        ) : null}

        {/* Prompt input (when active) */}
        {promptMode ? (
          <box flexDirection="row" paddingX={2}>
            <text color={theme.focus}>
              {"→ "}
              {(activeRoles ?? [])[promptTarget % (activeRoles ?? []).length] ?? "agent"}
              {": "}
            </text>
            <text>{promptText}</text>
            <text color={theme.dimmed}>▌</text>
            <text color={theme.dimmed}> Tab:switch role Enter:send Esc:cancel</text>
          </box>
        ) : null}

        {/* Status bar */}
        <box flexDirection="row" paddingX={2}>
          <text color={theme.running}>[RUNNING]</text>
          <text color={theme.muted}>
            {" "}
            {feed.length}c | {claimCount} active
          </text>
          <text color={theme.dimmed}>
            {" "}
            {(activeRoles ?? []).length > 0 ? "m:message " : ""}Tab:advanced j/k:scroll
            {pendingAskUser ? " r:respond" : ""} q:quit
          </text>
        </box>
      </box>
    );
  },
);
