/**
 * Screen 4: Running view — contribution feed + agent status with progressive disclosure.
 *
 * Layout modes:
 *   - Feed-only (default): agent status + contribution feed
 *   - Half-screen split: feed + expanded panel (1-4 to toggle)
 *   - Fullscreen: expanded panel fills entire view (f to toggle)
 *
 * Number keys 1-4 expand panels: 1=Feed, 2=Agents, 3=DAG, 4=Terminal
 * f: toggle fullscreen on expanded panel
 * Esc: collapse expanded panel → dismiss overlay → cancel quit
 * Ctrl+A: toggle to advanced boardroom
 * Ctrl+F: Nexus folder browser overlay
 * q: confirm quit (double-tap)
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { EventBus } from "../../core/event-bus.js";
import type { Contribution } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { EmptyState } from "../components/empty-state.js";
import { ProgressBar } from "../components/progress-bar.js";
import { useAgentMonitor } from "../hooks/use-agent-monitor.js";
import { InputMode } from "../hooks/use-panel-focus.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { DashboardData, TuiDataProvider } from "../provider.js";
import { isVfsProvider } from "../provider.js";
import { BRAILLE_SPINNER, KIND_ICONS, PLATFORM_COLORS, theme } from "../theme.js";
import { AgentListView } from "../views/agent-list.js";
import { DagView } from "../views/dag.js";
import { TerminalView } from "../views/terminal.js";
import { VfsBrowserView } from "../views/vfs-browser.js";
import {
  collapsePanel,
  expandPanel as expandPanelTransition,
  RUNNING_PANEL_LABELS,
  type RunningKeyboardActions,
  type RunningKeyboardState,
  RunningPanel,
  routeRunningKey,
  toggleFullscreen as toggleFullscreenTransition,
} from "./running-keyboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** When set, only show contributions created at or after this ISO timestamp. */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
/** Default number of visible feed items (used when terminal height is unavailable). */
const DEFAULT_FEED_WINDOW = 30;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Screen 4: running view with contribution feed, agent status, and expandable panels. */
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
    // ─── Panel state ───
    const [expandedPanel, setExpandedPanel] = useState<RunningPanel | null>(null);
    const [zoomLevel, setZoomLevel] = useState<"normal" | "half" | "full">("normal");

    // ─── Agent output expansion (e key toggles) ───
    const [agentsExpanded, setAgentsExpanded] = useState(false);

    // ─── Overlay state ───
    const [showVfs, setShowVfs] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [confirmQuit, setConfirmQuit] = useState(false);

    // ─── Prompt state ───
    const [promptMode, setPromptMode] = useState(false);
    const [promptText, setPromptText] = useState("");
    const [promptTarget, setPromptTarget] = useState(0);

    // ─── Feed state ───
    const [cursor, setCursor] = useState(0);

    // ─── Elapsed timer ───
    const [elapsed, setElapsed] = useState("0s");
    useEffect(() => {
      const start = sessionStartedAt ? new Date(sessionStartedAt).getTime() : Date.now();
      const tick = () => {
        const ms = Date.now() - start;
        const m = Math.floor(ms / 60_000);
        const s = Math.floor((ms % 60_000) / 1_000);
        setElapsed(m > 0 ? `${m}m${s}s` : `${s}s`);
      };
      tick();
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }, [sessionStartedAt]);

    // ─── Agent monitoring (extracted hook) ───
    const monitor = useAgentMonitor({ groveDir, tmux, eventBus, topology });

    // ─── Data fetching ───
    const dashboardFetcher = useCallback(() => provider.getDashboard(), [provider]);
    const contributionsFetcher = useCallback(
      () => provider.getContributions({ limit: MAX_FEED_ITEMS }),
      [provider],
    );

    // Gate polling: pause contributions when panel is fullscreen and not showing feed
    const feedActive =
      zoomLevel !== "full" || expandedPanel === RunningPanel.Feed || expandedPanel === null;
    const dashboardPoll = usePolledData<DashboardData>(dashboardFetcher, intervalMs, true);
    const contributionsPoll = usePolledData<readonly Contribution[]>(
      contributionsFetcher,
      intervalMs,
      feedActive,
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

    // Filter contributions to current session scope
    const allContributions = contributions ?? [];
    const feed = sessionStartedAt
      ? allContributions.filter((c) => c.createdAt >= sessionStartedAt)
      : allContributions;

    // Track seen contribution CIDs and route new ones to downstream agents
    const seenCidsRef = React.useRef<Set<string>>(new Set());
    const initialSeededRef = React.useRef(false);
    useEffect(() => {
      if (!onNewContribution || !feed.length) return;

      if (!initialSeededRef.current && !sessionStartedAt) {
        for (const c of feed) {
          seenCidsRef.current.add(c.cid);
        }
        initialSeededRef.current = true;
        return;
      }
      initialSeededRef.current = true;

      for (const c of feed) {
        if (!seenCidsRef.current.has(c.cid)) {
          seenCidsRef.current.add(c.cid);
          onNewContribution(c);
        }
      }
    }, [feed, onNewContribution, sessionStartedAt]);

    // ─── Keyboard routing ───
    const pendingAskUser = feed.find((c) => c.kind === "ask_user");
    const keyboardState: RunningKeyboardState = useMemo(
      () => ({
        expandedPanel,
        zoomLevel,
        showHelp,
        showVfs,
        confirmQuit,
        promptMode,
        promptText,
      }),
      [expandedPanel, zoomLevel, showHelp, showVfs, confirmQuit, promptMode, promptText],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: actions object captures current closures intentionally
    const keyboardActions: RunningKeyboardActions = useMemo(
      () => ({
        expandPanel: (panel: RunningPanel) => {
          const next = expandPanelTransition(expandedPanel, zoomLevel, panel);
          setExpandedPanel(next.expandedPanel);
          setZoomLevel(next.zoomLevel);
        },
        collapsePanel: () => {
          const next = collapsePanel();
          setExpandedPanel(next.expandedPanel);
          setZoomLevel(next.zoomLevel);
        },
        toggleFullscreen: () => {
          const next = toggleFullscreenTransition(expandedPanel, zoomLevel);
          setExpandedPanel(next.expandedPanel);
          setZoomLevel(next.zoomLevel);
        },
        toggleAgentExpand: () => setAgentsExpanded((v) => !v),
        toggleHelp: () => setShowHelp((v) => !v),
        dismissHelp: () => setShowHelp(false),
        toggleVfs: () => setShowVfs((v) => !v),
        dismissVfs: () => setShowVfs(false),
        setConfirmQuit: (v: boolean) => setConfirmQuit(v),
        enterPromptMode: () => {
          setPromptMode(true);
          setPromptText("");
        },
        exitPromptMode: () => {
          setPromptMode(false);
          setPromptText("");
        },
        appendPromptChar: (char: string) => setPromptText((t) => t + char),
        deletePromptChar: () => setPromptText((t) => t.slice(0, -1)),
        cyclePromptTarget: () =>
          setPromptTarget((t) => (t + 1) % Math.max(1, (activeRoles ?? []).length)),
        submitPrompt: () => {
          const roles = activeRoles ?? [];
          const targetRole = roles[promptTarget % roles.length];
          if (targetRole && onSendToAgent) {
            void onSendToAgent(targetRole, promptText.trim());
          }
          setPromptMode(false);
          setPromptText("");
        },
        feedCursorDown: () => setCursor((c) => Math.min(c + 1, Math.max(0, feed.length - 1))),
        feedCursorUp: () => setCursor((c) => Math.max(c - 1, 0)),
        scrollToAskUser: () => {
          const askIdx = feed.findIndex((c) => c.kind === "ask_user");
          if (askIdx >= 0) setCursor(askIdx);
        },
        openDetail: () => onToggleAdvanced(),
        toggleAdvanced: () => onToggleAdvanced(),
        quit: () => onQuit(),
        approvePermission: () => {
          const prompt = monitor.pendingPermissions[0];
          if (prompt && tmux) {
            void tmux.sendKeys(prompt.sessionName, "").then(() => {
              const proc = Bun.spawn(
                ["tmux", "-L", "grove", "send-keys", "-t", prompt.sessionName, "Enter"],
                { stdout: "pipe", stderr: "pipe" },
              );
              void proc.exited;
            });
          }
        },
        denyPermission: () => {
          const prompt = monitor.pendingPermissions[0];
          if (prompt && tmux) {
            const proc = Bun.spawn(
              ["tmux", "-L", "grove", "send-keys", "-t", prompt.sessionName, "Escape"],
              { stdout: "pipe", stderr: "pipe" },
            );
            void proc.exited;
          }
        },
        hasPermissions: monitor.pendingPermissions.length > 0,
        hasActiveRoles: (activeRoles ?? []).length > 0,
        hasSendToAgent: !!onSendToAgent,
        feedLength: feed.length,
        hasAskUser: !!pendingAskUser,
      }),
      [
        expandedPanel,
        zoomLevel,
        activeRoles,
        promptTarget,
        promptText,
        onSendToAgent,
        feed,
        onToggleAdvanced,
        onQuit,
        monitor.pendingPermissions,
        tmux,
        pendingAskUser,
      ],
    );

    useKeyboard(
      useCallback(
        (key) => routeRunningKey(key, keyboardState, keyboardActions),
        [keyboardState, keyboardActions],
      ),
    );

    // ─── Derived data ───
    const claimCount = dashboard?.activeClaims.length ?? 0;
    const frontier = dashboard?.frontierSummary;
    const currentBestScore =
      targetMetric && frontier?.topByMetric
        ? frontier.topByMetric.find((m) => m.metric === targetMetric.metric)?.value
        : undefined;

    // ─── VFS overlay (takes over entire view) ───
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

    // ─── Fullscreen panel (takes over entire view) ───
    if (expandedPanel !== null && zoomLevel === "full") {
      return (
        <box flexDirection="column" width="100%" height="100%">
          {renderExpandedPanel(expandedPanel, {
            provider,
            intervalMs,
            tmux,
            dashboard,
            topology,
            monitor,
            cursor,
            feed,
          })}
          {renderStatusBar(
            expandedPanel,
            zoomLevel,
            elapsed,
            feed.length,
            claimCount,
            activeRoles,
            !!pendingAskUser,
          )}
        </box>
      );
    }

    // ─── Half-screen split (feed + expanded panel) ───
    if (expandedPanel !== null && zoomLevel === "half") {
      return (
        <box flexDirection="column" width="100%" height="100%">
          <box flexDirection="row" flexGrow={1}>
            {/* Left: feed column */}
            <box flexDirection="column" flexGrow={1} flexBasis="50%">
              {renderFeedSection(feed, cursor, goal, pendingAskUser, frontier, DEFAULT_FEED_WINDOW)}
            </box>
            {/* Right: expanded panel */}
            <box
              flexDirection="column"
              flexGrow={1}
              flexBasis="50%"
              borderStyle="single"
              borderColor={theme.focus}
            >
              <box flexDirection="row" paddingX={1}>
                <text color={theme.focus} bold>
                  {RUNNING_PANEL_LABELS[expandedPanel]}
                </text>
                <text color={theme.dimmed}> (f:fullscreen Esc:close)</text>
              </box>
              {renderExpandedPanel(expandedPanel, {
                provider,
                intervalMs,
                tmux,
                dashboard,
                topology,
                monitor,
                cursor,
                feed,
              })}
            </box>
          </box>
          {renderBottomChrome(
            monitor,
            confirmQuit,
            targetMetric,
            currentBestScore,
            promptMode,
            promptText,
            promptTarget,
            activeRoles,
          )}
          {renderStatusBar(
            expandedPanel,
            zoomLevel,
            elapsed,
            feed.length,
            claimCount,
            activeRoles,
            !!pendingAskUser,
          )}
        </box>
      );
    }

    // ─── Default: feed-only view ───
    return (
      <box flexDirection="column" width="100%" height="100%">
        {/* Agent status with live output */}
        {renderAgentSection(topology, dashboard, monitor, agentsExpanded)}

        {/* Main feed area */}
        {renderFeedSection(feed, cursor, goal, pendingAskUser, frontier, DEFAULT_FEED_WINDOW)}

        {/* Bottom chrome: permissions, IPC, quit confirm, progress, prompt */}
        {renderBottomChrome(
          monitor,
          confirmQuit,
          targetMetric,
          currentBestScore,
          promptMode,
          promptText,
          promptTarget,
          activeRoles,
        )}

        {/* Help overlay */}
        {showHelp ? renderHelpOverlay() : null}

        {/* Status bar */}
        {renderStatusBar(
          expandedPanel,
          zoomLevel,
          elapsed,
          feed.length,
          claimCount,
          activeRoles,
          !!pendingAskUser,
        )}
      </box>
    );
  },
);

// ---------------------------------------------------------------------------
// Render helpers (extracted from the main component for readability)
// ---------------------------------------------------------------------------

/** Max lines of agent output to show when expanded. */
const AGENT_OUTPUT_LINES = 12;

/** Render the agent status section with live output. */
function renderAgentSection(
  topology: AgentTopology | undefined,
  dashboard: DashboardData | undefined,
  monitor: ReturnType<typeof useAgentMonitor>,
  expanded: boolean,
): React.ReactNode {
  const roles = topology?.roles ?? [];
  if (roles.length === 0) {
    return (
      <box flexDirection="column" paddingX={2} paddingTop={1}>
        <text color={theme.focus} bold>
          Agents
        </text>
        <EmptyState title="No roles defined" />
      </box>
    );
  }
  return (
    <box flexDirection="column" paddingX={2} paddingTop={1}>
      <box flexDirection="row">
        <text color={theme.focus} bold>
          Agents
        </text>
        <text color={theme.dimmed}> (e:{expanded ? "collapse" : "expand"} traces)</text>
      </box>
      {roles.map((role, idx) => {
        const activeClaim = dashboard?.activeClaims.find(
          (c) => c.agent.role === role.name || c.agent.agentId.startsWith(role.name),
        );
        const platformColor = PLATFORM_COLORS[role.platform ?? "claude-code"] ?? theme.text;
        const output = monitor.agentOutputs.get(role.name);
        const lastLine = output && output.length > 0 ? (output[output.length - 1] ?? "") : "";

        let icon: string;
        let color: string;
        if (activeClaim) {
          icon = BRAILLE_SPINNER[monitor.spinnerFrame] ?? theme.agentRunning;
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
              {!expanded && lastLine ? (
                <text color={theme.muted}>{lastLine.slice(0, 80)}</text>
              ) : null}
            </box>
            {expanded && output && output.length > 0 ? (
              <box flexDirection="column" marginLeft={4} marginBottom={1}>
                {output.slice(-AGENT_OUTPUT_LINES).map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered output
                  <text key={i} color={theme.muted}>
                    {line.slice(0, 120)}
                  </text>
                ))}
              </box>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

/** Render the feed section including goal, frontier, ask_user alert, and contribution list. */
function renderFeedSection(
  feed: readonly Contribution[],
  cursor: number,
  goal: string | undefined,
  pendingAskUser: Contribution | undefined,
  frontier: DashboardData["frontierSummary"] | undefined,
  windowSize: number,
): React.ReactNode {
  // Dynamic windowing: center the cursor in the visible window
  const halfWindow = Math.floor(windowSize / 2);
  const windowStart = Math.max(0, Math.min(cursor - halfWindow, feed.length - windowSize));
  const windowEnd = Math.min(feed.length, windowStart + windowSize);

  return (
    <box flexDirection="column" flexGrow={1}>
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
          <EmptyState title="Waiting for contributions..." hint="Agents are working on your goal" />
        ) : (
          feed.slice(windowStart, windowEnd).map((c, i) => {
            const actualIndex = windowStart + i;
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
            const agentLabel = c.agent.role ?? c.agent.agentName ?? c.agent.agentId;

            const scoreEntries = Object.entries(c.scores ?? {});
            const artifactCount = Object.keys(c.artifacts ?? {}).length;
            const relationCount = (c.relations ?? []).length;
            const hasPreview =
              selected && (scoreEntries.length > 0 || artifactCount > 0 || relationCount > 0);

            return (
              <box key={c.cid} flexDirection="column">
                <box flexDirection="row" backgroundColor={selected ? theme.selectedBg : undefined}>
                  <text color={theme.dimmed}>{formatTime(c.createdAt)} </text>
                  <text color={kindColor}>{kindIcon} </text>
                  <text color={kindColor}>{c.kind.padEnd(12)}</text>
                  <text color={theme.info}>{agentLabel.padEnd(10)} </text>
                  <text color={selected ? theme.text : theme.muted}>{c.summary.slice(0, 55)}</text>
                </box>
                {hasPreview ? (
                  <box flexDirection="row" marginLeft={28}>
                    {scoreEntries.slice(0, 3).map(([name, score]) => (
                      <text key={name} color={theme.dimmed}>
                        {name}:{(score as { value: number }).value.toFixed(2)}{" "}
                      </text>
                    ))}
                    {artifactCount > 0 ? (
                      <text color={theme.dimmed}>
                        {artifactCount} file{artifactCount !== 1 ? "s" : ""}{" "}
                      </text>
                    ) : null}
                    {relationCount > 0 ? (
                      <text color={theme.dimmed}>
                        {relationCount} rel{relationCount !== 1 ? "s" : ""}{" "}
                      </text>
                    ) : null}
                    <text color={theme.dimmed}> Enter:detail</text>
                  </box>
                ) : null}
              </box>
            );
          })
        )}
      </box>
    </box>
  );
}

/** Panel rendering context — data needed by embedded views. */
interface PanelRenderContext {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly tmux?: import("../agents/tmux-manager.js").TmuxManager | undefined;
  readonly dashboard: DashboardData | undefined;
  readonly topology: AgentTopology | undefined;
  readonly monitor: ReturnType<typeof useAgentMonitor>;
  readonly cursor: number;
  readonly feed: readonly Contribution[];
}

/** Render the content of an expanded panel. */
function renderExpandedPanel(panel: RunningPanel, ctx: PanelRenderContext): React.ReactNode {
  switch (panel) {
    case RunningPanel.Feed:
      return renderFeedSection(
        ctx.feed,
        ctx.cursor,
        undefined,
        undefined,
        undefined,
        DEFAULT_FEED_WINDOW,
      );

    case RunningPanel.Agents:
      return (
        <AgentListView
          provider={ctx.provider}
          tmux={ctx.tmux}
          intervalMs={ctx.intervalMs}
          active={true}
          cursor={ctx.cursor}
        />
      );

    case RunningPanel.Dag:
      return (
        <DagView
          provider={ctx.provider}
          intervalMs={ctx.intervalMs}
          active={true}
          cursor={ctx.cursor}
        />
      );

    case RunningPanel.Terminal:
      return (
        <TerminalView
          tmux={ctx.tmux}
          intervalMs={ctx.intervalMs}
          active={true}
          mode={InputMode.Normal}
        />
      );
  }
}

/** Render bottom chrome: permissions, IPC, quit confirm, progress, prompt. */
function renderBottomChrome(
  monitor: ReturnType<typeof useAgentMonitor>,
  confirmQuit: boolean,
  targetMetric: TargetMetricInfo | undefined,
  currentBestScore: number | undefined,
  promptMode: boolean,
  promptText: string,
  promptTarget: number,
  activeRoles: readonly string[] | undefined,
): React.ReactNode {
  return (
    <>
      {/* Permission prompts from agents */}
      {monitor.pendingPermissions.length > 0 ? (
        <box
          flexDirection="column"
          marginX={2}
          borderStyle="single"
          borderColor={theme.warning}
          paddingX={1}
        >
          <text color={theme.warning} bold>
            Permission Request ({monitor.pendingPermissions.length})
          </text>
          {monitor.pendingPermissions.map((p) => (
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
      {monitor.ipcMessages.length > 0 ? (
        <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
          <text color={theme.dimmed} bold>
            IPC Messages
          </text>
          {monitor.ipcMessages.slice(-5).map((msg, i) => (
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

      {/* Progress bar */}
      {targetMetric && currentBestScore !== undefined ? (
        <ProgressBar
          label={targetMetric.metric}
          value={currentBestScore}
          target={targetMetric.value}
          direction={targetMetric.direction}
        />
      ) : null}

      {/* Prompt input */}
      {promptMode ? (
        <box flexDirection="row" paddingX={2}>
          <text color={theme.focus}>
            {"\u2192 "}
            {(activeRoles ?? [])[promptTarget % (activeRoles ?? []).length] ?? "agent"}
            {": "}
          </text>
          <text>{promptText}</text>
          <text color={theme.dimmed}>{"\u258c"}</text>
          <text color={theme.dimmed}> Tab:switch role Enter:send Esc:cancel</text>
        </box>
      ) : null}
    </>
  );
}

/** Render the help overlay. */
function renderHelpOverlay(): React.ReactNode {
  return (
    <box
      flexDirection="column"
      marginX={2}
      borderStyle="round"
      borderColor={theme.focus}
      paddingX={1}
    >
      <text color={theme.focus} bold>
        Keyboard Shortcuts
      </text>
      <text color={theme.text}> 1-4 Expand panel (Feed/Agents/DAG/Terminal)</text>
      <text color={theme.text}> f Toggle fullscreen (when panel expanded)</text>
      <text color={theme.text}> e Toggle agent output traces</text>
      <text color={theme.text}> j/k Scroll contribution feed</text>
      <text color={theme.text}> m / : Send message to agent</text>
      <text color={theme.text}> r Jump to ask_user question</text>
      <text color={theme.text}> Ctrl+F File browser (VFS)</text>
      <text color={theme.text}> Ctrl+A Advanced boardroom</text>
      <text color={theme.text}> y/n Approve/deny permission</text>
      <text color={theme.text}> ? Toggle this help</text>
      <text color={theme.text}> Esc Collapse panel / close overlay</text>
      <text color={theme.text}> q Quit (with confirmation)</text>
      <text color={theme.secondary}> Esc to close</text>
    </box>
  );
}

/** Render the status bar at the bottom of the view. */
function renderStatusBar(
  expandedPanel: RunningPanel | null,
  zoomLevel: "normal" | "half" | "full",
  elapsed: string,
  feedLength: number,
  claimCount: number,
  activeRoles: readonly string[] | undefined,
  hasAskUser: boolean,
): React.ReactNode {
  const panelIndicator =
    expandedPanel !== null
      ? ` [${RUNNING_PANEL_LABELS[expandedPanel]}${zoomLevel === "full" ? ":FULL" : ""}]`
      : "";

  return (
    <box flexDirection="row" paddingX={2}>
      <text color={theme.running}>[RUNNING {elapsed}]</text>
      {panelIndicator ? <text color={theme.focus}>{panelIndicator}</text> : null}
      <text color={theme.secondary}>
        {" "}
        {feedLength} contribs | {claimCount} active
      </text>
      <text color={theme.secondary}>
        {" "}
        1-4:panels{expandedPanel !== null ? " f:full" : ""} e:traces{" "}
        {(activeRoles ?? []).length > 0 ? "m:message " : ""}?:help
        {hasAskUser ? " r:respond" : ""} q:quit
      </text>
    </box>
  );
}
