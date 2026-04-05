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
import { useDialog } from "@opentui-ui/dialog/react";
import { toast } from "@opentui-ui/toast/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventBus } from "../../core/event-bus.js";
import type { Contribution } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { EmptyState } from "../components/empty-state.js";
import { ProgressBar } from "../components/progress-bar.js";
import type { AgentLogBuffer } from "../data/agent-log-buffer.js";
import { debugLog } from "../debug-log.js";
import { useAgentMonitor } from "../hooks/use-agent-monitor.js";
import { InputMode } from "../hooks/use-panel-focus.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { useTuiStatePersistence } from "../hooks/use-session-persistence.js";
import type { DashboardData, TuiDataProvider } from "../provider.js";
import { isVfsProvider } from "../provider.js";
import { agentStatusIcon, KIND_ICONS, PLATFORM_COLORS, theme } from "../theme.js";
import { AgentListView } from "../views/agent-list.js";
import { DagView } from "../views/dag.js";
import { HandoffsView } from "../views/handoffs-view.js";
import { TerminalView } from "../views/terminal.js";
import { TracePane } from "../views/trace-pane.js";
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
  /** Per-agent log buffers for the Trace panel. Keyed by role name. */
  readonly logBuffers?: ReadonlyMap<string, AgentLogBuffer> | undefined;
  readonly onToggleAdvanced: () => void;
  readonly onComplete: (reason: string) => void;
  readonly onQuit: () => void;
  /** Return to the preset-select / main screen. */
  readonly onBackToMain?: (() => void) | undefined;
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
    sessionId,
    sessionStartedAt,
    tmux,
    eventBus,
    targetMetric,
    groveDir,
    onNewContribution,
    onSendToAgent,
    activeRoles,
    logBuffers,
    onToggleAdvanced,
    onComplete: _onComplete,
    onQuit,
    onBackToMain,
  }: RunningViewProps): React.ReactNode {
    // ─── Dialog ───
    const dialog = useDialog();

    // ─── Session state persistence (restore on resume) ───
    const { savedState, saveState: persistViewState } = useTuiStatePersistence(sessionId, groveDir);

    // ─── Panel state ───
    const [expandedPanel, setExpandedPanel] = useState<RunningPanel | null>(
      () => savedState?.expandedPanel ?? null,
    );
    const [zoomLevel, setZoomLevel] = useState<"normal" | "half" | "full">(
      () => savedState?.zoomLevel ?? "normal",
    );

    // ─── Trace pane state ───
    const [traceSelectedAgent, setTraceSelectedAgent] = useState(
      () => savedState?.traceSelectedAgent ?? 0,
    );
    const [traceScrollOffset, setTraceScrollOffset] = useState(0);

    // ─── Overlay state ───
    const [showVfs, setShowVfs] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [confirmQuit, setConfirmQuit] = useState(false);

    // ─── VFS navigation state ───
    const [vfsCursor, setVfsCursor] = useState(0);
    const [vfsNavTrigger, setVfsNavTrigger] = useState(0);

    // ─── Prompt state ───
    const [promptMode, setPromptMode] = useState(false);
    const [promptText, setPromptText] = useState("");
    const [promptTarget, setPromptTarget] = useState(0);

    // ─── Feed state ───
    const [cursor, setCursor] = useState(0);
    const [autoFollow, setAutoFollow] = useState(true);
    const [newSinceFreeze, setNewSinceFreeze] = useState(0);
    const prevFeedLengthRef = React.useRef(0);

    // ─── Restore saved state once it loads (async) ───
    const restoredRef = useRef(false);
    useEffect(() => {
      if (savedState == null || restoredRef.current) return;
      restoredRef.current = true;
      if (savedState.expandedPanel !== undefined)
        setExpandedPanel(savedState.expandedPanel ?? null);
      if (savedState.zoomLevel !== undefined) setZoomLevel(savedState.zoomLevel);
      if (savedState.traceSelectedAgent !== undefined)
        setTraceSelectedAgent(savedState.traceSelectedAgent);
    }, [savedState]);

    // ─── Persist view state on changes (debounced via hook) ───
    useEffect(() => {
      persistViewState({ expandedPanel, zoomLevel, traceSelectedAgent });
    }, [expandedPanel, zoomLevel, traceSelectedAgent, persistViewState]);

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

    // Toast for permission requests
    const prevPermCountRef = useRef(0);
    useEffect(() => {
      const count = monitor.pendingPermissions.length;
      if (count > prevPermCountRef.current && count > 0) {
        const perm = monitor.pendingPermissions[0];
        if (perm) {
          toast.warning(`${perm.agentRole}: permission needed`, { duration: 5000 });
        }
      }
      prevPermCountRef.current = count;
    }, [monitor.pendingPermissions]);

    // ─── Data fetching ───
    const dashboardFetcher = useCallback(() => provider.getDashboard(), [provider]);
    const fetchCountRef = React.useRef(0);
    const contributionsFetcher = useCallback(async () => {
      fetchCountRef.current++;
      const result = await provider.getContributions({ limit: 100 });
      if (
        fetchCountRef.current <= 5 ||
        fetchCountRef.current % 20 === 0 ||
        (result && result.length > 0)
      ) {
        debugLog(
          "poll",
          `fetch #${fetchCountRef.current} returned ${result?.length ?? 0} contributions`,
        );
      }
      return result;
    }, [provider]);

    // Gate polling: pause contributions when panel is fullscreen and not showing feed
    const feedActive =
      zoomLevel !== "full" || expandedPanel === RunningPanel.Feed || expandedPanel === null;
    const dashboardPoll = usePolledData<DashboardData>(dashboardFetcher, intervalMs, true);
    const contributionsPoll = usePolledData<readonly Contribution[]>(
      contributionsFetcher,
      intervalMs,
      feedActive,
    );

    // NOTE: usePolledData's setInterval doesn't work in OpenTUI because the
    // RunningView component unmounts/remounts during screen transitions, killing
    // all React effect timers. Contribution polling is handled outside React
    // by SpawnManager.startContributionPolling() which uses a class-level timer.

    // When EventBus fires (SSE push from Nexus), trigger immediate re-fetch
    useEffect(() => {
      debugLog("eventBus", `exists=${!!eventBus}`);
      if (!eventBus) return;
      const handler = () => {
        debugLog("eventBus", "SSE event received — refreshing polls");
        dashboardPoll.refresh();
        contributionsPoll.refresh();
      };
      eventBus.subscribe("system", handler);
      return () => eventBus.unsubscribe("system", handler);
    }, [eventBus, dashboardPoll.refresh, contributionsPoll.refresh]);

    const dashboard = dashboardPoll.data ?? undefined;
    const contributions = contributionsPoll.data;

    // Filter contributions to current session scope
    const allContributions = contributions ?? [];
    const feed = sessionStartedAt
      ? allContributions.filter((c) => c.createdAt >= sessionStartedAt)
      : allContributions;

    // Debug: log feed state periodically
    const feedDebugRef = React.useRef(0);
    useEffect(() => {
      feedDebugRef.current++;
      if (feedDebugRef.current <= 3 || feedDebugRef.current % 20 === 0) {
        debugLog(
          "feed",
          `#${feedDebugRef.current} allContribs=${allContributions.length} feed=${feed.length} feedActive=${feedActive} sessionStartedAt=${sessionStartedAt ?? "none"}`,
        );
      }
    }, [allContributions.length, feed.length, feedActive, sessionStartedAt]);

    // ─── Auto-follow: keep cursor at bottom when new items arrive ───
    useEffect(() => {
      const prev = prevFeedLengthRef.current;
      const curr = feed.length;
      prevFeedLengthRef.current = curr;
      if (curr === prev) return;
      if (autoFollow) {
        setCursor(Math.max(0, curr - 1));
      } else {
        setNewSinceFreeze((n) => n + (curr - prev));
      }
    }, [feed.length, autoFollow]);

    // Track seen contribution CIDs and route new ones to downstream agents
    const seenCidsRef = React.useRef<Set<string>>(new Set());
    const initialSeededRef = React.useRef(false);
    useEffect(() => {
      if (!onNewContribution || !feed.length) return;

      if (!initialSeededRef.current && !sessionStartedAt) {
        debugLog("seenCids", `seeding ${feed.length} existing CIDs (no sessionStartedAt)`);
        for (const c of feed) {
          seenCidsRef.current.add(c.cid);
        }
        initialSeededRef.current = true;
        return;
      }
      initialSeededRef.current = true;

      for (const c of feed) {
        if (!seenCidsRef.current.has(c.cid)) {
          debugLog(
            "seenCids",
            `NEW CID detected: ${c.cid.slice(0, 20)} kind=${c.kind} role=${c.agent?.role}`,
          );
          seenCidsRef.current.add(c.cid);
          onNewContribution(c);
          // Toast notification for new contributions
          const role = c.agent.role ?? c.agent.agentName ?? "agent";
          if (c.kind === "ask_user") {
            toast.warning(`${role}: question pending`, { duration: 5000 });
          } else {
            toast.info(`${role}: ${c.kind}`, { duration: 3000 });
          }
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
        feedCursorUp: () => {
          setAutoFollow(false);
          setCursor((c) => Math.max(c - 1, 0));
        },
        feedScrollToBottom: () => {
          setAutoFollow(true);
          setNewSinceFreeze(0);
          setCursor(Math.max(0, feed.length - 1));
        },
        scrollToAskUser: () => {
          const askIdx = feed.findIndex((c) => c.kind === "ask_user");
          if (askIdx >= 0) setCursor(askIdx);
        },
        // Trace pane actions
        traceSelectDown: () => {
          const roleCount = (topology?.roles ?? []).length;
          setTraceSelectedAgent((a) => Math.min(a + 1, Math.max(0, roleCount - 1)));
          setTraceScrollOffset(0); // reset scroll when changing agent
        },
        traceSelectUp: () => {
          setTraceSelectedAgent((a) => Math.max(a - 1, 0));
          setTraceScrollOffset(0);
        },
        traceScrollDown: () => setTraceScrollOffset((o) => Math.max(o - 1, 0)),
        traceScrollUp: () => setTraceScrollOffset((o) => o + 1),
        traceScrollToBottom: () => setTraceScrollOffset(0),
        traceScrollToTop: () => setTraceScrollOffset(Number.MAX_SAFE_INTEGER),
        traceCycleAgent: () => {
          const roleCount = (topology?.roles ?? []).length;
          setTraceSelectedAgent((a) => (a + 1) % Math.max(1, roleCount));
          setTraceScrollOffset(0);
        },
        openDetail: () => onToggleAdvanced(),
        toggleAdvanced: () => onToggleAdvanced(),
        quit: () => onQuit(),
        showQuitDialog: () => {
          if (onBackToMain) {
            void dialog
              .choice({
                title: "Leave Session",
                message: "Agents will be stopped.",
                choices: ["Quit", "Back to main", "Cancel"],
              })
              .then((choice) => {
                if (choice === "Quit") onQuit();
                else if (choice === "Back to main") onBackToMain();
              });
          } else {
            void dialog
              .confirm({ title: "Quit Session?", message: "Agents will be stopped." })
              .then((confirmed) => {
                if (confirmed) onQuit();
              });
          }
        },
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
        onBackToMain,
        monitor.pendingPermissions,
        tmux,
        pendingAskUser,
        topology,
        dialog,
      ],
    );

    useKeyboard(
      useCallback(
        (key) => {
          // VFS overlay intercepts navigation keys
          if (showVfs) {
            if (key.name === "j" || key.name === "down") {
              setVfsCursor((c) => c + 1); // clamped by VfsBrowserView via allEntries.length
              return;
            }
            if (key.name === "k" || key.name === "up") {
              setVfsCursor((c) => Math.max(c - 1, 0));
              return;
            }
            if (key.name === "return") {
              setVfsNavTrigger((t) => t + 1);
              setVfsCursor(0); // reset cursor when navigating into a directory
              return;
            }
            if (key.name === "escape") {
              setShowVfs(false);
              return;
            }
          }
          routeRunningKey(key, keyboardState, keyboardActions);
        },
        [showVfs, keyboardState, keyboardActions],
      ),
    );

    // ─── Derived data ───
    const claimCount = dashboard?.activeClaims.length ?? 0;
    // Session-scoped frontier: when session is active, compute from session feed
    const sessionFrontier: DashboardData["frontierSummary"] | undefined = useMemo(() => {
      if (!sessionStartedAt || feed.length === 0) return undefined;
      // Find the latest contribution per metric for session-local view
      const byMetric = new Map<string, { cid: string; summary: string; value: number }>();
      for (const c of feed) {
        if (c.scores) {
          for (const [name, s] of Object.entries(c.scores)) {
            const current = byMetric.get(name);
            if (current === undefined || s.value > current.value) {
              byMetric.set(name, { cid: c.cid, summary: c.summary, value: s.value });
            }
          }
        }
      }
      if (byMetric.size === 0) return undefined;
      return {
        topByMetric: [...byMetric.entries()].map(([metric, entry]) => ({
          metric,
          cid: entry.cid,
          summary: entry.summary,
          value: entry.value,
        })),
        topByAdoption: [],
      };
    }, [feed, sessionStartedAt]);
    const frontier = sessionFrontier ?? dashboard?.frontierSummary;
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
                cursor={vfsCursor}
                navigateTrigger={vfsNavTrigger}
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

    // Tab bar options (shared between feed-only and half-screen views)
    const tabOptions = [
      { name: "Feed", description: "1" },
      { name: "Agents", description: "2" },
      { name: "DAG", description: "3" },
      { name: "Terminal", description: "4" },
      { name: "Traces", description: "e" },
    ];
    const tabSelectedIndex = expandedPanel !== null ? expandedPanel : 0;

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
            autoFollow,
            newSinceFreeze,
            logBuffers,
            traceSelectedAgent,
            traceScrollOffset,
            sessionStartedAt,
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
          {/* Tab bar — visual indicator of active panel */}
          <tab-select
            focused={false}
            options={tabOptions}
            selectedIndex={tabSelectedIndex}
            showDescription={true}
            showUnderline={true}
          />
          <box flexDirection="row" flexGrow={1}>
            {/* Left: feed column */}
            <box flexDirection="column" flexGrow={1} flexBasis="50%">
              {renderFeedSection(
                feed,
                cursor,
                goal,
                pendingAskUser,
                frontier,
                autoFollow,
                newSinceFreeze,
              )}
            </box>
            {/* Right: expanded panel */}
            <box
              flexDirection="column"
              flexGrow={1}
              flexBasis="50%"
              borderStyle="round"
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
                autoFollow,
                newSinceFreeze,
                logBuffers,
                traceSelectedAgent,
                traceScrollOffset,
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
        {/* Tab bar — visual indicator of active panel (keyboard 1-4/e) */}
        <tab-select
          focused={false}
          options={tabOptions}
          selectedIndex={tabSelectedIndex}
          showDescription={true}
          showUnderline={true}
        />

        {/* Agent status with live output */}
        {renderAgentSection(topology, dashboard, monitor, sessionStartedAt, feed.length)}

        {/* Main feed area */}
        {renderFeedSection(
          feed,
          cursor,
          goal,
          pendingAskUser,
          frontier,
          autoFollow,
          newSinceFreeze,
        )}

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

/** Render the agent status section (compact — press e for trace viewer). */
function renderAgentSection(
  topology: AgentTopology | undefined,
  dashboard: DashboardData | undefined,
  monitor: ReturnType<typeof useAgentMonitor>,
  sessionStartedAt?: string,
  sessionContribCount?: number,
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
  // When session is active but has no contributions yet, show waiting message
  const showWaiting = sessionStartedAt !== undefined && (sessionContribCount ?? 0) === 0;
  return (
    <box flexDirection="column" paddingX={2} paddingTop={1}>
      <box flexDirection="row">
        <text color={theme.focus} bold>
          Agents
        </text>
        <text color={theme.dimmed}> (e:trace viewer)</text>
        {showWaiting && <text color={theme.warning}> waiting for session activity...</text>}
      </box>
      {roles.map((role, idx) => {
        const activeClaim = dashboard?.activeClaims.find(
          (c) => c.agent.role === role.name || c.agent.agentId.startsWith(role.name),
        );
        const platformColor = PLATFORM_COLORS[role.platform ?? "claude-code"] ?? theme.text;
        const output = monitor.agentOutputs.get(role.name);
        const lastLine = output && output.length > 0 ? (output[output.length - 1] ?? "") : "";

        const status = activeClaim ? "running" : "idle";
        const badge = agentStatusIcon(status, activeClaim ? monitor.spinnerFrame : undefined);

        return (
          <box key={role.name} flexDirection="row">
            <text color={badge.color}>{badge.icon} </text>
            <text color={platformColor} bold>
              {role.name}
            </text>
            <text color={theme.dimmed}> [{idx + 1}] </text>
            {lastLine ? <text color={theme.muted}>{lastLine.slice(0, 80)}</text> : null}
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
  autoFollow: boolean,
  newSinceFreeze: number,
): React.ReactNode {
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
        borderStyle="round"
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
          (() => {
            // Explicit windowing: keep cursor visible within a viewport-sized window
            const WINDOW_SIZE = Math.max(10, (process.stdout.rows ?? 40) - 15);
            const halfWindow = Math.floor(WINDOW_SIZE / 2);
            const windowStart = Math.max(
              0,
              Math.min(cursor - halfWindow, feed.length - WINDOW_SIZE),
            );
            const windowEnd = Math.min(feed.length, windowStart + WINDOW_SIZE);
            return feed.slice(windowStart, windowEnd).map((c, i) => {
              const actualIndex = windowStart + i;
              const selected = actualIndex === cursor;
              const KIND_COLORS: Record<string, string> = {
                work: theme.work,
                review: theme.review,
                discussion: theme.discussion,
                adoption: theme.adoption,
                reproduction: theme.reproduction,
                ask_user: theme.warning,
                response: theme.info,
                plan: theme.secondary,
              };
              const kindColor = KIND_COLORS[c.kind] ?? theme.text;
              const kindIcon = KIND_ICONS[c.kind] ?? "\u25a0";
              const agentLabel = c.agent.role ?? c.agent.agentName ?? c.agent.agentId;

              const scoreEntries = Object.entries(c.scores ?? {});
              const artifactCount = Object.keys(c.artifacts ?? {}).length;
              const relationCount = (c.relations ?? []).length;
              const hasPreview =
                selected && (scoreEntries.length > 0 || artifactCount > 0 || relationCount > 0);

              return (
                <box key={c.cid} flexDirection="column">
                  <box
                    flexDirection="row"
                    backgroundColor={selected ? theme.selectedBg : undefined}
                  >
                    <text color={kindColor}>{"\u2502"}</text>
                    <text color={theme.dimmed}>{formatTime(c.createdAt)} </text>
                    <text color={kindColor}>{kindIcon} </text>
                    <text color={kindColor}>{c.kind.padEnd(12)}</text>
                    <text color={theme.info}>{agentLabel.padEnd(10)} </text>
                    <text color={selected ? theme.text : theme.muted}>
                      {c.summary.slice(0, 55)}
                    </text>
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
            });
          })()
        )}

        {/* Auto-scroll frozen badge */}
        {!autoFollow && newSinceFreeze > 0 ? (
          <box paddingX={1}>
            <text color={theme.warning}>{newSinceFreeze} new — G:jump to latest</text>
          </box>
        ) : null}
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
  readonly autoFollow: boolean;
  readonly newSinceFreeze: number;
  readonly logBuffers?: ReadonlyMap<string, AgentLogBuffer> | undefined;
  readonly traceSelectedAgent?: number;
  readonly traceScrollOffset?: number;
  readonly sessionStartedAt?: string | undefined;
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
        ctx.autoFollow,
        ctx.newSinceFreeze,
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

    case RunningPanel.Trace: {
      const roles = (ctx.topology?.roles ?? []).map((r) => r.name);
      const agentStatuses = new Map<string, string>();
      for (const role of ctx.topology?.roles ?? []) {
        const hasClaim = ctx.dashboard?.activeClaims.some(
          (c) => c.agent.role === role.name || c.agent.agentId.startsWith(role.name),
        );
        agentStatuses.set(role.name, hasClaim ? "running" : "idle");
      }
      return (
        <TracePane
          buffers={ctx.logBuffers ?? new Map()}
          roles={roles}
          agentStatuses={agentStatuses}
          spinnerFrame={ctx.monitor.spinnerFrame}
          selectedAgent={ctx.traceSelectedAgent ?? 0}
          traceScrollOffset={ctx.traceScrollOffset ?? 0}
        />
      );
    }
    case RunningPanel.Handoffs:
      return (
        <HandoffsView
          provider={ctx.provider}
          intervalMs={ctx.intervalMs}
          active
          cursor={0}
          sessionStartedAt={ctx.sessionStartedAt}
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
          borderStyle="round"
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

      {/* Quit confirmation (legacy fallback — primary flow uses dialog) */}
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
      <text color={theme.text}> e Open trace viewer (split-pane agent output)</text>
      <text color={theme.text}> j/k Navigate (feed or trace agent list)</text>
      <text color={theme.text}> J/K Scroll trace output (when trace open)</text>
      <text color={theme.text}> G/g Jump to bottom/top of trace</text>
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

/** Build contextual keybinding hints based on current state. */
function contextualHints(
  expandedPanel: RunningPanel | null,
  zoomLevel: "normal" | "half" | "full",
  activeRoles: readonly string[] | undefined,
  hasAskUser: boolean,
): string {
  const hints: string[] = [];

  if (expandedPanel === null) {
    // Default feed view
    hints.push("1-5:panels", "e:traces", "j/k:nav");
  } else if (expandedPanel === RunningPanel.Trace) {
    // Trace pane active
    hints.push("j/k:agent", "J/K:scroll", "G/g:top/bottom", "Tab:cycle");
    if (zoomLevel !== "full") hints.push("f:full");
    hints.push("Esc:close");
  } else {
    // Panel expanded
    if (zoomLevel !== "full") hints.push("f:full");
    hints.push("Esc:close");
  }

  if ((activeRoles ?? []).length > 0) hints.push("m:msg");
  if (hasAskUser) hints.push("r:respond");
  hints.push("?:help", "q:quit");

  return hints.join(" ");
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
        {feedLength}c | {claimCount} active
      </text>
      <text color={theme.secondary}>
        {" "}
        {contextualHints(expandedPanel, zoomLevel, activeRoles, hasAskUser)}
      </text>
    </box>
  );
}
