/**
 * Root TUI application component.
 *
 * Multi-panel agent command center with graph-first layout.
 * Uses OpenTUI for rendering, usePanelFocus for panel state,
 * useNavigation for within-panel navigation, and routeKey as
 * the single source of truth for keyboard handling.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { useKeyboard, useRenderer } from "@opentui/react";
import type React from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { TUI_REFRESH_ROLE } from "../core/event-bus.js";
import type { Claim, Contribution } from "../core/models.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import { buildBuiltInActions } from "./actions/builtin-actions.js";
import { buildPluginActions } from "./actions/plugin-adapter.js";
import { getReservedActionRegistryEntries } from "./actions/reserved-ids.js";
import { computeVisibleActions } from "./actions/visibility.js";
import { checkSpawn, checkSpawnDepth } from "./agents/spawn-validator.js";
import { agentIdFromSession } from "./agents/tmux-manager.js";
import { INITIAL_KEYBOARD_STATE, tuiReducer } from "./app-reducer.js";
import { CommandPalette } from "./components/command-palette.js";
import { HelpOverlay } from "./components/help-overlay.js";
import { InputBar } from "./components/input-bar.js";
import { type ScreenContext, StatusBar } from "./components/status-bar.js";
import { PanelBar } from "./components/tab-bar.js";
import { TooltipOverlay, useFirstLaunchTooltips } from "./components/tooltip-overlay.js";
import type { GroveUserConfig } from "./config-loader.js";
import { createTuiConfigWatcher } from "./config-watcher.js";
import { DagStateStore } from "./data/dag-state-store.js";
import { DagStateProvider } from "./hooks/dag-state-context.js";

export type { TuiAction, TuiKeyboardState } from "./app-reducer.js";
export { tuiReducer } from "./app-reducer.js";

import { useProviderScoped } from "./hooks/informer-context.js";
import { useRelistTrigger } from "./hooks/refresh-context.js";
import { useEventDrivenData } from "./hooks/use-event-driven-data.js";
import {
  type KeybindingOverrides,
  useKeybindingOverrides,
} from "./hooks/use-keybinding-overrides.js";
import type { KeyboardActions } from "./hooks/use-keyboard-handler.js";
import { nextZoom, routeKey } from "./hooks/use-keyboard-handler.js";
import { useNavigation } from "./hooks/use-navigation.js";
import { InputMode, Panel, usePanelFocus } from "./hooks/use-panel-focus.js";
import { useTuiStatePersistence } from "./hooks/use-session-persistence.js";
import { resolveKeymapWithOverrides } from "./keymap/keymap.js";
import type { ZoomLevel } from "./panels/panel-manager.js";
import { PanelManager } from "./panels/panel-manager.js";
import { getBuiltInTuiRegistryEntries } from "./panels/panel-registry.js";
import {
  collectTuiActionRegistrations,
  collectTuiPanelRegistrations,
  mergeTuiActionRegistrations,
  mergeTuiRegistrations,
} from "./plugins/registry.js";
import type { TuiExtension, TuiPluginContext } from "./plugins/types.js";
import {
  type DashboardData,
  type GitHubPRSummary,
  isCostProvider,
  isGitHubProvider,
  isGoalProvider,
  type TuiDataProvider,
} from "./provider.js";
import { mintTokenForCompensation } from "./safety/internal/compensation.js";
import { useSpawnManager } from "./spawn-manager-context.js";
import { replaceTheme, theme } from "./theme.js";

/** Props for the root App component. */
export interface AppProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly tmux?: import("./agents/tmux-manager.js").TmuxManager | undefined;
  readonly topology?: import("../core/topology.js").AgentTopology | undefined;
  /** Preset name — used for per-preset panel visibility filtering. */
  readonly presetName?: string | undefined;
  /** Resolved .grove directory path for session persistence. */
  readonly groveDir?: string | undefined;
  /** EventBus for event-driven data updates (Nexus mode). */
  readonly eventBus?: import("../core/event-bus.js").EventBus | undefined;
  /** AgentRuntime for spawning agents (acpx preferred over tmux). */
  readonly agentRuntime?: import("../core/agent-runtime.js").AgentRuntime | undefined;
  /** Frozen contract for session creation. */
  readonly contract?: import("../core/contract.js").GroveContract | undefined;
  /** User config preloaded in main.ts before React mounts (theme + keymap). */
  readonly userConfig?: GroveUserConfig | undefined;
  /** Resolved backend mode for delivery-path decisions. */
  readonly backendMode?: "local" | "remote" | "nexus" | undefined;
  /** When set, ScreenManager should scope the resumed session feed to this id. */
  readonly resumeSessionId?: string | undefined;
  /** When set, ScreenManager should open goal-input with this preset pre-selected (new session in existing grove). */
  readonly newSessionPreset?: string | undefined;
  /** Pre-fetched dashboard data — populates the first render before polling hooks fire. */
  readonly initialDashboard?: import("./provider.js").DashboardData | undefined;
  /** Trusted local-code TUI extensions. Grove does not dynamically load these. */
  readonly extensions?: readonly TuiExtension[] | undefined;
  /**
   * Which top-level screen is active. Drives the StatusBar `[INSPECT]` chip
   * so users always know whether the inspect overlay is on screen (#191).
   * Undefined means the chip is hidden (default for plain session view).
   */
  readonly screenContext?: ScreenContext | undefined;
}

const PAGE_SIZE = 20;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${n} tok`;
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

/** Root TUI application. */
export function App({
  provider,
  intervalMs,
  tmux,
  topology,
  presetName,
  groveDir,
  userConfig,
  eventBus,
  screenContext,
  extensions,
}: AppProps): React.ReactNode {
  const renderer = useRenderer();
  const nav = useNavigation();
  const panels = usePanelFocus();
  // DagStateStore — xray DAG UI state (#311). Constructed once at App
  // mount so collapse/highlight/focus survive every PanelManager
  // re-render. ScreenManager has its own equivalent; the two providers
  // are mounted on disjoint code paths (inspect overlay vs welcome flow).
  const [dagStateStore] = useState<DagStateStore>(() => new DagStateStore());
  const { showTooltips, dismissAll: dismissTooltips } = useFirstLaunchTooltips();
  const { savedState, saveState } = useTuiStatePersistence("global", groveDir);
  const fileOverrides = useKeybindingOverrides();
  const [hotkeyOverrides, setHotkeyOverrides] = useState<KeybindingOverrides>({});
  const [, setThemeRevision] = useState(0);
  // Merge config.json keymap (lower priority), hotkeys.yaml, then file-based overrides.
  const keybindingOverrides = useMemo(
    () => ({ ...userConfig?.keymap, ...hotkeyOverrides, ...fileOverrides }),
    [userConfig?.keymap, hotkeyOverrides, fileOverrides],
  );
  const resolvedKeymap = useMemo(
    () => resolveKeymapWithOverrides(userConfig?.keymapPreset ?? "default", keybindingOverrides),
    [userConfig?.keymapPreset, keybindingOverrides],
  );
  const [keymapPrefix, setKeymapPrefix] = useState<readonly string[]>([]);
  const [ks, dispatch] = useReducer(tuiReducer, INITIAL_KEYBOARD_STATE);
  const resolvedKeymapRef = useRef(resolvedKeymap);

  useEffect(() => {
    if (resolvedKeymapRef.current === resolvedKeymap) return;
    resolvedKeymapRef.current = resolvedKeymap;
    setKeymapPrefix([]);
  }, [resolvedKeymap]);

  // Restore persisted state on first load.
  // restoredRef gates both restore AND save — save must not run before restore.
  // savedState === undefined means still loading; null means no prior state.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || savedState === undefined || savedState === null) {
      // null = no prior state → mark restored so saves can proceed
      if (savedState === null) restoredRef.current = true;
      return;
    }
    restoredRef.current = true;
    // Restore zoom level
    if (savedState.zoomLevel && savedState.zoomLevel !== "normal") {
      let current: ZoomLevel = "normal";
      while (current !== savedState.zoomLevel) {
        dispatch({ type: "ZOOM_CYCLE" });
        current = nextZoom(current);
      }
    }
    // Restore search query
    if (savedState.searchQuery) {
      for (const ch of savedState.searchQuery) {
        dispatch({ type: "SEARCH_CHAR", char: ch });
      }
      dispatch({ type: "SEARCH_SUBMIT" });
    }
    // Restore visible operator panels FIRST (so focus can land on them)
    if (savedState.visibleOperatorPanels) {
      for (const p of savedState.visibleOperatorPanels) {
        panels.toggle(p as import("./hooks/use-panel-focus.js").Panel);
      }
    }
    // Restore focused panel AFTER panels are visible
    if (savedState.focusedPanel !== undefined) {
      panels.focus(savedState.focusedPanel as import("./hooks/use-panel-focus.js").Panel);
    }
  }, [savedState, panels]);

  // Persist state on changes.
  // Gated by restoredRef to prevent saving default state before async restore completes.
  useEffect(() => {
    if (!restoredRef.current) return;
    const visibleOps = [...panels.state.visibleOperator];
    saveState({
      zoomLevel: ks.zoomLevel,
      searchQuery: ks.searchQuery || undefined,
      focusedPanel: panels.state.focused,
      visibleOperatorPanels: visibleOps.length > 0 ? visibleOps : undefined,
    });
  }, [ks.zoomLevel, ks.searchQuery, panels.state.focused, panels.state.visibleOperator, saveState]);

  const [contributionList, setContributionList] = useState<readonly Contribution[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [selectedSession, setSelectedSession] = useState<string | undefined>();
  // Frontier active-slice state lives in refs (not React state) because the
  // keyboard handler must read the current value synchronously. If terminal
  // input delivers `]` then `a` (or `]` then Enter in compare mode) within
  // the same JS tick, a setState-based snapshot would still hold the
  // previous slice's data because React hasn't committed yet — that would
  // adopt/select a row from the wrong slice. Refs are mutated synchronously
  // by the FrontierView callback AND by slice-nav handlers; no rendering
  // depends on these values, so state is unnecessary.
  const frontierCidsRef = useRef<readonly string[]>([]);
  const frontierEntriesRef = useRef<ReadonlyArray<{ cid: string; summary: string }>>([]);

  // Last error for status bar display (auto-clears after 5s)
  const [lastError, setLastError] = useState<string | undefined>();
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showError = useCallback((message: string) => {
    if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
    setLastError(message);
    errorTimerRef.current = setTimeout(() => setLastError(undefined), 5_000);
  }, []);

  const pluginActionRegistrations = useMemo(
    () => collectTuiActionRegistrations(extensions),
    [extensions],
  );
  const mergedActionRegistry = useMemo(
    () =>
      mergeTuiActionRegistrations({
        builtIns: getReservedActionRegistryEntries(),
        plugins: pluginActionRegistrations,
      }),
    [pluginActionRegistrations],
  );
  const pluginPanelRegistrations = useMemo(
    () => collectTuiPanelRegistrations(extensions),
    [extensions],
  );
  const mergedPanelRegistry = useMemo(
    () =>
      mergeTuiRegistrations({
        builtIns: getBuiltInTuiRegistryEntries(),
        plugins: pluginPanelRegistrations,
      }),
    [pluginPanelRegistrations],
  );
  const pluginContext = useMemo<TuiPluginContext>(
    () => ({
      provider,
      topology,
      selectedSession,
      selectedCid: nav.detailCid,
      density: ks.layoutMode === "tab" ? "compact" : "comfortable",
      showMessage: showError,
    }),
    [provider, topology, selectedSession, nav.detailCid, ks.layoutMode, showError],
  );

  useEffect(() => {
    for (const diagnostic of mergedActionRegistry.diagnostics) {
      showError(diagnostic.message);
    }
  }, [mergedActionRegistry.diagnostics, showError]);

  useEffect(() => {
    for (const diagnostic of mergedPanelRegistry.diagnostics) {
      showError(diagnostic.message);
    }
  }, [mergedPanelRegistry.diagnostics, showError]);

  useEffect(() => {
    let cancelled = false;
    const projectRoot = groveDir !== undefined ? dirname(groveDir) : undefined;
    const watcher = createTuiConfigWatcher({ projectRoot });
    const unsubscribe = watcher.subscribe((event) => {
      if (cancelled) return;
      if (event.type === "ConfigError") {
        showError(event.message);
        return;
      }
      if (event.changed === "hotkeys") {
        setHotkeyOverrides(event.config.hotkeys);
      }
      if (event.changed === "theme") {
        replaceTheme({ ...userConfig?.theme, ...event.config.theme });
        setThemeRevision((revision) => revision + 1);
      }
    });
    void watcher
      .start()
      .then(() => {
        if (cancelled) return;
        const config = watcher.current();
        setHotkeyOverrides(config.hotkeys);
        replaceTheme({ ...userConfig?.theme, ...config.theme });
        setThemeRevision((revision) => revision + 1);
      })
      .catch((err) => {
        if (!cancelled) showError(err instanceof Error ? err.message : "config watcher failed");
      });
    return () => {
      cancelled = true;
      unsubscribe();
      void watcher.stop();
    };
  }, [groveDir, showError, userConfig?.theme]);

  // SpawnManager singleton — provided by tui-app.tsx via SpawnManagerContext.
  const spawnManager = useSpawnManager();

  // Reconcile persisted sessions on startup (reattach live, clean dead)
  useEffect(() => {
    spawnManager.reconcile().catch(() => {
      // Reconciliation is best-effort — don't block TUI startup
    });
  }, [spawnManager]);

  // Cleanup error timer on unmount (SpawnManager cleanup is owned by tui-app.tsx)
  useEffect(() => {
    return () => {
      if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
    };
  }, []);

  // Poll active claims for topology-aware command palette.
  // In scoped sessions, `provider.getClaims` is namespace-global (no session
  // filter) and would surface claims from other sessions — corrupting spawn-
  // capacity checks and parent-depth calculations. We can't just stop the
  // fetch (the hook would retain whatever it already had); we also project
  // the result through `useMemo` so consumers see `undefined` (= "unknown")
  // in scoped mode rather than a stale or empty list. Spawn paths that read
  // `activeClaims` MUST treat `undefined` as "topology validation
  // unavailable", not as "zero claims". See `handleSpawn` below.
  const isScopedForClaims = useProviderScoped(provider);
  const claimsFetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
  const { data: rawActiveClaims, refresh: refreshClaims } = useEventDrivenData<readonly Claim[]>(
    claimsFetcher,
    undefined,
    undefined,
    topology !== undefined && !isScopedForClaims,
  );
  const activeClaims = useMemo<readonly Claim[] | null>(
    () => (isScopedForClaims ? null : rawActiveClaims),
    [isScopedForClaims, rawActiveClaims],
  );

  // Poll tmux sessions — used by command palette, agent count, split pane,
  // and transcript search. Always active when tmux is available (fix #3).
  const paletteVisible = panels.state.mode === InputMode.CommandPalette;
  const sessionsFetcher = useCallback(async () => {
    if (!tmux) return [] as readonly string[];
    const available = await tmux.isAvailable();
    if (!available) return [] as readonly string[];
    return tmux.listSessions();
  }, [tmux]);
  const { data: paletteSessions, refresh: refreshSessions } = useEventDrivenData<readonly string[]>(
    sessionsFetcher,
    undefined,
    undefined,
    tmux !== undefined,
  );

  // Poll session costs — skip if provider doesn't support it (15B)
  const hasCosts = isCostProvider(provider);
  const costFetcher = useCallback(async () => {
    if (!hasCosts) return undefined;
    return (
      provider as TuiDataProvider & {
        getSessionCosts: () => Promise<{ totalCostUsd: number; totalTokens: number }>;
      }
    ).getSessionCosts();
  }, [provider, hasCosts]);
  const { data: sessionCosts, refresh: refreshCosts } = useEventDrivenData<
    { totalCostUsd: number; totalTokens: number } | undefined
  >(
    costFetcher,
    undefined,
    undefined,
    hasCosts, // Only fetch when provider actually supports costs
  );

  // Poll active PR and set context on SpawnManager so agents get env vars
  const hasGitHub = isGitHubProvider(provider);
  const prFetcher = useCallback(async (): Promise<GitHubPRSummary | undefined> => {
    if (!hasGitHub) return undefined;
    return (
      provider as TuiDataProvider & { getActivePR: () => Promise<GitHubPRSummary | undefined> }
    ).getActivePR();
  }, [provider, hasGitHub]);
  const { data: activePR, refresh: refreshPR } = useEventDrivenData<GitHubPRSummary | undefined>(
    prFetcher,
    undefined,
    undefined,
    hasGitHub,
  );

  // Poll dashboard for goal metadata (shown in status bar)
  const dashboardFetcher = useCallback(() => provider.getDashboard(), [provider]);
  const { data: dashboardData, refresh: refreshDashboard } = useEventDrivenData<DashboardData>(
    dashboardFetcher,
    undefined,
    undefined,
    true,
  );

  // Sync PR context to SpawnManager whenever it changes
  useEffect(() => {
    if (activePR) {
      spawnManager.setPrContext({
        number: activePR.number,
        title: activePR.title,
        filesChanged: activePR.filesChanged,
      });
    } else {
      spawnManager.setPrContext(undefined);
    }
  }, [activePR, spawnManager]);

  // Poll gossip peers for delegate items in command palette
  const gossipFetcher = useCallback(async () => {
    const gp = provider as unknown as {
      getGossipPeers?: () => Promise<
        readonly { peerId: string; address: string; freeSlots?: number; totalSlots?: number }[]
      >;
    };
    if (!gp.getGossipPeers) return undefined;
    const peers = await gp.getGossipPeers();
    return peers
      .filter(
        (p): p is typeof p & { freeSlots: number; totalSlots: number } =>
          p.freeSlots !== undefined && p.freeSlots > 0,
      )
      .map((p) => ({ peerId: p.peerId, address: p.address, freeSlots: p.freeSlots }));
  }, [provider]);
  const { data: gossipPeers, refresh: refreshGossip } = useEventDrivenData(
    gossipFetcher,
    undefined,
    undefined,
    paletteVisible,
  );

  // Poll pending questions for the answer-question palette actions.
  const pendingQuestionsFetcher = useCallback(async (): Promise<number> => {
    const askProvider = provider as unknown as {
      getPendingQuestions?: () => Promise<readonly unknown[]>;
    };
    if (!askProvider.getPendingQuestions) return 0;
    try {
      return (await askProvider.getPendingQuestions()).length;
    } catch {
      return 0;
    }
  }, [provider]);
  const { data: pendingQuestionCount, refresh: refreshPendingQuestions } =
    useEventDrivenData<number>(pendingQuestionsFetcher, undefined, undefined, paletteVisible);

  // Derive parentAgentId from the selected session for lineage-aware palette display
  const paletteParentId = selectedSession ? agentIdFromSession(selectedSession) : undefined;

  // Derive the palette items so the keyboard handler can look up the selected action.
  // Only advertise spawn if the provider supports workspace checkout (remote does not).
  const canSpawn = provider.checkoutWorkspace !== undefined;

  // Peer delegation posts to a peer server's /api/agents/spawn.
  // When namespace auth is active (remote provider has auth headers OR the
  // local grove has a namespace file) every peer server requires its own bearer
  // token — one we have no mechanism to obtain or forward — so delegation
  // would always fail with 400/401. Hide the action in those cases.
  const canDelegate = useMemo(() => {
    const rp = provider as unknown as { httpAuthHeaders?: Record<string, string> };
    if (rp.httpAuthHeaders && Object.keys(rp.httpAuthHeaders).length > 0) return false;
    if (groveDir && existsSync(join(groveDir, "namespace"))) return false;
    return true;
  }, [provider, groveDir]);

  // Load agent profiles from .grove/agents.json
  const profilesFetcher = useCallback(async () => {
    try {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const path = resolve(process.cwd(), ".grove", "agents.json");
      const json = readFileSync(path, "utf-8");
      const { parseAgentProfiles } = await import("../core/agent-profile.js");
      return parseAgentProfiles(json).profiles.map((p) => ({
        name: p.name,
        role: p.role,
        platform: p.platform,
        command: p.command,
      }));
    } catch {
      return undefined;
    }
  }, []);
  const { data: agentProfiles, refresh: refreshProfiles } = useEventDrivenData(
    profilesFetcher,
    undefined,
    undefined,
    true,
  );

  // Build terminal buffer map for cross-agent transcript search (item 17)
  const activeGroveSessions = useMemo(
    () => paletteSessions?.filter((s) => s.startsWith("grove-")) ?? [],
    [paletteSessions],
  );
  const terminalBuffersFetcher = useCallback(async () => {
    if (!tmux || activeGroveSessions.length === 0) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const s of activeGroveSessions) {
      try {
        const out = await tmux.capturePanes(s);
        map.set(s, out);
      } catch {
        // skip failed captures
      }
    }
    return map;
  }, [tmux, activeGroveSessions]);
  const { data: terminalBuffers, refresh: refreshTerminalBuffers } = useEventDrivenData<
    Map<string, string>
  >(terminalBuffersFetcher, undefined, undefined, activeGroveSessions.length > 0);

  // Global refresh trigger from <RefreshProvider> (mounted by main.ts).
  // Bumps the numeric signal that panel-level useEventDrivenData subscribers
  // ride via useRefreshSignal, and fires factory.relist() for informer-backed
  // views in the same call.
  const triggerGlobalRefresh = useRelistTrigger();

  // Fan-out refresh: triggers the global refresh signal AND App-level
  // fetcher refreshes so legacy non-event-driven panels also re-fetch.
  const refreshAll = useCallback(() => {
    triggerGlobalRefresh();
    refreshClaims();
    refreshSessions();
    refreshCosts();
    refreshPR();
    refreshDashboard();
    refreshGossip();
    refreshPendingQuestions();
    refreshProfiles();
    refreshTerminalBuffers();
  }, [
    triggerGlobalRefresh,
    refreshClaims,
    refreshSessions,
    refreshCosts,
    refreshPR,
    refreshDashboard,
    refreshGossip,
    refreshPendingQuestions,
    refreshProfiles,
    refreshTerminalBuffers,
  ]);

  // SSE push → global refresh fan-out. Calling triggerGlobalRefresh here makes
  // every panel-level useEventDrivenData (DAG, Frontier, Dashboard …) re-fetch
  // immediately instead of waiting for the next event.
  // The Feed view also subscribes directly inside running-view for fast-path
  // refresh without a full app re-render — that path stays as defense in
  // depth and is not removed here.
  useEffect(() => {
    if (!eventBus) return;
    const topologyRoles = topology?.roles.map((r) => r.name) ?? [];
    // TUI_REFRESH_ROLE catches producer events (vfs.changed, agent.output,
    // github.pr.changed) that don't target an agent role. Always subscribe
    // so the fan-out works even before topology resolves.
    const roles = [...topologyRoles, TUI_REFRESH_ROLE];
    const handler = () => {
      // Invalidate provider TTL caches BEFORE bumping the refresh signal.
      // The store-backed provider hands back its last full scan inside
      // the 2 s list-cache window; without invalidation a contribution
      // landing 1.5 s after the previous scan would still return the
      // pre-arrival snapshot and the UI would not update until the
      // next 30 s fallback poll.
      provider.invalidateCaches?.();
      triggerGlobalRefresh();
    };
    for (const role of roles) eventBus.subscribe(role, handler);
    return () => {
      for (const role of roles) eventBus.unsubscribe(role, handler);
    };
  }, [eventBus, topology, provider, triggerGlobalRefresh]);

  const hasGoals = isGoalProvider(provider);

  const handleContributionsLoaded = useCallback((contributions: readonly Contribution[]) => {
    if (!contributions) return;
    setContributionList(contributions);
    setRowCount(contributions.length);
  }, []);

  const handleRowCountChanged = useCallback((count: number) => {
    setRowCount(count);
  }, []);

  const handleFrontierCidsChanged = useCallback((cids: readonly string[]) => {
    frontierCidsRef.current = cids;
  }, []);

  const handleFrontierEntriesChanged = useCallback(
    (entries: ReadonlyArray<{ cid: string; summary: string }>) => {
      frontierEntriesRef.current = entries;
    },
    [],
  );

  const handleSelect = useCallback(
    (index: number) => {
      const contribution = contributionList[index];
      if (contribution) {
        nav.pushDetail(contribution.cid);
      }
    },
    [contributionList, nav],
  );

  const handleApproveQuestion = useCallback(async () => {
    const askProvider = provider as unknown as {
      answerQuestion?: (cid: string, answer: string) => Promise<void>;
      getPendingQuestions?: () => Promise<readonly { cid: string; options?: readonly string[] }[]>;
    };
    if (!askProvider.answerQuestion || !askProvider.getPendingQuestions) return;

    try {
      const questions = await askProvider.getPendingQuestions();
      const selected = questions[nav.state.cursor];
      if (!selected) return;

      const answer = selected.options?.[0] ?? "Approved";
      await askProvider.answerQuestion(selected.cid, answer);
      showError(`Answered: ${answer}`);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to answer");
    }
  }, [provider, nav.state.cursor, showError]);

  const answerPendingQuestion = useCallback(
    async (verdict: "approve" | "deny") => {
      const askProvider = provider as unknown as {
        answerQuestion?: (cid: string, answer: string) => Promise<void>;
        getPendingQuestions?: () => Promise<
          readonly { cid: string; options?: readonly string[] }[]
        >;
      };
      if (!askProvider.answerQuestion || !askProvider.getPendingQuestions) return;
      try {
        const questions = await askProvider.getPendingQuestions();
        const selected = questions[0];
        if (!selected) return;
        const answer = verdict === "approve" ? (selected.options?.[0] ?? "Approved") : "Denied";
        await askProvider.answerQuestion(selected.cid, answer);
        showError(`Answered: ${answer}`);
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to answer");
      }
    },
    [provider, showError],
  );

  /** Send a message via the boardroom API or local provider. */
  const sendTuiMessage = useCallback(
    async (recipients: string, body: string) => {
      try {
        // Try local provider first (has direct store access)
        const mp = provider as unknown as {
          sendMessage?: (body: string, recipients: string[]) => Promise<void>;
        };
        if (mp.sendMessage) {
          await mp.sendMessage(
            body,
            recipients.split(",").map((r) => r.trim()),
          );
          showError(`Sent to ${recipients}`);
          return;
        }
        // Fallback: POST to boardroom endpoint (works for remote providers)
        const rp = provider as unknown as {
          baseUrl?: string;
          httpAuthHeaders?: Record<string, string>;
        };
        const baseUrl = rp.baseUrl ?? "http://localhost:4515";
        const resp = await fetch(`${baseUrl}/api/boardroom/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...rp.httpAuthHeaders },
          body: JSON.stringify({
            body,
            recipients: recipients.split(",").map((r) => r.trim()),
          }),
        });
        if (resp.ok) {
          showError(`Sent to ${recipients}`);
        } else {
          showError(`Send failed: HTTP ${String(resp.status)}`);
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : "Send failed");
      }
    },
    [provider, showError],
  );

  /** Delegate work to a gossip peer by calling its /api/agents/spawn endpoint. */
  const handleDelegate = useCallback(
    async (peerAddress: string) => {
      const role = topology?.roles[0]?.name ?? "worker";
      try {
        const resp = await fetch(`${peerAddress.replace(/\/+$/, "")}/api/agents/spawn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });
        if (!resp.ok) {
          const body = (await resp.json()) as { error?: string };
          showError(`Delegation failed: ${body.error ?? `HTTP ${String(resp.status)}`}`);
          return;
        }
        const body = (await resp.json()) as { agentId: string; role: string };
        showError(`Delegated to peer: ${body.agentId} (${body.role})`);
      } catch (err) {
        showError(err instanceof Error ? err.message : "Delegation failed");
      }
    },
    [showError, topology],
  );

  const handleDenyQuestion = useCallback(async () => {
    const askProvider = provider as unknown as {
      answerQuestion?: (cid: string, answer: string) => Promise<void>;
      getPendingQuestions?: () => Promise<readonly { cid: string }[]>;
    };
    if (!askProvider.answerQuestion || !askProvider.getPendingQuestions) return;

    try {
      const questions = await askProvider.getPendingQuestions();
      const selected = questions[nav.state.cursor];
      if (!selected) return;
      await askProvider.answerQuestion(selected.cid, "Denied");
      showError("Answered: Denied");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to answer");
    }
  }, [provider, nav.state.cursor, showError]);

  const handleQuit = useCallback(() => {
    provider.close();
    renderer.destroy();
  }, [provider, renderer]);

  /**
   * Spawn a new agent session via SpawnManager.
   * Validates topology constraints, then delegates lifecycle to SpawnManager.
   */
  const handleSpawn = useCallback(
    (agentId: string, command: string, _target: string, parentAgentId?: string) => {
      // In scoped sessions `activeClaims` is null because we can't see only
      // this session's claims through the namespace-global getClaims API.
      // Refusing to spawn here is the conservative choice — substituting
      // an empty array would let scoped operators bypass `maxInstances`,
      // `maxChildrenPerAgent`, and depth limits enforced by checkSpawn /
      // checkSpawnDepth. Lift this restriction once getClaims supports
      // session-scoped filtering.
      if (activeClaims === null) {
        showError(
          "Spawn unavailable in scoped session (topology checks need session-scoped claims)",
        );
        return;
      }

      const spawnCheck = checkSpawn(topology, agentId, activeClaims, parentAgentId);
      if (!spawnCheck.allowed) return;

      let depth = 0;
      if (parentAgentId !== undefined) {
        const parentClaim = activeClaims.find((c) => c.agent.agentId === parentAgentId);
        const parentDepth =
          typeof parentClaim?.context?.depth === "number" ? parentClaim.context.depth : 0;
        depth = parentDepth + 1;
      }

      const depthCheck = checkSpawnDepth(topology, depth);
      if (!depthCheck.allowed) return;

      // Look up role config from topology to inject as agent context.
      const role = topology?.roles.find((r) => r.name === agentId);
      const context: Record<string, unknown> = {};
      if (role?.prompt) context.rolePrompt = role.prompt;
      if (role?.description) context.roleDescription = role.description;
      if (role?.goal) context.roleGoal = role.goal;
      if (role?.skills && role.skills.length > 0) context.skills = role.skills;
      if (role?.platform) context.platform = role.platform;
      if (role?.model) context.model = role.model;
      if (topology) context.topology = topology;
      // Snapshot adoptContext into the spawn-call context, then clear it
      // synchronously. Two reasons:
      //  1. Race-safety: if spawn A is in flight and the user starts spawn B
      //     with a new adoptContext, an async clear in A's success handler
      //     would clobber B's pending target. Synchronous clear here means
      //     B's ADOPT_SET runs after A's clear.
      //  2. Failure path: if spawn rejects, the stale target would otherwise
      //     leak into the next palette open. The spawn already has its copy
      //     in `context` regardless of subsequent reducer state.
      if (ks.adoptContext) {
        context.adoptTarget = ks.adoptContext.targetCid;
        context.adoptSummary = ks.adoptContext.summary;
        dispatch({ type: "ADOPT_CLEAR" });
      }

      spawnManager.spawn(agentId, command, parentAgentId, depth, context).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Spawn failed";
        showError(msg);
      });
    },
    [topology, activeClaims, showError, spawnManager, ks.adoptContext],
  );

  /** Kill tmux session → stop heartbeat → release claim → clean workspace. */
  const handleKill = useCallback(
    (sessionName: string) => {
      spawnManager.kill(sessionName).catch((err) => {
        const msg = err instanceof Error ? err.message : "Kill failed";
        showError(msg);
      });
    },
    [showError, spawnManager],
  );

  const registerAgentProfile = useCallback(() => {
    void (async () => {
      try {
        const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const dir = resolve(process.cwd(), ".grove");
        const path = resolve(dir, "agents.json");
        if (!existsSync(path)) {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const template = JSON.stringify(
            {
              profiles: [
                {
                  name: "@agent-1",
                  role: topology?.roles[0]?.name ?? "worker",
                  platform: "claude-code",
                  command: "claude --dangerously-skip-permissions",
                },
              ],
            },
            null,
            2,
          );
          writeFileSync(path, template);
          showError(`Created ${path} — edit to add agent profiles`);
        } else {
          showError(
            `Profiles loaded from ${path} (${String(agentProfiles?.length ?? 0)} profiles)`,
          );
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : "Registration failed");
      }
    })();
  }, [topology, agentProfiles, showError]);

  const handleCommandPaletteClose = useCallback(() => {
    dispatch({ type: "ADOPT_CLEAR" });
    panels.setMode(InputMode.Normal);
    dispatch({ type: "PALETTE_RESET" });
  }, [panels]);

  const mkPluginCtx = useCallback(
    (ctx: import("./actions/types.js").ActionContext): TuiPluginContext => ({
      // Keep the narrow plugin surface but hand plugins the panel-aware
      // selection, not the detail-only cid baked into pluginContext.
      ...pluginContext,
      selectedCid: ctx.selectedCid,
    }),
    [pluginContext],
  );

  const actionContext = useMemo<import("./actions/types.js").ActionContext>(
    () => ({
      topology,
      sessions: paletteSessions ?? [],
      profiles: agentProfiles ?? [],
      gossipPeers: canDelegate ? (gossipPeers ?? []) : [],
      claims: activeClaims,
      selectedSession,
      // The contribution the operator would act on, resolved by FOCUSED PANEL.
      // Frontier keeps its own per-slice cursor→cid list in frontierEntriesRef;
      // a row miss (empty/loading/stale slice, out-of-range cursor) yields
      // undefined so the contribution actions DISAPPEAR rather than silently
      // acting on the open detail. Every other panel acts on the open detail
      // (nav.detailCid) — the only other unambiguous contribution selection.
      // (Activity is intentionally NOT a source: the rendered Activity panel
      // doesn't populate contributionList, so indexing it would alias a stale
      // DAG/Dashboard row.)
      selectedCid:
        panels.state.focused === Panel.Frontier
          ? frontierEntriesRef.current[nav.state.cursor]?.cid
          : nav.detailCid,
      detailCid: nav.detailCid,
      parentAgentId: paletteParentId,
      pendingQuestionCount: pendingQuestionCount ?? 0,
      hasGoals,
      canSpawn,
      canDelegate,
      isPanelVisible: (panel) => panels.isVisible(panel),
      focusedPanel: panels.state.focused,
      frontierSliceCount: ks.frontierTabKeys.length,
      focusPanel: (panel) => panels.focus(panel),
      togglePanel: (panel) => panels.toggle(panel),
      cyclePanelNext: () => panels.cycleNext(),
      cyclePanelPrev: () => panels.cyclePrev(),
      openContribution: (cid) => nav.pushDetail(cid),
      jumpToSession: (session) => {
        setSelectedSession(session);
        // Reveal the Terminal panel (focus if already shown; toggle would hide).
        if (panels.isVisible(Panel.Terminal)) panels.focus(Panel.Terminal);
        else panels.toggle(Panel.Terminal);
      },
      enterGoalMode: () => {
        panels.setMode(InputMode.GoalInput);
        dispatch({ type: "GOAL_INPUT_MODE" });
      },
      // Idempotent ENTRY: only toggle when compare mode is off. Wiring straight
      // to COMPARE_TOGGLE would turn compare OFF if invoked while already on.
      enterCompareMode: () => {
        if (!ks.compareMode) dispatch({ type: "COMPARE_TOGGLE" });
      },
      addToCompare: (cid) => {
        // Entering compare mode clears compareCids, so if it is currently off
        // we must toggle it ON first, then select — otherwise the operator's
        // later COMPARE_TOGGLE would wipe the cid added here.
        if (!ks.compareMode) dispatch({ type: "COMPARE_TOGGLE" });
        dispatch({ type: "COMPARE_SELECT", cid });
      },
      adoptContribution: (cid, summary) => {
        dispatch({ type: "ADOPT_SET", targetCid: cid, summary });
        panels.setMode(InputMode.CommandPalette);
      },
      answerPendingQuestion: (verdict) => void answerPendingQuestion(verdict),
      registerAgentProfile,
      spawn: (roleId, command, parentAgentId) =>
        handleSpawn(roleId, command, "HEAD", parentAgentId),
      kill: (session) => handleKill(session),
      delegate: (peerAddress) => void handleDelegate(peerAddress),
      broadcastMessage: () => {
        dispatch({ type: "BROADCAST_MODE" });
        panels.setMode(InputMode.MessageInput);
      },
      directMessage: () => {
        dispatch({ type: "DIRECT_MESSAGE_MODE" });
        panels.setMode(InputMode.MessageInput);
      },
      refresh: refreshAll,
      enterSearch: () => {
        // Reveal + focus the Search panel before entering input mode — otherwise
        // the user types into an invisible buffer (the keyboard '/' path relies
        // on the panel already being visible). toggle adds-and-focuses when
        // hidden; focus when already shown (toggle would hide it).
        if (panels.isVisible(Panel.Search)) panels.focus(Panel.Search);
        else panels.toggle(Panel.Search);
        dispatch({ type: "SEARCH_START", currentQuery: ks.searchQuery });
        panels.setMode(InputMode.SearchInput);
      },
      cycleZoom: () => dispatch({ type: "ZOOM_CYCLE" }),
      resetZoom: () => dispatch({ type: "ZOOM_RESET" }),
      toggleLayout: () => dispatch({ type: "LAYOUT_TOGGLE" }),
      cycleViewMode: () => panels.cycleViewMode(),
      showHelp: () => panels.setMode(InputMode.Help),
      quit: handleQuit,
      // Mirror the keyboard frontier-slice handlers: rotate slice, reset the
      // cursor, and synchronously clear the entry/cid refs so a follow-up
      // adopt/select reads the new slice (see onFrontierTabNext).
      nextFrontierSlice: () => {
        dispatch({ type: "FRONTIER_SLICE_NEXT" });
        nav.resetCursor();
        frontierEntriesRef.current = [];
        frontierCidsRef.current = [];
      },
      prevFrontierSlice: () => {
        dispatch({ type: "FRONTIER_SLICE_PREV" });
        nav.resetCursor();
        frontierEntriesRef.current = [];
        frontierCidsRef.current = [];
      },
      scrollTerminalToBottom: () => dispatch({ type: "TERMINAL_SCROLL_BOTTOM" }),
      showMessage: showError,
    }),
    [
      topology,
      paletteSessions,
      agentProfiles,
      gossipPeers,
      canDelegate,
      activeClaims,
      selectedSession,
      nav,
      paletteParentId,
      pendingQuestionCount,
      hasGoals,
      canSpawn,
      panels,
      nav.state.cursor,
      ks.frontierTabKeys,
      ks.searchQuery,
      ks.compareMode,
      answerPendingQuestion,
      registerAgentProfile,
      handleSpawn,
      handleKill,
      handleDelegate,
      refreshAll,
      handleQuit,
      showError,
    ],
  );

  const paletteActions = useMemo(
    () => [
      ...buildBuiltInActions(actionContext),
      ...buildPluginActions(mergedActionRegistry.entries, mkPluginCtx),
    ],
    [actionContext, mergedActionRegistry.entries, mkPluginCtx],
  );

  const visiblePaletteActions = useMemo(
    () => computeVisibleActions(paletteActions, actionContext, ks.paletteQuery),
    [paletteActions, actionContext, ks.paletteQuery],
  );

  // ---------------------------------------------------------------------------
  // KeyboardActions adapter — maps routeKey callbacks to state transitions.
  // Palette execution now runs through `actionContext`/`action.run`; the paste-
  // safety path and other handlers remain here for closure access to
  // spawnManager, etc.
  // ---------------------------------------------------------------------------

  const keyboardActions: KeyboardActions = useMemo(
    () => ({
      panels,
      nav,
      onQuit: handleQuit,
      onSpawnPalette: () => {
        // Defensive: opening a fresh palette must not inherit a stale adopt
        // target from a previous 'a'-on-Frontier press that was dismissed
        // through a path other than onPaletteClose.
        dispatch({ type: "ADOPT_CLEAR" });
        dispatch({ type: "PALETTE_RESET" });
      },
      onPaletteClose: handleCommandPaletteClose,
      onZoomCycle: () => dispatch({ type: "ZOOM_CYCLE" }),
      onZoomReset: () => dispatch({ type: "ZOOM_RESET" }),
      onTerminalScrollUp: () => dispatch({ type: "TERMINAL_SCROLL_UP" }),
      onTerminalScrollDown: () => dispatch({ type: "TERMINAL_SCROLL_DOWN" }),
      onTerminalScrollBottom: () => dispatch({ type: "TERMINAL_SCROLL_BOTTOM" }),
      onLayoutToggle: () => dispatch({ type: "LAYOUT_TOGGLE" }),
      onRefresh: refreshAll,
      onVfsNavigate: () => dispatch({ type: "VFS_NAVIGATE" }),
      onArtifactPrev: () => dispatch({ type: "ARTIFACT_PREV" }),
      onArtifactNext: () => dispatch({ type: "ARTIFACT_NEXT" }),
      onArtifactDiffToggle: () => dispatch({ type: "ARTIFACT_DIFF_TOGGLE" }),
      onCompareToggle: () => dispatch({ type: "COMPARE_TOGGLE" }),
      onCompareSelect: (cid: string) => dispatch({ type: "COMPARE_SELECT", cid }),
      onCompareAdopt: (side: "a" | "b") => {
        const cid = side === "a" ? ks.compareCids[0] : ks.compareCids[1];
        if (!cid) return;
        // Read from refs (synchronous current value) — same race-safety
        // discipline as the 'a' adopt path.
        const summary =
          frontierEntriesRef.current.find((e) => e.cid === cid)?.summary ??
          contributionList.find((c) => c.cid === cid)?.summary ??
          "";
        dispatch({ type: "ADOPT_SET", targetCid: cid, summary });
        dispatch({ type: "COMPARE_ADOPT" });
        panels.setMode(InputMode.CommandPalette);
      },
      onSearchStart: () => {
        dispatch({ type: "SEARCH_START", currentQuery: ks.searchQuery });
        panels.setMode(InputMode.SearchInput);
      },
      onSearchSubmit: () => {
        dispatch({ type: "SEARCH_SUBMIT" });
        panels.setMode(InputMode.Normal);
      },
      onSearchChar: (char: string) => dispatch({ type: "SEARCH_CHAR", char }),
      onSearchBackspace: () => dispatch({ type: "SEARCH_BACKSPACE" }),
      onMessageSubmit: () => {
        const buf = ks.messageBuffer.trim();
        if (buf) {
          if (ks.messageRecipients === "@direct") {
            const match = buf.match(/^(@\S+)\s+(.+)/s);
            if (match) {
              const recipient = match[1] ?? "";
              const body = match[2] ?? "";
              void sendTuiMessage(recipient, body);
            } else {
              showError("Usage: @recipient message");
            }
          } else if (ks.messageRecipients) {
            void sendTuiMessage(ks.messageRecipients, buf);
          }
        }
        dispatch({ type: "MESSAGE_CLEAR" });
        panels.setMode(InputMode.Normal);
      },
      onMessageChar: (char: string) => dispatch({ type: "MESSAGE_CHAR", char }),
      onMessageBackspace: () => dispatch({ type: "MESSAGE_BACKSPACE" }),
      onGoalSubmit: () => {
        const buf = ks.goalBuffer.trim();
        if (buf && isGoalProvider(provider)) {
          void (async () => {
            try {
              // C6 (#304): Goal is not yet a WatchKind, so we cannot route
              // through `useConfirmAndMutate` (which requires an entity
              // snapshot). The goal-input screen already serves as the
              // operator confirmation UI — the user hit Enter to submit —
              // so we mint a compensation token from the current goal's
              // RV inline. CAS is still enforced server-side.
              const current = await provider.getGoal().catch(() => undefined);
              // C6 (#304) round-2: server's dangerous() middleware rejects
              // empty If-Match with 428 BEFORE the store's CAS-bypass-on-
              // insert path runs. Use "0" as the create sentinel — it
              // doesn't match any persisted RV (which start at 1) so the
              // server returns 409 if a row already exists, and the
              // store's insert path bypasses CAS unconditionally.
              const rv =
                current?.resourceVersion !== undefined ? String(current.resourceVersion) : "0";
              const token = mintTokenForCompensation("Goal", "goal", rv);
              await provider.setGoal(token, buf, []);
              showError(`Goal set: ${buf}`);
            } catch (err) {
              showError(err instanceof Error ? err.message : "Failed to set goal");
            }
          })();
        }
        // Also set on SpawnManager so agents receive the goal in CLAUDE.md + command args
        if (buf) {
          spawnManager.setSessionGoal(buf);
        }
        dispatch({ type: "GOAL_SUBMIT" });
        panels.setMode(InputMode.Normal);
      },
      onGoalChar: (char: string) => dispatch({ type: "GOAL_CHAR", char }),
      onGoalBackspace: () => dispatch({ type: "GOAL_BACKSPACE" }),
      onBroadcastMode: () => {
        dispatch({ type: "BROADCAST_MODE" });
        panels.setMode(InputMode.MessageInput);
      },
      onDirectMessageMode: () => {
        dispatch({ type: "DIRECT_MESSAGE_MODE" });
        panels.setMode(InputMode.MessageInput);
      },
      onApproveQuestion: () => void handleApproveQuestion(),
      onDenyQuestion: () => void handleDenyQuestion(),
      onSendKeys: (key: string) => {
        if (!tmux || !selectedSession) return;
        void (async () => {
          const { isPasteSafe } = await import("./utils/paste-safety.js");
          if (!isPasteSafe(key)) {
            showError("Blocked: input contains potentially dangerous escape sequences");
            return;
          }
          void safeCleanup(tmux.sendKeys(selectedSession, key), "sendKeys to tmux session", {
            silent: true,
          });
        })();
      },
      onPaletteUp: () => dispatch({ type: "PALETTE_UP" }),
      onPaletteDown: (maxIndex: number) => dispatch({ type: "PALETTE_DOWN", maxIndex }),
      onPaletteChar: (char: string) => dispatch({ type: "PALETTE_CHAR", char }),
      onPaletteBackspace: () => dispatch({ type: "PALETTE_BACKSPACE" }),
      onPaletteSelect: () => {
        const entry = visiblePaletteActions[ks.paletteIndex];
        if (!entry) return;
        const action = entry.action;
        if (!(action.enabled?.(actionContext) ?? true)) return;
        // Close the palette FIRST. Mode-switching actions (goal, compare, adopt)
        // re-set their target mode inside run, landing after this Normal set.
        panels.setMode(InputMode.Normal);
        dispatch({ type: "PALETTE_RESET" });
        void Promise.resolve(action.run(actionContext)).catch((err: unknown) => {
          showError(err instanceof Error ? err.message : "Action failed");
        });
      },
      onSelect: handleSelect,
      rowCount,
      pageSize: PAGE_SIZE,
      paletteItemCount: visiblePaletteActions.length,
      compareMode: ks.compareMode,
      frontierCids: () => frontierCidsRef.current,
      selectedSession,
      hasTmux: tmux !== undefined,
      resolvedKeymap,
      keymapPrefix,
      onKeymapPrefixChange: setKeymapPrefix,
      // Slice nav also resets the global cursor to 0 AND synchronously
      // clears the entries/cids refs. Without the cursor reset, switching
      // from a long slice (cursor=9) to a short slice (2 rows) leaves the
      // cursor off-row, hiding the selection AND blocking 'a'. Without the
      // synchronous ref clear, a fast `]` then `a` (or `]` then Enter)
      // delivered in the same JS tick would still see the previous slice's
      // entries because setState defers the visible value to the next
      // render. The refs are mutated in place so the very next routeKey
      // call sees an empty array; the effect re-fills both state and ref
      // on the next render with the new active slice's data.
      onFrontierTabNext: () => {
        dispatch({ type: "FRONTIER_SLICE_NEXT" });
        nav.resetCursor();
        frontierEntriesRef.current = [];
        frontierCidsRef.current = [];
      },
      onFrontierTabPrev: () => {
        dispatch({ type: "FRONTIER_SLICE_PREV" });
        nav.resetCursor();
        frontierEntriesRef.current = [];
        frontierCidsRef.current = [];
      },
      onFrontierAdopt: (cid: string, summary: string) => {
        dispatch({ type: "ADOPT_SET", targetCid: cid, summary });
        panels.setMode(InputMode.CommandPalette);
      },
      // Function form so the keyboard handler always reads the latest ref
      // (refs are mutated synchronously by handleFrontierEntriesChanged and
      // by slice-nav handlers; state-based values would lag by one render).
      frontierEntries: () => frontierEntriesRef.current,
    }),
    [
      panels,
      nav,
      handleQuit,
      handleCommandPaletteClose,
      handleSelect,
      handleApproveQuestion,
      handleDenyQuestion,
      sendTuiMessage,
      showError,
      tmux,
      selectedSession,
      rowCount,
      visiblePaletteActions,
      actionContext,
      ks.compareMode,
      ks.compareCids,
      ks.searchQuery,
      ks.messageBuffer,
      ks.messageRecipients,
      ks.goalBuffer,
      ks.paletteIndex,
      contributionList,
      resolvedKeymap,
      keymapPrefix,
      refreshAll,
      provider,
      spawnManager,
    ],
  );

  // Main keyboard handler — delegates to routeKey as single source of truth.
  useKeyboard((key) => {
    // Dismiss first-launch tooltips on any key press
    if (showTooltips) {
      dismissTooltips();
      return;
    }

    routeKey(key, keyboardActions);
  });

  return (
    <DagStateProvider store={dagStateStore}>
      <box flexDirection="column" width="100%" height="100%">
        <TooltipOverlay visible={showTooltips} onDismissAll={dismissTooltips} />
        <PanelBar panelState={panels.state} />
        <HelpOverlay
          visible={panels.state.mode === InputMode.Help}
          isDetailView={nav.isDetailView}
          focusedPanel={panels.state.focused}
          resolvedKeymap={resolvedKeymap}
        />
        {paletteVisible && (
          <box
            position="absolute"
            top={2}
            left={2}
            right={2}
            bottom={2}
            zIndex={10}
            backgroundColor={theme.headerBg}
          >
            <CommandPalette
              visible={paletteVisible}
              actions={paletteActions}
              ctx={actionContext}
              query={ks.paletteQuery}
              selectedIndex={ks.paletteIndex}
              adoptContext={ks.adoptContext}
            />
          </box>
        )}
        <InputBar
          visible={
            panels.state.mode === InputMode.TerminalInput ||
            panels.state.mode === InputMode.MessageInput ||
            panels.state.mode === InputMode.GoalInput
          }
          sessionName={selectedSession}
          messageLabel={
            panels.state.mode === InputMode.MessageInput
              ? `Message ${ks.messageRecipients}: ${ks.messageBuffer}`
              : panels.state.mode === InputMode.GoalInput
                ? `Goal: ${ks.goalBuffer}`
                : undefined
          }
        />
        <PanelManager
          provider={provider}
          intervalMs={intervalMs}
          panelState={panels.state}
          nav={nav}
          onContributionsLoaded={handleContributionsLoaded}
          onRowCountChanged={handleRowCountChanged}
          pageSize={PAGE_SIZE}
          tmux={tmux}
          selectedSession={selectedSession}
          topology={topology}
          onSelectSession={setSelectedSession}
          vfsNavigateTrigger={ks.vfsNavigateTrigger}
          artifactIndex={ks.artifactIndex}
          showArtifactDiff={ks.showArtifactDiff}
          activeClaims={activeClaims ?? undefined}
          searchQuery={
            panels.state.mode === InputMode.SearchInput ? ks.searchBuffer : ks.searchQuery
          }
          isSearchInputMode={panels.state.mode === InputMode.SearchInput}
          compareMode={ks.compareMode}
          compareCids={ks.compareCids}
          onCompareSelect={(cid: string) => dispatch({ type: "COMPARE_SELECT", cid })}
          onFrontierCidsChanged={handleFrontierCidsChanged}
          activeSliceKey={ks.activeFrontierSlice}
          onFrontierTabsChanged={(keys) => dispatch({ type: "FRONTIER_SET_TABS", keys })}
          onFrontierEntriesChanged={handleFrontierEntriesChanged}
          zoomLevel={ks.zoomLevel}
          activeSessions={paletteSessions?.filter((s) => s.startsWith("grove-"))}
          terminalScrollOffset={ks.terminalScrollOffset}
          terminalBuffers={terminalBuffers ?? undefined}
          layoutMode={ks.layoutMode}
          presetName={presetName}
          registryEntries={mergedPanelRegistry.entries}
          pluginContext={pluginContext}
        />
        <StatusBar
          mode={panels.state.mode}
          screenContext={screenContext}
          isDetailView={nav.isDetailView}
          error={lastError}
          focusedPanel={panels.state.focused}
          resolvedKeymap={resolvedKeymap}
          keymapPrefix={keymapPrefix}
          agentCount={paletteSessions?.filter((s) => s.startsWith("grove-")).length}
          viewMode={panels.state.viewMode}
          costLabel={
            sessionCosts
              ? `$${sessionCosts.totalCostUsd.toFixed(2)} | ${formatTokens(sessionCosts.totalTokens)}`
              : undefined
          }
          goalLabel={dashboardData?.metadata?.goal}
        />
      </box>
    </DagStateProvider>
  );
}
