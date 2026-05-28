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
 * Ctrl+G: open inspect overlay (Ctrl+I would collide with Tab — same byte)
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
import {
  deriveHandoffOperatorProjection,
  type HandoffHealthSignal,
  HandoffOperatorAction,
} from "../../core/handoff-operator-state.js";
import type { Contribution } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { useInterval } from "../../local/use-interval.js";
import { compareTimestampsAscNewestLast, compareTimestampsDesc } from "../../shared/format.js";
import { EmptyState } from "../components/empty-state.js";
import { FlashBar } from "../components/flash-bar.js";
import { ProgressBar } from "../components/progress-bar.js";
import { Prompt } from "../components/prompt.js";
import type { GroveUserConfig } from "../config-loader.js";
import { createTuiConfigWatcher } from "../config-watcher.js";
import type { AgentLogBuffer } from "../data/agent-log-buffer.js";
import { type AliasMap, DEFAULT_ALIASES, matchAliases, resolveAlias } from "../data/aliases.js";
import { debugLog } from "../debug-log.js";
import { choiceDialogOptions, textPromptDialogOptions } from "../dialog-options.js";
import { performHandoffOperatorAction } from "../handoff-actions.js";
import { useEntityWatchEnabled } from "../hooks/informer-context.js";
import { useAgentMonitor } from "../hooks/use-agent-monitor.js";
import { useEntities } from "../hooks/use-entities.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import {
  type KeybindingOverrides,
  useKeybindingOverrides,
} from "../hooks/use-keybinding-overrides.js";
import { InputMode } from "../hooks/use-panel-focus.js";
import { usePagesStoreFromContext, useScreenStack } from "../hooks/use-screen-stack.js";
import { useTuiStatePersistence } from "../hooks/use-session-persistence.js";
import {
  formatKeySequence,
  type KeyBinding,
  type ResolvedKeymap,
  resolveKeymapWithOverrides,
} from "../keymap/keymap.js";
import type { DashboardData, TuiDataProvider } from "../provider.js";
import { isHandoffProvider, isVfsProvider } from "../provider.js";
import { useConfirmAndMutateOpen } from "../safety/index.js";
import { agentStatusIcon, KIND_ICONS, PLATFORM_COLORS, theme } from "../theme.js";
import { AgentListView } from "../views/agent-list.js";
import { AgentTasksView } from "../views/agent-tasks.js";
import { DagView } from "../views/dag.js";
import { HandoffsView } from "../views/handoffs-view.js";
import { LogView } from "../views/log-view.js";
import { TerminalView } from "../views/terminal.js";
import { TracePane } from "../views/trace-pane.js";
import { VfsBrowserView } from "../views/vfs-browser.js";
import { emptyFeedHint } from "./empty-feed-hint.js";
import { loadHandoffPanelSnapshot } from "./handoff-panel-snapshot.js";
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
  fetchRunningContributions,
  updateRunningContributionSeenState,
} from "./running-contributions.js";
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
import { permissionBoxVisible } from "./supervision/permission-box-visibility.js";
import { Supervision } from "./supervision/supervision.js";
import { supervisionInputActive } from "./supervision/supervision-input-guard.js";
import { routeSupervisionKey } from "./supervision/supervision-keyboard.js";
import { useFleetModel } from "./supervision/use-fleet-model.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Target metric info for progress bar display. */
export interface TargetMetricInfo {
  readonly metric: string;
  readonly value: number;
  readonly direction: "minimize" | "maximize";
}

/**
 * Map RunningPanel enum → the `panel` param string used in
 * `Page.params.panel`. Inverse of the lookup in the pagesTop sync effect.
 * Used by `keyboardActions.expandPanel` to push the matching panel page
 * onto PagesStore when the user presses 1-4 so HintBar stays in sync.
 */
const RUNNING_PANEL_PARAM: Readonly<Record<RunningPanel, string | undefined>> = Object.freeze({
  [RunningPanel.Feed]: "feed",
  [RunningPanel.Agents]: "agents",
  [RunningPanel.Dag]: "dag",
  [RunningPanel.Terminal]: "terminal",
  [RunningPanel.Trace]: undefined,
  [RunningPanel.Handoffs]: undefined,
  [RunningPanel.Sessions]: "sessions",
  [RunningPanel.Tasks]: "tasks",
  [RunningPanel.Reviews]: "reviews",
});

// #310: LogView mount gate. Read process.env once at module load — env vars
// don't change at runtime, so re-reading on every render is wasted work and
// (more importantly) churns useMemo deps that include `useLogView`.
// TODO(#310): when ACPX session metadata reaches running-view (e.g. via
// spawnManager.getSession(role).runtime), drop the env gate and detect
// per-role: useLogView = session?.runtime === "acpx". Tracked as a
// follow-up of issue #310.
const useLogView = process.env.GROVE_LOGVIEW === "1";

// #193: supervision body gate. STRICTLY ADDITIVE — unset → byte-for-byte
// identical RunningView. Read once at module load (env vars are static at
// runtime) so it never churns useMemo/useCallback deps.
const useSupervision = process.env.GROVE_SUPERVISION === "1";

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
  /** Per-role runtime failures, such as ACP bootstrap/auth failures. */
  readonly agentFailures?: ReadonlyMap<string, string> | undefined;
  /** Suppress side effects for the first loaded feed, used when resuming historical sessions. */
  readonly suppressInitialFeedSideEffects?: boolean | undefined;
  readonly userConfig?: GroveUserConfig | undefined;
  readonly onEnterInspect: () => void;
  /** Open the Pulse dashboard page (#308). */
  readonly onOpenPulse?: (() => void) | undefined;
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

function handoffActionVerb(action: HandoffOperatorAction): string {
  if (action === HandoffOperatorAction.ManualResolve) return "manual resolve";
  return action;
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
    agentFailures,
    suppressInitialFeedSideEffects = false,
    userConfig,
    onEnterInspect,
    onOpenPulse,
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

    // ─── LogView state (#310): controlled by central keyboard dispatcher ───
    // Mount gate lives at module scope (`useLogView`) so env reads don't
    // churn useMemo deps each render.
    const [logPaused, setLogPaused] = useState(false);
    const [logFilter, setLogFilter] = useState("");
    const [logFilterMode, setLogFilterModeRaw] = useState(false);
    const [logScrollOffset, setLogScrollOffset] = useState(0);
    // Mirror `logFilterMode` into a ref so the keyboard dispatcher sees the
    // latest value within a same-tick burst (paste / scripted input) — same
    // race rationale as `cmdStateRef` below. Without this, a burst like
    // `/foo` after committing the prior filter could see stale
    // `logFilterMode === false` between `setLogFilterMode(true)` and React's
    // commit, sending printable chars to normal-mode handlers.
    const logFilterModeRef = useRef<boolean>(false);
    const setLogFilterMode = useCallback((next: boolean) => {
      logFilterModeRef.current = next;
      setLogFilterModeRaw(next);
    }, []);

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
    const [hotkeyOverrides, setHotkeyOverrides] = useState<KeybindingOverrides>({});
    const fileOverrides = useKeybindingOverrides();
    const keybindingOverrides = useMemo(
      () => ({ ...userConfig?.keymap, ...hotkeyOverrides, ...fileOverrides }),
      [userConfig?.keymap, hotkeyOverrides, fileOverrides],
    );
    const resolvedKeymap = useMemo(
      () => resolveKeymapWithOverrides(userConfig?.keymapPreset ?? "default", keybindingOverrides),
      [userConfig?.keymapPreset, keybindingOverrides],
    );
    const [keymapPrefix, setKeymapPrefix] = useState<readonly string[]>([]);
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
      // `groveDir` prop is the resolved `.grove/` directory (per resolveGroveDir).
      const projectRoot = dirname(groveDir);
      const watcher = createTuiConfigWatcher({ projectRoot });
      const unsubscribe = watcher.subscribe((event) => {
        if (cancelled) return;
        if (event.type === "ConfigChanged" && event.changed === "aliases") {
          setAliases(event.config.aliases);
          return;
        }
        if (event.type === "ConfigChanged" && event.changed === "hotkeys") {
          setHotkeyOverrides(event.config.hotkeys);
          return;
        }
        if (event.type === "ConfigError") {
          flash(event.message);
        }
      });
      void watcher
        .start()
        .then(() => {
          if (!cancelled) {
            const current = watcher.current();
            setAliases(current.aliases);
            setHotkeyOverrides(current.hotkeys);
          }
        })
        .catch((err) => {
          if (!cancelled) flash(err instanceof Error ? err.message : "config watcher failed");
        });
      return () => {
        cancelled = true;
        unsubscribe();
        void watcher.stop();
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
          terminal: RunningPanel.Terminal,
        };
        const target = map[panel];
        if (target !== undefined) {
          // SET (not toggle). expandPanelTransition would collapse the panel
          // if local state already matches target — which happens when the
          // user pressed a direct 1-4 shortcut: keyboardActions.expandPanel
          // mutated local state first, then pushed onto PagesStore; this
          // effect then runs and would toggle the just-set panel back to null.
          // Set the panel + zoom directly so the round-trip stays stable.
          setExpandedPanel(target);
          if (zoomLevelRef.current === "normal") setZoomLevel("half");
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
    const monitor = useAgentMonitor({ groveDir, logBuffers, tmux, eventBus, topology });

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
    // Honor the session scope gate: in scoped sessions we keep the snapshot
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
      const result = await fetchRunningContributions(provider, sessionId);
      debugLog("feed.fetch", `total=${result?.length ?? 0}`);
      if (fetchCountRef.current <= 5 || fetchCountRef.current % 20 === 0) {
        debugLog(
          "feed.fetch",
          `snapshot #${fetchCountRef.current} returned ${result?.length ?? 0} contributions`,
        );
      }
      return result;
    }, [provider, sessionId]);

    // Gate snapshot fetches when panel is fullscreen and not showing feed.
    const feedActive =
      zoomLevel !== "full" || expandedPanel === RunningPanel.Feed || expandedPanel === null;
    // Only switch to informer data after it has synced and is healthy. Cold
    // start or terminal watch failure must keep the event-triggered snapshot fallback alive,
    // otherwise the feed renders empty even though `getContributions()` would
    // still return data.
    const contribInformerReady =
      useContribInformer && contribEntities.hasSynced && !contribEntities.error;
    const dashboardSnapshot = useEventDrivenData<DashboardData>(
      dashboardFetcher,
      undefined,
      undefined,
      true,
    );
    const contributionsSnapshot = useEventDrivenData<readonly Contribution[]>(
      contributionsFetcher,
      undefined,
      undefined,
      feedActive && !contribInformerReady,
    );

    // This fetcher is not a timer. It seeds the feed before the informer is
    // ready, and the EventBus handler below refreshes it immediately when SSE
    // push arrives.

    // When EventBus fires (SSE push from Nexus), trigger immediate re-fetch.
    //
    // LocalEventBus fans out by `role:<targetRole>` channel, and NexusWsBridge
    // publishes contribution events with `targetRole` set to the role that
    // received the inbox delivery (coder / reviewer / …). Subscribing to a
    // sentinel channel like "system" never receives anything, which is how
    // the feed silently stopped refreshing on push in live sessions.
    //
    // ScreenManager renders RunningView OUTSIDE App's RefreshContext
    // provider (the inspect overlay is a different screen state),
    // so useRefreshSignal does nothing here. Subscribe directly to the
    // EventBus so SSE pushes refresh the feed/dashboard immediately.
    useEffect(() => {
      if (!eventBus) return;
      const roles = topology?.roles.map((r) => r.name) ?? [];
      if (roles.length === 0) return;
      const handler = () => {
        const p = provider as { invalidateCaches?: () => void };
        p.invalidateCaches?.();
        dashboardSnapshot.refresh();
        contributionsSnapshot.refresh();
      };
      for (const role of roles) eventBus.subscribe(role, handler);
      return () => {
        for (const role of roles) eventBus.unsubscribe(role, handler);
      };
    }, [eventBus, topology, provider, dashboardSnapshot.refresh, contributionsSnapshot.refresh]);

    const dashboard = dashboardSnapshot.data ?? undefined;

    // ─── Supervision fleet model (#193, gated by GROVE_SUPERVISION) ───
    // `active` is only true when the supervision body is the visible body
    // (flag on AND no panel expanded) so the fetchers stay idle otherwise.
    const fleet = useFleetModel({
      provider,
      monitor,
      agentFailures,
      tmux,
      filterText: filterQuery,
      active: useSupervision && expandedPanel === null,
    });
    const [selectedSupervisionAgent, setSelectedSupervisionAgent] = useState<string | undefined>(
      undefined,
    );
    const [supervisionCursor, setSupervisionCursor] = useState(0);
    const selectedFleetAgent = useMemo(
      () =>
        fleet.find((a) => a.agentId === selectedSupervisionAgent) ??
        fleet[supervisionCursor] ??
        fleet[0],
      [fleet, selectedSupervisionAgent, supervisionCursor],
    );
    const selectedFleetRole = selectedFleetAgent?.role;
    const selectedFleetTail = useMemo<readonly string[]>(
      () => (selectedFleetRole ? (monitor.agentOutputs.get(selectedFleetRole) ?? []) : []),
      [selectedFleetRole, monitor.agentOutputs],
    );
    const handleSupervisionSelect = useCallback(
      (id: string | undefined) => setSelectedSupervisionAgent(id),
      [],
    );
    const contributions = useMemo<readonly Contribution[] | undefined>(() => {
      if (!contribInformerReady) return contributionsSnapshot.data ?? undefined;
      // Time-based session scope. The watch protocol does not yet filter
      // by sessionId server-side, so the EntityStore cache may contain
      // contributions from prior/parallel sessions in the same namespace.
      // Filter to entries created at-or-after the current session start to
      // match the provider.getContributions() snapshot semantics, which the
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
      // (`feed.length - 1`) lands on the newest row, matching the snapshot
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
    }, [contribInformerReady, contribEntities.data, contributionsSnapshot.data, sessionStartedAt]);
    // Session scoping is handled server-side (provider.setSessionScope).
    // The feed already contains only this session's contributions.
    const feed = contributions ?? [];

    // Aggregate poll health for the status bar: show stale/error when either
    // path is unhealthy. Informer error always surfaces (even when we're still
    // polling as fallback) so operators see watch-pipeline failures.
    const pollHealth = useMemo(() => {
      const contribStale = contribInformerReady ? false : contributionsSnapshot.isStale;
      const contribError =
        contribEntities.error?.message ??
        (contribInformerReady ? undefined : contributionsSnapshot.error?.message);
      const isStale = dashboardSnapshot.isStale || contribStale;
      const error = dashboardSnapshot.error?.message ?? contribError ?? undefined;
      return { isStale, error };
    }, [
      dashboardSnapshot.isStale,
      dashboardSnapshot.error?.message,
      contribInformerReady,
      contribEntities.error?.message,
      contributionsSnapshot.isStale,
      contributionsSnapshot.error?.message,
    ]);

    const [handoffs, setHandoffs] = useState<readonly Handoff[]>([]);
    const [handoffCursor, setHandoffCursor] = useState(0);
    const [handoffHealthSignals, setHandoffHealthSignals] = useState<
      readonly HandoffHealthSignal[]
    >([]);
    useEffect(() => {
      setHandoffCursor((current) => Math.min(current, Math.max(0, handoffs.length - 1)));
    }, [handoffs.length]);
    const refreshHandoffs = useCallback((): void => {
      const hasMethod = isHandoffProvider(provider);
      debugLog(
        "handoffs",
        `hasGetHandoffs=${hasMethod} sessionStartedAt=${sessionStartedAt ?? "none"}`,
      );
      if (!hasMethod) return;
      void loadHandoffPanelSnapshot({ provider, sessionId, sessionStartedAt, agentFailures })
        .then((snapshot) => {
          debugLog("handoffs", `afterFilter=${snapshot.handoffs.length}`);
          setHandoffs(snapshot.handoffs);
          setHandoffHealthSignals(snapshot.healthSignals);
        })
        .catch((err: unknown) => {
          debugLog("handoffs", `ERROR: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, [provider, sessionId, sessionStartedAt, agentFailures]);

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

    const selectedHandoffProjection = useMemo(() => {
      const selected = handoffs[Math.min(handoffCursor, Math.max(0, handoffs.length - 1))];
      if (selected === undefined) return undefined;
      return deriveHandoffOperatorProjection(selected, { healthSignals: handoffHealthSignals });
    }, [handoffs, handoffCursor, handoffHealthSignals]);

    const promptHandoffReason = useCallback(
      async (action: HandoffOperatorAction): Promise<string | null> => {
        const value = await dialog.prompt<string>(
          textPromptDialogOptions({
            title: `Handoff ${handoffActionVerb(action)}`,
            message: "Reason",
            defaultValue: handoffActionVerb(action),
          }),
        );
        return value === undefined ? null : value;
      },
      [dialog],
    );

    const promptRerouteRole = useCallback(async (): Promise<string | null> => {
      const selected = selectedHandoffProjection?.handoff;
      const choices = (activeRoles ?? []).filter((role) => role !== selected?.toRole);
      if (choices.length > 0) {
        const value = await dialog.choice(
          choiceDialogOptions({
            title: "Reroute Handoff",
            message: "Target role",
            choices,
          }),
        );
        return value === undefined ? null : value;
      }
      const value = await dialog.prompt<string>(
        textPromptDialogOptions({
          title: "Reroute Handoff",
          message: "Target role",
        }),
      );
      return value === undefined ? null : value;
    }, [activeRoles, dialog, selectedHandoffProjection]);

    const promptLeaveSession = useCallback(
      async <const K extends string>(choices: readonly K[]): Promise<K | undefined> => {
        return dialog.choice(
          choiceDialogOptions({
            title: "Leave Session",
            message: "Agents will be stopped.",
            choices,
          }),
        );
      },
      [dialog],
    );

    const executeSelectedHandoffAction = useCallback(
      (action: HandoffOperatorAction): void => {
        const projection = selectedHandoffProjection;
        if (projection === undefined) {
          flash("handoff: no row selected");
          return;
        }
        void performHandoffOperatorAction({
          provider,
          projection,
          action,
          sessionId,
          activeRoles,
          promptReason: promptHandoffReason,
          promptRerouteRole,
        })
          .then((performed) => {
            if (!performed) {
              flash(`handoff: ${handoffActionVerb(action)} unavailable`);
              return;
            }
            toast.success(`handoff ${handoffActionVerb(action)}`, { duration: 3000 });
            refreshHandoffs();
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            flash(`handoff: ${msg}`);
            toast.error(`handoff: ${msg}`, { duration: 5000 });
          });
      },
      [
        activeRoles,
        flash,
        promptHandoffReason,
        promptRerouteRole,
        provider,
        refreshHandoffs,
        selectedHandoffProjection,
        sessionId,
      ],
    );

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
      if (!feed.length) return;

      const update = updateRunningContributionSeenState(
        { seenCids: seenCidsRef.current, initialSeeded: initialSeededRef.current },
        feed,
        suppressInitialFeedSideEffects || !sessionStartedAt,
      );
      seenCidsRef.current = new Set(update.state.seenCids);
      initialSeededRef.current = update.state.initialSeeded;

      if (update.seededInitialFeed) {
        debugLog("seenCids", `seeding ${feed.length} existing CIDs`);
      }
      if (!onNewContribution) {
        return;
      }

      for (const c of update.unseen) {
        debugLog(
          "seenCids",
          `NEW CID detected: ${c.cid.slice(0, 20)} kind=${c.kind} role=${c.agent?.role}`,
        );
        onNewContribution(c);
        // Toast notification for new contributions
        const role = c.agent.role ?? c.agent.agentName ?? "agent";
        if (c.kind === "ask_user") {
          toast.warning(`${role}: question pending`, { duration: 5000 });
        } else {
          toast.info(`${role}: ${c.kind}`, { duration: 3000 });
        }
      }
    }, [feed, onNewContribution, sessionStartedAt, suppressInitialFeedSideEffects]);

    // ─── Keyboard routing ───
    const pendingAskUser = feed.find((c) => c.kind === "ask_user");
    const confirmModalOpen = useConfirmAndMutateOpen();
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
        confirmModalOpen,
        resolvedKeymap,
        keymapPrefix,
        logFilterMode,
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
        confirmModalOpen,
        resolvedKeymap,
        keymapPrefix,
        logFilterMode,
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
          // Mirror the panel into PagesStore so HintBar / breadcrumb stay
          // in sync with the visible panel. Shortcut keys (1-4) are
          // switches, not drill-down — normalize the stack by collapsing
          // ALL trailing `panel` pages first so a prior goto history like
          // `:agents :sessions` followed by shortcut `3` doesn't leave
          // `panel:agents` underneath. Without this normalization, the
          // sync effect would later restore the stale panel when the
          // shortcut-selected page is popped (#309 round 10 fix).
          while (pagesStore.top()?.kind === "panel") pagesStore.pop();
          const panelName = RUNNING_PANEL_PARAM[panel];
          if (next.expandedPanel !== null && panelName) {
            pagesStore.push({ kind: "panel", params: { panel: panelName } });
          }
          // If next.expandedPanel === null we already popped to clean state.
          // If panelName is undefined (Trace/Handoffs), we also stop at clean
          // state — HintBar falls back to running hints; restore the panel
          // mapping when those routes land in PANEL_HINTS.
        },
        collapsePanel: () => {
          const next = collapsePanel();
          setExpandedPanel(next.expandedPanel);
          setZoomLevel(next.zoomLevel);
          if (pagesStore.top()?.kind === "panel") {
            pagesStore.pop();
          }
        },
        toggleFullscreen: () => {
          const next = toggleFullscreenTransition(expandedPanel, zoomLevel);
          setExpandedPanel(next.expandedPanel);
          setZoomLevel(next.zoomLevel);
        },
        toggleHelp: () => setShowHelp((v) => !v),
        dismissHelp: () => setShowHelp(false),
        onKeymapPrefixChange: (prefix: readonly string[]) => setKeymapPrefix(prefix),
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
        handoffCursorDown: () =>
          setHandoffCursor((current) => Math.min(current + 1, Math.max(0, handoffs.length - 1))),
        handoffCursorUp: () => setHandoffCursor((current) => Math.max(current - 1, 0)),
        resendSelectedHandoff: () => executeSelectedHandoffAction(HandoffOperatorAction.Resend),
        rerouteSelectedHandoff: () => executeSelectedHandoffAction(HandoffOperatorAction.Reroute),
        cancelSelectedHandoff: () => executeSelectedHandoffAction(HandoffOperatorAction.Cancel),
        manualResolveSelectedHandoff: () =>
          executeSelectedHandoffAction(HandoffOperatorAction.ManualResolve),
        // LogView actions (#310): mirror trace-pane controlled-component pattern.
        logTogglePause: () => setLogPaused((p) => !p),
        logScrollDown: () => setLogScrollOffset((n) => n + 1),
        logScrollUp: () => setLogScrollOffset((n) => Math.max(0, n - 1)),
        logScrollToBottom: () => setLogScrollOffset(0),
        // LogViewport clamps with Math.max(0, end - viewportLines), so a huge
        // offset maps to "top of buffer".
        logScrollToTop: () => setLogScrollOffset(Number.MAX_SAFE_INTEGER),
        logEnterFilterMode: () => setLogFilterMode(true),
        logCommitFilter: () => setLogFilterMode(false), // keep logFilter
        logCancelFilter: () => {
          setLogFilterMode(false);
          setLogFilter("");
        },
        logFilterAppend: (ch: string) => setLogFilter((f) => f + ch),
        logFilterBackspace: () => setLogFilter((f) => f.slice(0, -1)),
        logViewActive: useLogView,
        // openDetail kept as an interface field for future detail-route work,
        // but wired to a no-op so Enter cannot accidentally enter inspect.
        openDetail: () => undefined,
        enterInspect: () => onEnterInspect(),
        openPulse: () => onOpenPulse?.(),
        quit: () => onQuit(),
        showQuitDialog: () => {
          if (onBackToMain) {
            void promptLeaveSession(["Quit", "Back to main", "Cancel"] as const).then((choice) => {
              if (choice === "Quit") onQuit();
              else if (choice === "Back to main") onBackToMain();
            });
          } else {
            void promptLeaveSession(["Quit", "Cancel"] as const).then((choice) => {
              if (choice === "Quit") onQuit();
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
        onEnterInspect,
        onOpenPulse,
        onQuit,
        onBackToMain,
        monitor.pendingPermissions,
        tmux,
        pendingAskUser,
        topology,
        handoffs.length,
        executeSelectedHandoffAction,
        promptLeaveSession,
        aliases,
        gotoDispatch,
        flash,
        // pagesStore is stable across renders (returned by usePagesStoreFromContext);
        // listing it satisfies biome's useExhaustiveDependencies for the
        // round-7 expandPanel/collapsePanel push/pop/replace calls.
        pagesStore,
        // cmdState.mode/.text and filterQuery intentionally NOT listed:
        // cmdExit reads cmdStateRef/filterQueryRef synchronously, all other
        // cmd-mode actions go through setCmdState((s) => ...) which sees the
        // latest value via React's reducer form.
        setCmdState,
        setFilterQuery,
        // #310: ref-mirrored setter (stable identity per render via
        // useCallback) — keeps logEnterFilterMode/logCommitFilter/
        // logCancelFilter exhaustive without churning the memo each render.
        setLogFilterMode,
        // #310: `useLogView` lives at module scope (env-derived constant), so
        // it isn't a dep — kept out of the array deliberately.
      ],
    );

    useKeyboard(
      useCallback(
        (key) => {
          // C6 (#304) round-5: when the confirmAndMutate modal is open,
          // swallow ALL RunningView keys. The modal owns y/n/escape; any
          // other key (q, Ctrl+A, panel shortcuts) operating on the
          // running screen behind a confirmation modal is unsafe — it
          // changes state the operator cannot see. opentui dispatches
          // every key to every handler, so suppression must happen at
          // each handler.
          if (confirmModalOpen) return;
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

          // Live snapshot of cmdMode/cmdText/filterQuery/logFilterMode from
          // refs — needed because keyboardState's useMemo only re-runs after
          // React commits, and a burst of keys arriving in a single tick
          // would otherwise see stale state. See cmdState refs above for the
          // race rationale; logFilterMode follows the same pattern (#310).
          const liveState: RunningKeyboardState = {
            ...keyboardState,
            cmdMode: cmdStateRef.current.mode,
            cmdText: cmdStateRef.current.text,
            filterQuery: filterQueryRef.current,
            confirmModalOpen,
            resolvedKeymap,
            keymapPrefix,
            logFilterMode: logFilterModeRef.current,
          };
          // #193: supervision body owns the keyboard when the flag is on and
          // it is the visible body with no modal / overlay / input mode
          // active. Guard predicate is the exported `supervisionInputActive`
          // (unit-tested) so the risky condition is covered without mounting
          // RunningView. Falls through to routeRunningKey if not consumed.
          if (
            supervisionInputActive({
              useSupervision,
              expandedPanelNull: expandedPanel === null,
              cmdMode: cmdStateRef.current.mode,
              promptMode,
              showHelp,
              showVfs,
              filterQuery: filterQueryRef.current,
            })
          ) {
            const handled = routeSupervisionKey(
              { name: key.name },
              { selectedHealth: selectedFleetAgent?.health },
              {
                moveCursor: (delta) => {
                  const next = Math.max(0, Math.min(fleet.length - 1, supervisionCursor + delta));
                  setSupervisionCursor(next);
                  setSelectedSupervisionAgent(fleet[next]?.agentId);
                },
                pinSelection: () => setSelectedSupervisionAgent(selectedFleetAgent?.agentId),
                jumpTop: () => {
                  setSupervisionCursor(0);
                  setSelectedSupervisionAgent(fleet[0]?.agentId);
                },
                jumpBottom: () => {
                  const last = Math.max(0, fleet.length - 1);
                  setSupervisionCursor(last);
                  setSelectedSupervisionAgent(fleet[last]?.agentId);
                },
                approve: () => {
                  const p = selectedFleetAgent?.pendingApproval;
                  if (p && tmux) void tmux.sendKeys(p.sessionName, "y");
                },
                deny: () => {
                  const p = selectedFleetAgent?.pendingApproval;
                  if (p && tmux) void tmux.sendKeys(p.sessionName, "n");
                },
                always: () => {
                  const p = selectedFleetAgent?.pendingApproval;
                  if (p && tmux) void tmux.sendKeys(p.sessionName, "a");
                },
                openTail: () => keyboardActions.expandPanel(RunningPanel.Terminal),
                openDag: () => keyboardActions.expandPanel(RunningPanel.Dag),
                reroute: () => flash("Reroute lands with #163"),
                kill: () => flash("Kill action lands with claim-revoke provider API"),
                openMessage: () => {
                  if (!selectedFleetRole) return;
                  const idx = (activeRoles ?? []).indexOf(selectedFleetRole);
                  if (idx < 0) return;
                  setPromptMode(true);
                  setPromptTarget(idx);
                },
              },
            );
            if (handled) return;
          }
          routeRunningKey(key, liveState, keyboardActions);
        },
        [
          showVfs,
          keyboardState,
          keyboardActions,
          pagesStore,
          confirmQuit,
          promptMode,
          showHelp,
          confirmModalOpen,
          // #193: supervision keyboard owner deps. expandedPanel/fleet/
          // selectedFleetAgent/selectedFleetRole change the consumed keys'
          // behavior; supervisionCursor is read directly by moveCursor (flat
          // setState, not the prior functional-update form). selectedFleetRole
          // is still referenced directly inside openMessage, so it stays
          // listed to satisfy biome's useExhaustiveDependencies (matching this
          // file's list-everything discipline above). tmux/activeRoles/flash
          // are stable refs/callbacks but listed for closure correctness.
          // useSupervision is a module-scope env constant (not a dep), same as
          // useLogView above.
          expandedPanel,
          fleet,
          selectedFleetAgent,
          selectedFleetRole,
          supervisionCursor,
          tmux,
          activeRoles,
          flash,
          resolvedKeymap,
          keymapPrefix,
          // #310: logFilterMode read via logFilterModeRef (synchronous) so a
          // same-tick burst sees the latest mode. keyboardState already lists
          // logFilterMode in its memo deps for rendering, so committed state
          // changes still re-create the callback through that path.
        ],
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
            logViewActive: useLogView,
            logPaused,
            logFilter,
            logFilterMode,
            logScrollOffset,
            sessionStartedAt,
            handoffs,
            handoffCursor,
            handoffHealthSignals,
            activeRoles,
            agentFailures,
            filterText: cmdState.mode === "filter" ? cmdState.text : filterQuery,
            dagKeysEnabled:
              expandedPanel === RunningPanel.Dag &&
              cmdState.mode === "none" &&
              !promptMode &&
              !showHelp &&
              !showVfs,
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
            resolvedKeymap,
            keymapPrefix,
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
                activeRoles,
                agentFailures,
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
                logViewActive: useLogView,
                logPaused,
                logFilter,
                logFilterMode,
                logScrollOffset,
                sessionStartedAt,
                handoffs,
                handoffCursor,
                handoffHealthSignals,
                activeRoles,
                agentFailures,
                filterText: cmdState.mode === "filter" ? cmdState.text : filterQuery,
                dagKeysEnabled:
                  expandedPanel === RunningPanel.Dag &&
                  cmdState.mode === "none" &&
                  !promptMode &&
                  !showHelp &&
                  !showVfs,
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
            useSupervision,
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
            resolvedKeymap,
            keymapPrefix,
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

        {/* Default body: agent status + feed. #193: GROVE_SUPERVISION swaps
            in the fleet/detail rail. Flag unset → byte-for-byte identical. */}
        {useSupervision ? (
          <Supervision
            agents={fleet}
            tail={selectedFleetTail}
            cursor={supervisionCursor}
            // Single selection authority: drive the pin from the already
            // RESOLVED agent (selectedFleetAgent), not raw
            // selectedSupervisionAgent. If we passed the raw pin and it left
            // the fleet, running-view's memo falls back to fleet[cursor] while
            // Supervision still re-resolves the stale pin, fires onSelect, and
            // converge-by-setState churns every fleet refresh. Deriving from
            // the resolved memo means Supervision's find() always hits and can
            // never disagree with running-view's fallback.
            // exactOptionalPropertyTypes: only pass pinnedAgentId when set.
            {...(selectedFleetAgent?.agentId !== undefined
              ? { pinnedAgentId: selectedFleetAgent.agentId }
              : {})}
            onSelect={handleSupervisionSelect}
          />
        ) : (
          <>
            {/* Agent status with live output */}
            {renderAgentSection(
              topology,
              dashboard,
              monitor,
              agentFailures,
              sessionStartedAt,
              feed.length,
            )}

            {/* Main feed area */}
            {renderFeedSection(
              feed,
              cursor,
              goal,
              pendingAskUser,
              frontier,
              autoFollow,
              newSinceFreeze,
              activeRoles,
              agentFailures,
            )}
          </>
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
          useSupervision,
        )}

        {/* Help overlay */}
        {showHelp ? renderHelpOverlay(resolvedKeymap) : null}

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
          resolvedKeymap,
          keymapPrefix,
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
  agentFailures: ReadonlyMap<string, string> | undefined,
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
        const failure = agentFailures?.get(role.name);
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

        const status = failure ? "error" : activeClaim ? "running" : "idle";
        const badge = agentStatusIcon(status, activeClaim ? monitor.spinnerFrame : undefined);

        return (
          <box key={role.name} flexDirection="row">
            <text color={badge.color}>{badge.icon} </text>
            <text color={platformColor} bold>
              {role.name}
            </text>
            <text color={theme.secondary}> [{idx + 1}] </text>
            {failure ? (
              <text color={theme.error}>{failure.slice(0, 96)}</text>
            ) : lastLine ? (
              <text color={theme.secondary}>{lastLine.slice(0, 80)}</text>
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
  autoFollow: boolean,
  newSinceFreeze: number,
  activeRoles?: readonly string[] | undefined,
  agentFailures?: ReadonlyMap<string, string> | undefined,
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
          <EmptyState
            title="Waiting for contributions..."
            hint={emptyFeedHint(activeRoles, agentFailures)}
          />
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
  // #310: LogView controlled-component state. Optional so existing tests and
  // non-ACPX call sites need no changes. Wired from running-view useState.
  readonly logViewActive?: boolean;
  readonly logPaused?: boolean;
  readonly logFilter?: string;
  readonly logFilterMode?: boolean;
  readonly logScrollOffset?: number;
  readonly sessionStartedAt?: string | undefined;
  readonly handoffs?: readonly import("../../core/handoff.js").Handoff[] | undefined;
  readonly handoffCursor?: number | undefined;
  readonly handoffHealthSignals?: readonly HandoffHealthSignal[] | undefined;
  readonly activeRoles?: readonly string[] | undefined;
  readonly agentFailures?: ReadonlyMap<string, string> | undefined;
  /** C2 (#302): in-view filter query. Applied to current expanded panel only. */
  readonly filterText?: string | undefined;
  /** #311: true when DAG-local keyboard shortcuts may fire (DAG focused and
   *  no modal/text mode is consuming keys). */
  readonly dagKeysEnabled?: boolean;
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
        ctx.activeRoles,
        ctx.agentFailures,
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
          active={true}
          cursor={ctx.cursor}
          highlightText={ctx.filterText}
          keysEnabled={ctx.dagKeysEnabled ?? false}
        />
      );

    case RunningPanel.Terminal: {
      // #310: when ACPX/log-streaming is in use, render LogView instead of
      // TerminalView. Gate is currently env-driven.
      // TODO(#310): when ACPX session metadata reaches running-view (e.g. via
      // spawnManager.getSession(role).runtime), drop the env gate and detect
      // per-role: useLogView = session?.runtime === "acpx". Tracked as a
      // follow-up of issue #310.
      if (ctx.logViewActive) {
        // Temporary: pick the first available role's buffer. Future work:
        // track the operator's selected agent and route to its buffer
        // (mirrors traceSelectedAgent in TracePane).
        const firstRole = ctx.topology?.roles?.[0]?.name;
        const buffer = firstRole ? ctx.logBuffers?.get(firstRole) : undefined;
        return (
          <LogView
            sessionId={buffer?.sessionId ?? firstRole ?? ""}
            buffer={buffer}
            paused={ctx.logPaused ?? false}
            filter={ctx.logFilter ?? ""}
            filterMode={ctx.logFilterMode ?? false}
            scrollOffset={ctx.logScrollOffset ?? 0}
          />
        );
      }
      return (
        <TerminalView
          tmux={ctx.tmux}
          intervalMs={ctx.intervalMs}
          active={true}
          mode={InputMode.Normal}
        />
      );
    }

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
          cursor={ctx.handoffCursor ?? 0}
          sessionStartedAt={ctx.sessionStartedAt}
          handoffs={ctx.handoffs}
          healthSignals={ctx.handoffHealthSignals}
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
        <AgentTasksView
          provider={ctx.provider}
          intervalMs={ctx.intervalMs}
          active
          cursor={ctx.cursor}
        />
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
  supervisionOn: boolean,
): React.ReactNode {
  return (
    <>
      {/* Permission prompts from agents */}
      {permissionBoxVisible(supervisionOn, monitor.pendingPermissions.length) ? (
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

function preferredBinding(
  keymap: ResolvedKeymap | undefined,
  predicate: (binding: KeyBinding) => boolean,
): KeyBinding | undefined {
  const matches = keymap?.bindings.filter(predicate) ?? [];
  return matches.find((binding) => binding.preferred) ?? matches[0];
}

function keyForAction(
  keymap: ResolvedKeymap | undefined,
  action: KeyBinding["action"],
): string | undefined {
  const binding = preferredBinding(keymap, (candidate) => candidate.action === action);
  return binding === undefined ? undefined : formatKeySequence(binding.sequence);
}

function keyForBindingId(keymap: ResolvedKeymap | undefined, id: string): string | undefined {
  const binding = preferredBinding(keymap, (candidate) => candidate.id === id);
  return binding === undefined ? undefined : formatKeySequence(binding.sequence);
}

function leaderHint(keymap: ResolvedKeymap | undefined): string | undefined {
  const binding = preferredBinding(
    keymap,
    (candidate) => candidate.layer === "leader" && candidate.sequence.length > 0,
  );
  const leader = binding?.sequence[0];
  return leader === undefined ? undefined : `${formatKeySequence([leader])}:leader`;
}

/** Render the help overlay. */
function renderHelpOverlay(resolvedKeymap: ResolvedKeymap | undefined): React.ReactNode {
  const helpKey = keyForAction(resolvedKeymap, "help") ?? "?";
  const quitKey = keyForAction(resolvedKeymap, "quit") ?? "q";
  const terminalKey = keyForBindingId(resolvedKeymap, "toggle_panel:terminal") ?? "4";
  const vfsKey = keyForBindingId(resolvedKeymap, "toggle_panel:vfs") ?? "Ctrl+F";
  const messageKey = keyForAction(resolvedKeymap, "broadcast") ?? "m";
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
      <text color={theme.text}> {terminalKey} Open Terminal panel</text>
      <text color={theme.text}> f Toggle fullscreen (when panel expanded)</text>
      <text color={theme.text}> e Open trace viewer (split-pane agent output)</text>
      <text color={theme.text}> j/k Navigate (feed or trace agent list)</text>
      <text color={theme.text}> J/K Scroll trace output (when trace open)</text>
      <text color={theme.text}> G/g Jump to bottom/top of trace</text>
      <text color={theme.text}> {messageKey} Send message to agent</text>
      <text color={theme.text}> Handoffs: s resend, r reroute, x cancel, v resolve</text>
      <text color={theme.text}> : Goto / command (alias chain)</text>
      <text color={theme.text}> / Filter current view</text>
      <text color={theme.text}> r Jump to ask_user question</text>
      <text color={theme.text}> {vfsKey} File browser (VFS)</text>
      <text color={theme.text}> Ctrl+G Inspect overlay (Ctrl+G to return)</text>
      <text color={theme.text}> y/n Approve/deny permission</text>
      <text color={theme.text}> {helpKey} Toggle this help</text>
      <text color={theme.text}> Esc Collapse panel / close overlay</text>
      <text color={theme.text}> {quitKey} Quit (with confirmation)</text>
      <text> </text>
      <text color={theme.focus} bold>
        Supervision (GROVE_SUPERVISION=1)
      </text>
      <text color={theme.text}> j/k Move fleet cursor · g/G top/bottom</text>
      <text color={theme.text}> Enter Pin hovered agent as selected</text>
      <text color={theme.text}> y/n/a Approve / deny / always-allow</text>
      <text color={theme.text}> t Open Terminal panel</text>
      <text color={theme.text}> d Open DAG panel</text>
      <text color={theme.text}> r Reroute blocked handoff (placeholder)</text>
      <text color={theme.text}> K Kill / revoke claim (placeholder)</text>
      <text color={theme.text}> m Message the selected agent</text>
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
  resolvedKeymap: ResolvedKeymap | undefined,
  keymapPrefix: readonly string[] | undefined,
): string {
  if (keymapPrefix !== undefined && keymapPrefix.length > 0) {
    return `${formatKeySequence(keymapPrefix)} ... Esc:cancel`;
  }

  const hints: string[] = [];
  const leader = leaderHint(resolvedKeymap);
  if (leader !== undefined) hints.push(leader);

  if (expandedPanel === null) {
    // Default feed view
    hints.push("1-4:panels", "e:traces", "5:handoffs", "j/k:nav");
  } else if (expandedPanel === RunningPanel.Trace) {
    // Trace pane active
    hints.push("j/k:agent", "J/K:scroll", "G/g:top/bottom", "Tab:cycle");
    if (zoomLevel !== "full") hints.push("f:full");
    hints.push("Esc:close");
  } else if (expandedPanel === RunningPanel.Handoffs) {
    hints.push("j/k:row", "s:resend", "r:reroute", "x:cancel", "v:resolve");
    if (zoomLevel !== "full") hints.push("f:full");
    hints.push("Esc:close");
  } else {
    // Panel expanded
    if (zoomLevel !== "full") hints.push("f:full");
    hints.push("Esc:close");
  }

  if ((activeRoles ?? []).length > 0) {
    hints.push(`${keyForAction(resolvedKeymap, "broadcast") ?? "m"}:msg`);
  }
  if (hasAskUser) hints.push("r:respond");
  hints.push(`${keyForAction(resolvedKeymap, "help") ?? "?"}:help`);
  hints.push(`${keyForAction(resolvedKeymap, "quit") ?? "q"}:quit`);

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
  resolvedKeymap?: ResolvedKeymap | undefined,
  keymapPrefix?: readonly string[] | undefined,
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
        {contextualHints(
          expandedPanel,
          zoomLevel,
          activeRoles,
          hasAskUser,
          resolvedKeymap,
          keymapPrefix,
        )}
      </text>
    </box>
  );
}
