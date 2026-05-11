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

import { dirname } from "node:path";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "@opentui-ui/dialog/react";
import { toast } from "@opentui-ui/toast/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContributionEntity } from "../../core/entity.js";
import type { EventBus } from "../../core/event-bus.js";
import type { Handoff } from "../../core/handoff.js";
import type { Contribution } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { useInterval } from "../../local/use-interval.js";
import { compareTimestampsAscNewestLast, compareTimestampsDesc } from "../../shared/format.js";
import { EmptyState } from "../components/empty-state.js";
import { FlashBar } from "../components/flash-bar.js";
import { ProgressBar } from "../components/progress-bar.js";
import { Prompt } from "../components/prompt.js";
import type { AgentLogBuffer } from "../data/agent-log-buffer.js";
import { type AliasMap, DEFAULT_ALIASES, matchAliases, resolveAlias } from "../data/aliases.js";
import { loadAliases } from "../data/aliases-loader.js";
import { debugLog } from "../debug-log.js";
import { useEntityWatchEnabled } from "../hooks/informer-context.js";
import { useAgentMonitor } from "../hooks/use-agent-monitor.js";
import { useEntities } from "../hooks/use-entities.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import { InputMode } from "../hooks/use-panel-focus.js";
import { usePagesStoreFromContext, useScreenStack } from "../hooks/use-screen-stack.js";
import { useTuiStatePersistence } from "../hooks/use-session-persistence.js";
import type { DashboardData, TuiDataProvider } from "../provider.js";
import { isHandoffProvider, isVfsProvider } from "../provider.js";
import { agentStatusIcon, KIND_ICONS, PLATFORM_COLORS, theme } from "../theme.js";
import { AgentListView } from "../views/agent-list.js";
import { DagView } from "../views/dag.js";
import { HandoffsView } from "../views/handoffs-view.js";
import { TerminalView } from "../views/terminal.js";
import { TracePane } from "../views/trace-pane.js";
import { VfsBrowserView } from "../views/vfs-browser.js";
import {
  type CmdModeState,
  appendChar as cmdAppend,
  deleteChar as cmdDelete,
  cycleSuggestion,
  enterFilter,
  enterGoto,
  exitCmdMode,
  initialCmdState,
} from "./running-cmd-mode.js";
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

/** Cap on the contribution projection from the informer cache for the feed.
 *  The visible window is much smaller, but a large cache would sort + map
 *  every entity on each recompute and freeze the TUI. 500 leaves comfortable
 *  headroom for scrollback while bounding worst-case work. */
const FEED_PROJECTION_CAP = 500;

/** Project a ContributionEntity to the flat shape running-view's feed and
 *  toast routing read. Mirrors entityToContribution helpers in the
 *  PR2-migrated views. */
function entityToContribution(e: ContributionEntity): Contribution {
  return {
    cid: e.id,
    manifestVersion: 0,
    kind: e.spec.contributionKind,
    mode: e.spec.mode,
    summary: e.spec.summary,
    description: e.spec.description,
    artifacts: e.spec.artifacts,
    relations: e.spec.relations,
    scores: e.spec.scores,
    tags: e.spec.tags,
    context: e.spec.context,
    agent: e.spec.agent,
    createdAt: e.metadata.creationTimestamp ?? "",
  };
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

    // ─── C2 cmd-mode state (#302) ───
    // React state drives rendering; refs mirror the latest values so the
    // keyboard router reads them synchronously inside a single tick. Without
    // refs, fast keystroke bursts (paste, scripted input) race React's
    // re-render: the second key sees stale `cmdMode='none'` and falls through
    // to the normal-mode handler.
    const [cmdState, setCmdStateRaw] = useState<CmdModeState>(initialCmdState);
    const cmdStateRef = useRef<CmdModeState>(initialCmdState);
    const setCmdState = useCallback((next: CmdModeState | ((s: CmdModeState) => CmdModeState)) => {
      cmdStateRef.current = typeof next === "function" ? next(cmdStateRef.current) : next;
      setCmdStateRaw(cmdStateRef.current);
    }, []);

    const [aliases, setAliases] = useState<AliasMap>(DEFAULT_ALIASES);
    const [flashError, setFlashError] = useState<string | null>(null);

    const [filterQuery, setFilterQueryRaw] = useState<string>("");
    const filterQueryRef = useRef<string>("");
    const setFilterQuery = useCallback((next: string) => {
      filterQueryRef.current = next;
      setFilterQueryRaw(next);
    }, []);

    const flash = useCallback((msg: string, ms = 3000) => {
      setFlashError(msg);
      setTimeout(() => setFlashError((current) => (current === msg ? null : current)), ms);
    }, []);

    useEffect(() => {
      if (!groveDir) return;
      let cancelled = false;
      // `groveDir` prop is the resolved `.grove/` directory (per resolveGroveDir);
      // loadAliases expects the project root and joins `.grove/aliases.yaml` itself.
      const projectRoot = dirname(groveDir);
      void loadAliases(projectRoot).then((r) => {
        if (cancelled) return;
        setAliases(r.aliases);
        if (r.errors.length > 0) {
          const first = r.errors[0];
          if (first) flash(first);
        }
      });
      return () => {
        cancelled = true;
      };
    }, [groveDir, flash]);

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

    // ─── PagesStore wiring (#303): goto pushes panel pages, top→expandedPanel sync ───
    // The store is created once at screen-manager mount and supplied via context.
    // Each :a/:s/:d/:t/:r entry pushes a panel page; the sync effect below mirrors
    // the visible top page back into local expandedPanel/zoomLevel state so the
    // existing panel-render logic remains unchanged. Esc on a panel page pops
    // the stack (handled in the useKeyboard short-circuit further below).
    const pagesStore = usePagesStoreFromContext();
    const { top: pagesTop } = useScreenStack(pagesStore);

    // ─── Dirty-check: prompt-mode (#303) ───
    // Registers a dirty check while prompt mode is active so hasDirtyTop()
    // returns true when the user has typed something into the prompt bar.
    useEffect(() => {
      if (!promptMode) return;
      return pagesStore.registerDirtyCheck("running", () => promptText.trim().length > 0);
    }, [pagesStore, promptMode, promptText]);

    // Mirror the latest zoomLevel into a ref so the sync effect can read it
    // without listing it in the dep array (which would re-fire the mapping
    // every time the zoom changes — defeating the lastAppliedTopRef guard).
    const zoomLevelRef = useRef(zoomLevel);
    useEffect(() => {
      zoomLevelRef.current = zoomLevel;
    }, [zoomLevel]);

    // Track the last-applied top page (by identity) so the effect is idempotent
    // even when expandedPanel/zoomLevel changes for unrelated reasons (1-9 keys,
    // panel toggles). Without this, every state change would re-run the mapping.
    const lastAppliedTopRef = useRef<typeof pagesTop>(undefined);
    useEffect(() => {
      if (lastAppliedTopRef.current === pagesTop) return;
      lastAppliedTopRef.current = pagesTop;
      if (!pagesTop) return;
      if (pagesTop.kind === "panel") {
        const panel = pagesTop.params?.panel ?? "";
        const map: Record<string, RunningPanel> = {
          agents: RunningPanel.Agents,
          sessions: RunningPanel.Sessions,
          dag: RunningPanel.Dag,
          tasks: RunningPanel.Tasks,
          reviews: RunningPanel.Reviews,
          feed: RunningPanel.Feed,
        };
        const target = map[panel];
        if (target !== undefined) {
          setExpandedPanel((cur) => {
            const next = expandPanelTransition(cur, zoomLevelRef.current, target);
            setZoomLevel(next.zoomLevel);
            return next.expandedPanel;
          });
        }
      } else if (pagesTop.kind === "running") {
        // Back at the bottom of the stack — clear panel zoom.
        setExpandedPanel(null);
        setZoomLevel("normal");
      }
    }, [pagesTop]);

    // ─── Elapsed timer ───
    const [elapsed, setElapsed] = useState("0s");
    const start = useMemo(
      () => (sessionStartedAt ? new Date(sessionStartedAt).getTime() : Date.now()),
      [sessionStartedAt],
    );
    const tickElapsed = useCallback(() => {
      const ms = Date.now() - start;
      const m = Math.floor(ms / 60_000);
      const s = Math.floor((ms % 60_000) / 1_000);
      setElapsed(m > 0 ? `${m}m${s}s` : `${s}s`);
    }, [start]);
    useEffect(() => {
      tickElapsed();
    }, [tickElapsed]);
    useInterval(tickElapsed, 1000);

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
    // PR3 (#389): the contribution feed migrates to the Contribution
    // informer when available. The dashboard itself (metadata, claims with
    // lease-aware expiry, frontierSummary) remains polled — claim activity
    // expires on wall-clock and frontier needs server compute, neither of
    // which the watch protocol covers.
    //
    // Honor the session scope gate: in scoped sessions we keep the polled
    // path because /api/list and /api/watch are still namespace-global —
    // the EntityStore would seed with all sessions' rows on init and admit
    // foreign-session writes via the watch fan-out. The session-time
    // creationTimestamp filter is not equivalent to real session membership
    // (it drops pre-existing rows from the same session and lets in
    // parallel-session rows committed after start). Revisit when the watch
    // protocol carries sessionId end-to-end.
    const useContribInformer = useEntityWatchEnabled(provider, "Contribution");
    const contribEntities = useEntities("Contribution");

    const dashboardFetcher = useCallback(() => provider.getDashboard(), [provider]);
    const fetchCountRef = React.useRef(0);
    const contributionsFetcher = useCallback(async () => {
      fetchCountRef.current++;
      const result = await provider.getContributions();
      debugLog("feed.fetch", `total=${result?.length ?? 0}`);
      if (fetchCountRef.current <= 5 || fetchCountRef.current % 20 === 0) {
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
    // Only switch to informer data after it has synced and is healthy. Cold
    // start or terminal watch failure must keep the polled fallback alive,
    // otherwise the feed renders empty even though `getContributions()` would
    // still return data.
    const contribInformerReady =
      useContribInformer && contribEntities.hasSynced && !contribEntities.error;
    const dashboardPoll = useEventDrivenData<DashboardData>(
      dashboardFetcher,
      undefined,
      undefined,
      true,
    );
    const contributionsPoll = useEventDrivenData<readonly Contribution[]>(
      contributionsFetcher,
      undefined,
      undefined,
      feedActive && !contribInformerReady,
    );

    // The polled fetcher is only used for UI refresh of the contributions feed display;
    // agent-to-agent contribution delivery is done via NexusWsBridge SSE push,
    // not via polling. The eventBus handler below drives immediate UI refresh
    // when a push arrives.

    // When EventBus fires (SSE push from Nexus), trigger immediate re-fetch.
    //
    // LocalEventBus fans out by `role:<targetRole>` channel, and NexusWsBridge
    // publishes contribution events with `targetRole` set to the role that
    // received the inbox delivery (coder / reviewer / …). Subscribing to a
    // sentinel channel like "system" never receives anything, which is how
    // the feed silently stopped refreshing on push in live sessions — the
    // per-poll interval was the only refresh path.
    //
    // ScreenManager renders RunningView OUTSIDE App's RefreshContext
    // provider (advanced/boardroom mode is a different screen state),
    // so useRefreshSignal does nothing here. Subscribe directly to the
    // EventBus so SSE pushes refresh the feed/dashboard immediately.
    useEffect(() => {
      if (!eventBus) return;
      const roles = topology?.roles.map((r) => r.name) ?? [];
      if (roles.length === 0) return;
      const handler = () => {
        const p = provider as { invalidateCaches?: () => void };
        p.invalidateCaches?.();
        dashboardPoll.refresh();
        contributionsPoll.refresh();
      };
      for (const role of roles) eventBus.subscribe(role, handler);
      return () => {
        for (const role of roles) eventBus.unsubscribe(role, handler);
      };
    }, [eventBus, topology, provider, dashboardPoll.refresh, contributionsPoll.refresh]);

    const dashboard = dashboardPoll.data ?? undefined;
    const contributions = useMemo<readonly Contribution[] | undefined>(() => {
      if (!contribInformerReady) return contributionsPoll.data ?? undefined;
      // Time-based session scope. The watch protocol does not yet filter
      // by sessionId server-side, so the EntityStore cache may contain
      // contributions from prior/parallel sessions in the same namespace.
      // Filter to entries created at-or-after the current session start to
      // match the polled provider.getContributions() semantics, which the
      // TUI provider scopes server-side via setSessionScope. Without this
      // filter, switching to the EntityStore path in a scoped session
      // would surface other-session contributions in the feed.
      const all = contribEntities.data;
      const cutoffMs = sessionStartedAt ? new Date(sessionStartedAt).getTime() : 0;
      const scoped =
        cutoffMs > 0
          ? all.filter((c) => {
              const t = Date.parse(c.metadata.creationTimestamp ?? "");
              return Number.isFinite(t) && t >= cutoffMs;
            })
          : all;
      // Cap the projection BEFORE sort/map. A large informer cache (e.g.
      // after a relist on a long-running Grove) would otherwise sort + map
      // every entity on each recompute, freezing the TUI even though the
      // visible feed only shows a window. Take the newest FEED_PROJECTION_CAP
      // by createdAt, then re-sort ASCENDING so the feed's auto-follow
      // (`feed.length - 1`) lands on the newest row, matching the polled
      // `getContributions()` order.
      // DESC chronological for the cap (invalid-last so bad timestamps
      // don't displace real recent contributions); ASC for the final feed
      // order so auto-follow lands on the newest tail.
      let pool: readonly ContributionEntity[] = scoped;
      if (scoped.length > FEED_PROJECTION_CAP) {
        pool = [...scoped]
          .sort((a, b) =>
            compareTimestampsDesc(a.metadata.creationTimestamp, b.metadata.creationTimestamp),
          )
          .slice(0, FEED_PROJECTION_CAP);
      }
      // Final ASC for the feed: invalid sorts FIRST so the tail is always
      // the newest VALID timestamp (auto-follow targets feed.length - 1).
      const sorted = [...pool].sort((a, b) =>
        compareTimestampsAscNewestLast(a.metadata.creationTimestamp, b.metadata.creationTimestamp),
      );
      return sorted.map(entityToContribution);
    }, [contribInformerReady, contribEntities.data, contributionsPoll.data, sessionStartedAt]);
    // Session scoping is handled server-side (provider.setSessionScope).
    // The feed already contains only this session's contributions.
    const feed = contributions ?? [];

    // Aggregate poll health for the status bar: show stale/error when either
    // path is unhealthy. Informer error always surfaces (even when we're still
    // polling as fallback) so operators see watch-pipeline failures.
    const pollHealth = useMemo(() => {
      const contribStale = contribInformerReady ? false : contributionsPoll.isStale;
      const contribError =
        contribEntities.error?.message ??
        (contribInformerReady ? undefined : contributionsPoll.error?.message);
      const isStale = dashboardPoll.isStale || contribStale;
      const error = dashboardPoll.error?.message ?? contribError ?? undefined;
      return { isStale, error };
    }, [
      dashboardPoll.isStale,
      dashboardPoll.error?.message,
      contribInformerReady,
      contribEntities.error?.message,
      contributionsPoll.isStale,
      contributionsPoll.error?.message,
    ]);

    const [handoffs, setHandoffs] = useState<readonly Handoff[]>([]);
    const refreshHandoffs = useCallback((): void => {
      const hasMethod = isHandoffProvider(provider);
      debugLog(
        "handoffs",
        `hasGetHandoffs=${hasMethod} sessionStartedAt=${sessionStartedAt ?? "none"}`,
      );
      if (!hasMethod) return;
      void provider
        .getHandoffs({ limit: 200 })
        .then((all) => {
          const cutoff =
            sessionStartedAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
          const filtered = all.filter((h) => h.createdAt >= cutoff);
          debugLog(
            "handoffs",
            `total=${all.length} afterFilter=${filtered.length} cutoff=${cutoff}`,
          );
          setHandoffs(filtered);
        })
        .catch((err: unknown) => {
          debugLog("handoffs", `ERROR: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, [provider, sessionStartedAt]);

    useEffect(() => {
      refreshHandoffs();
    }, [refreshHandoffs]);

    const feedCidKey = useMemo(() => feed.map((c) => c.cid).join("\0"), [feed]);
    useEffect(() => {
      if (feedCidKey.length === 0) return;
      refreshHandoffs();
    }, [feedCidKey, refreshHandoffs]);

    useInterval(
      refreshHandoffs,
      Math.max(1000, Math.min(intervalMs, 2000)),
      expandedPanel === RunningPanel.Handoffs,
    );

    // Handoff reply transitions can be written by an MCP subprocess without a
    // topology-route event. Refetch on route events, feed changes, and while
    // the handoff panel is visible so the operator pane reflects replied state.
    useEffect(() => {
      if (!eventBus) return;
      const roles = topology?.roles.map((r) => r.name) ?? [];
      if (roles.length === 0) return;
      if (!isHandoffProvider(provider)) return;
      const handler = () => {
        debugLog("eventBus", "handoff event - refreshing handoffs");
        refreshHandoffs();
      };
      for (const role of roles) {
        eventBus.subscribe(role, handler);
      }
      return () => {
        for (const role of roles) {
          eventBus.unsubscribe(role, handler);
        }
      };
    }, [eventBus, topology, provider, refreshHandoffs]);

    debugLog("feed.fetch", `total=${feed.length} sessionStartedAt=${sessionStartedAt ?? "none"}`);

    // Debug: log feed state periodically
    const feedDebugRef = React.useRef(0);
    useEffect(() => {
      feedDebugRef.current++;
      if (feedDebugRef.current <= 3 || feedDebugRef.current % 20 === 0) {
        debugLog(
          "feed",
          `#${feedDebugRef.current} feed=${feed.length} feedActive=${feedActive} sessionStartedAt=${sessionStartedAt ?? "none"}`,
        );
      }
    }, [feed.length, feedActive, sessionStartedAt]);

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
        cmdMode: cmdState.mode,
        cmdText: cmdState.text,
        filterQuery,
      }),
      [
        expandedPanel,
        zoomLevel,
        showHelp,
        showVfs,
        confirmQuit,
        promptMode,
        promptText,
        cmdState.mode,
        cmdState.text,
        filterQuery,
      ],
    );

    // ─── C2 goto dispatch table ───
    // Each goto pushes a panel page onto the PagesStore (#303). The sync
    // effect above translates the new top page back into expandedPanel /
    // zoomLevel — keeping render output unchanged but routing navigation
    // through the unified k9s-style stack.
    const gotoDispatch = useMemo<Record<string, () => void>>(
      () => ({
        agents: () => pagesStore.push({ kind: "panel", params: { panel: "agents" } }),
        dag: () => pagesStore.push({ kind: "panel", params: { panel: "dag" } }),
        sessions: () => pagesStore.push({ kind: "panel", params: { panel: "sessions" } }),
        tasks: () => pagesStore.push({ kind: "panel", params: { panel: "tasks" } }),
        reviews: () => pagesStore.push({ kind: "panel", params: { panel: "reviews" } }),
        quit: () => onQuit(),
      }),
      [pagesStore, onQuit],
    );

    // Tab-complete suggestions for goto mode.
    const gotoSuggestions = useMemo<readonly string[]>(() => {
      if (cmdState.mode !== "goto") return [];
      return matchAliases(aliases, cmdState.text);
    }, [cmdState.mode, cmdState.text, aliases]);

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
        // C2 cmd-mode (#302)
        enterGotoMode: () => setCmdState(enterGoto),
        enterFilterMode: () => {
          setCmdState(enterFilter);
          setFilterQuery("");
        },
        cmdAppendChar: (ch: string) =>
          setCmdState((s) => {
            const next = cmdAppend(s, ch);
            if (next.mode === "filter") setFilterQuery(next.text);
            return next;
          }),
        cmdDeleteChar: () =>
          setCmdState((s) => {
            const next = cmdDelete(s);
            if (next.mode === "filter") setFilterQuery(next.text);
            return next;
          }),
        cmdTabComplete: () =>
          setCmdState((s) => {
            if (s.mode !== "goto") return s;
            const matches = matchAliases(aliases, s.text);
            if (matches.length === 0) return s;
            if (matches.length === 1) {
              const only = matches[0];
              if (!only) return s;
              return { ...s, text: `${only} `, suggestionIndex: 0 };
            }
            return cycleSuggestion(s, matches.length);
          }),
        cmdSubmit: () =>
          setCmdState((s) => {
            if (s.mode === "goto") {
              const trimmed = s.text.trim();
              if (!trimmed) return exitCmdMode(s);
              const r = resolveAlias(aliases, trimmed);
              if (r.kind === "ok") {
                const dispatch = gotoDispatch[r.command];
                if (dispatch) dispatch();
                else flash(`:${trimmed}: unknown command "${r.command}"`);
              } else if (r.kind === "miss") {
                flash(`:${r.key}: unknown alias`);
              } else if (r.kind === "cycle") {
                flash(`alias cycle: ${r.chain.join(" → ")}`);
              } else if (r.kind === "depth") {
                flash(`alias chain too deep (>${r.chain.length}): ${r.chain.join(" → ")}`);
              }
              return exitCmdMode(s);
            }
            // filter mode: Enter exits prompt; filterQuery retained
            return exitCmdMode(s);
          }),
        cmdClearText: () => setCmdState((s) => ({ ...s, text: "" })),
        cmdExit: () => {
          // Esc on already-empty filter prompt also clears any retained filter.
          // Read from refs (synchronous) so a same-tick burst — e.g. paste of
          // `/foo<Esc><Esc>` — sees the latest cmdState the router applied,
          // not the last-committed React state.
          const live = cmdStateRef.current;
          if (live.mode === "filter" && live.text === "" && filterQueryRef.current !== "") {
            setFilterQuery("");
          }
          setCmdState(exitCmdMode);
        },
        clearFilterQuery: () => setFilterQuery(""),
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
        aliases,
        gotoDispatch,
        flash,
        // cmdState.mode/.text and filterQuery intentionally NOT listed:
        // cmdExit reads cmdStateRef/filterQueryRef synchronously, all other
        // cmd-mode actions go through setCmdState((s) => ...) which sees the
        // latest value via React's reducer form.
        setCmdState,
        setFilterQuery,
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

          // (#303) PagesStore esc-pop short-circuit. When a panel page sits
          // above the running root (depth > 1) and no other dismissal layer
          // is active, esc pops the stack — the sync effect then mirrors the
          // new top back into expandedPanel/zoomLevel. Layered dismissal
          // (cmd-mode, prompt-mode, help, VFS, filter) takes priority and is
          // handled by the existing routeRunningKey path (which we fall
          // through to when the guard fails).
          if (
            key.name === "escape" &&
            pagesStore.depth() > 1 &&
            !confirmQuit &&
            cmdStateRef.current.mode === "none" &&
            !promptMode &&
            !showHelp &&
            filterQueryRef.current === ""
          ) {
            pagesStore.pop();
            return;
          }

          // Live snapshot of cmdMode/cmdText/filterQuery from refs — needed
          // because keyboardState's useMemo only re-runs after React commits,
          // and a burst of keys arriving in a single tick would otherwise see
          // stale state. See cmdState refs above for the race rationale.
          const liveState: RunningKeyboardState = {
            ...keyboardState,
            cmdMode: cmdStateRef.current.mode,
            cmdText: cmdStateRef.current.text,
            filterQuery: filterQueryRef.current,
          };
          routeRunningKey(key, liveState, keyboardActions);
        },
        [showVfs, keyboardState, keyboardActions, pagesStore, confirmQuit, promptMode, showHelp],
      ),
    );

    // ─── Derived data ───
    // Active-claim count stays on the polled (lease-aware) path. Claims age
    // out when wall-clock time crosses `leaseExpiresAt`, which emits no
    // watch event — informer-cached claim entities would never expire. The
    // polled dashboard fetches via the lease-aware store query, so its
    // count reflects expiry correctly.
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
              <text color={theme.secondary}> (Esc to close)</text>
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
              <text color={theme.secondary}>Esc:close</text>
            </box>
          </box>
        </box>
      );
    }

    // Tab bar options (shared between feed-only and half-screen views)
    // Must match RunningPanel enum order: Feed=0, Agents=1, Dag=2, Terminal=3, Trace=4, Handoffs=5
    const tabOptions = [
      { name: "Feed", description: "1" },
      { name: "Agents", description: "2" },
      { name: "DAG", description: "3" },
      { name: "Terminal", description: "4" },
      { name: "Traces", description: "e" },
      { name: "Handoffs", description: "5" },
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
            handoffs,
            filterText: cmdState.mode === "filter" ? cmdState.text : filterQuery,
          })}
          {renderStatusBar(
            expandedPanel,
            zoomLevel,
            elapsed,
            feed.length,
            claimCount,
            activeRoles,
            !!pendingAskUser,
            pollHealth,
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
                <text color={theme.secondary}> (f:fullscreen Esc:close)</text>
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
                sessionStartedAt,
                handoffs,
                filterText: cmdState.mode === "filter" ? cmdState.text : filterQuery,
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
            cmdState,
            gotoSuggestions,
            flashError,
          )}
          {renderStatusBar(
            expandedPanel,
            zoomLevel,
            elapsed,
            feed.length,
            claimCount,
            activeRoles,
            !!pendingAskUser,
            pollHealth,
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
          cmdState,
          gotoSuggestions,
          flashError,
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
          pollHealth,
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
        <text color={theme.secondary}> (e:trace viewer)</text>
        {showWaiting && <text color={theme.warning}> waiting for session activity...</text>}
      </box>
      {roles.map((role, idx) => {
        const activeClaim = dashboard?.activeClaims.find(
          (c) => c.agent.role === role.name || c.agent.agentId.startsWith(role.name),
        );
        const platformColor = PLATFORM_COLORS[role.platform ?? "claude-code"] ?? theme.text;
        const output = monitor.agentOutputs.get(role.name);
        // Skip raw ACP JSON-RPC envelopes bleeding through from acpx stdout.
        // They're control-plane frames, not agent prose, and showing them as
        // the role label produces garbled rows like:
        //   ○ coder [1] {"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"...
        // Prefer the most recent non-envelope line; fall back to empty.
        const lastLine = ((): string => {
          if (!output || output.length === 0) return "";
          for (let i = output.length - 1; i >= 0; i--) {
            const line = output[i] ?? "";
            const trimmed = line.trimStart();
            if (trimmed.startsWith('{"jsonrpc"') || trimmed.startsWith('{"jsonrpc"')) continue;
            return line;
          }
          return "";
        })();

        const status = activeClaim ? "running" : "idle";
        const badge = agentStatusIcon(status, activeClaim ? monitor.spinnerFrame : undefined);

        return (
          <box key={role.name} flexDirection="row">
            <text color={badge.color}>{badge.icon} </text>
            <text color={platformColor} bold>
              {role.name}
            </text>
            <text color={theme.secondary}> [{idx + 1}] </text>
            {lastLine ? <text color={theme.secondary}>{lastLine.slice(0, 80)}</text> : null}
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
          <text color={theme.secondary}>Goal: {goal}</text>
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
              <text color={theme.secondary}> {entry.summary.slice(0, 50)}</text>
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
                    <text color={theme.secondary}>{formatTime(c.createdAt)} </text>
                    <text color={kindColor}>{kindIcon} </text>
                    <text color={kindColor}>{c.kind.padEnd(12)}</text>
                    <text color={theme.info}>{agentLabel.padEnd(10)} </text>
                    <text color={selected ? theme.text : theme.secondary}>
                      {c.summary.slice(0, 55)}
                    </text>
                  </box>
                  {hasPreview ? (
                    <box flexDirection="row" marginLeft={28}>
                      {scoreEntries.slice(0, 3).map(([name, score]) => (
                        <text key={name} color={theme.secondary}>
                          {name}:{(score as { value: number }).value.toFixed(2)}{" "}
                        </text>
                      ))}
                      {artifactCount > 0 ? (
                        <text color={theme.secondary}>
                          {artifactCount} file{artifactCount !== 1 ? "s" : ""}{" "}
                        </text>
                      ) : null}
                      {relationCount > 0 ? (
                        <text color={theme.secondary}>
                          {relationCount} rel{relationCount !== 1 ? "s" : ""}{" "}
                        </text>
                      ) : null}
                      <text color={theme.secondary}> Enter:detail</text>
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
  readonly handoffs?: readonly import("../../core/handoff.js").Handoff[] | undefined;
  /** C2 (#302): in-view filter query. Applied to current expanded panel only. */
  readonly filterText?: string | undefined;
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
          filterText={ctx.filterText}
        />
      );

    case RunningPanel.Dag:
      return (
        <DagView
          provider={ctx.provider}
          intervalMs={ctx.intervalMs}
          active={true}
          cursor={ctx.cursor}
          filterText={ctx.filterText}
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
          handoffs={ctx.handoffs}
        />
      );

    case RunningPanel.Sessions:
      return (
        <box paddingX={2}>
          <text color={theme.secondary}>
            Sessions view (stub) — wires to acp_session kind in follow-up
          </text>
        </box>
      );

    case RunningPanel.Tasks:
      return (
        <box paddingX={2}>
          <text color={theme.secondary}>Tasks view (coming in C3/C4)</text>
        </box>
      );

    case RunningPanel.Reviews:
      return (
        <box paddingX={2}>
          <text color={theme.secondary}>Reviews view (coming in C3/C4)</text>
        </box>
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
  cmdState: CmdModeState,
  gotoSuggestions: readonly string[],
  flashError: string | null,
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
              <text color={theme.secondary}> wants to run: </text>
              <text color={theme.text}>{p.command}</text>
            </box>
          ))}
          <text color={theme.secondary}>y:approve n:deny</text>
        </box>
      ) : null}

      {/* IPC message log */}
      {monitor.ipcMessages.length > 0 ? (
        <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
          <text color={theme.secondary} bold>
            IPC Messages
          </text>
          {monitor.ipcMessages.slice(-5).map((msg, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: IPC messages are ephemeral
            <box key={i} flexDirection="row">
              <text color={theme.secondary}>{formatTime(msg.timestamp)} </text>
              <text color={theme.info}>{msg.sourceRole}</text>
              <text color={theme.secondary}> {"\u2192"} </text>
              <text color={theme.focus}>{msg.targetRole}</text>
              <text color={theme.secondary}> {msg.summary.slice(0, 40)}</text>
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

      {/* Prompt input (legacy message-send mode) */}
      {promptMode ? (
        <box flexDirection="row" paddingX={2}>
          <text color={theme.focus}>
            {"\u2192 "}
            {(activeRoles ?? [])[promptTarget % (activeRoles ?? []).length] ?? "agent"}
            {": "}
          </text>
          <text>{promptText}</text>
          <text color={theme.secondary}>{"\u258c"}</text>
          <text color={theme.secondary}> Tab:switch role Enter:send Esc:cancel</text>
        </box>
      ) : null}

      {/* C2 cmd-mode (#302): goto/filter prompt + flash error */}
      <Prompt
        mode={cmdState.mode}
        query={cmdState.text}
        suggestions={gotoSuggestions}
        suggestionIndex={cmdState.suggestionIndex}
      />
      <FlashBar message={flashError} />
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
      <text color={theme.text}> m Send message to agent</text>
      <text color={theme.text}> : Goto / command (alias chain)</text>
      <text color={theme.text}> / Filter current view</text>
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
    hints.push("1-4:panels", "e:traces", "5:handoffs", "j/k:nav");
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

/** Poll health info threaded into the status bar. */
interface PollHealth {
  readonly isStale: boolean;
  readonly error: string | undefined;
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
  pollHealth?: PollHealth,
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
      {pollHealth?.isStale ? (
        <text color={theme.stale}> [stale{pollHealth.error ? `: ${pollHealth.error}` : ""}]</text>
      ) : pollHealth?.error ? (
        <text color={theme.error}> [poll error: {pollHealth.error}]</text>
      ) : null}
      <text color={theme.secondary}>
        {" "}
        {contextualHints(expandedPanel, zoomLevel, activeRoles, hasAskUser)}
      </text>
    </box>
  );
}
