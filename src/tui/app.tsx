/**
 * Root TUI application component.
 *
 * Multi-panel agent command center with graph-first layout.
 * Uses OpenTUI for rendering, usePanelFocus for panel state,
 * useNavigation for within-panel navigation, and routeKey as
 * the single source of truth for keyboard handling.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { useKeyboard, useRenderer } from "@opentui/react";
import type React from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { TUI_REFRESH_ROLE } from "../core/event-bus.js";
import type { Claim, Contribution } from "../core/models.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import { checkSpawn, checkSpawnDepth } from "./agents/spawn-validator.js";
import { agentIdFromSession } from "./agents/tmux-manager.js";
import { INITIAL_KEYBOARD_STATE, tuiReducer } from "./app-reducer.js";
import { buildPaletteItems, CommandPalette, fuzzyMatch } from "./components/command-palette.js";
import { HelpOverlay } from "./components/help-overlay.js";
import { InputBar } from "./components/input-bar.js";
import { StatusBar } from "./components/status-bar.js";
import { PanelBar } from "./components/tab-bar.js";
import { TooltipOverlay, useFirstLaunchTooltips } from "./components/tooltip-overlay.js";
import type { GroveUserConfig } from "./config-loader.js";
import { DagStateStore } from "./data/dag-state-store.js";
import { DagStateProvider } from "./hooks/dag-state-context.js";

export type { TuiAction, TuiKeyboardState } from "./app-reducer.js";
export { tuiReducer } from "./app-reducer.js";

import { useProviderScoped } from "./hooks/informer-context.js";
import { useRelistTrigger } from "./hooks/refresh-context.js";
import { useEventDrivenData } from "./hooks/use-event-driven-data.js";
import { buildKeyActionMap, useKeybindingOverrides } from "./hooks/use-keybinding-overrides.js";
import type { KeyboardActions } from "./hooks/use-keyboard-handler.js";
import { nextZoom, routeKey } from "./hooks/use-keyboard-handler.js";
import { useNavigation } from "./hooks/use-navigation.js";
import { InputMode, usePanelFocus } from "./hooks/use-panel-focus.js";
import { useTuiStatePersistence } from "./hooks/use-session-persistence.js";
import type { ZoomLevel } from "./panels/panel-manager.js";
import { PanelManager } from "./panels/panel-manager.js";
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
import { theme } from "./theme.js";

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
  /** When set, ScreenManager should scope the resumed session feed to this id. */
  readonly resumeSessionId?: string | undefined;
  /** When set, ScreenManager should open goal-input with this preset pre-selected (new session in existing grove). */
  readonly newSessionPreset?: string | undefined;
  /** Pre-fetched dashboard data — populates the first render before polling hooks fire. */
  readonly initialDashboard?: import("./provider.js").DashboardData | undefined;
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
}: AppProps): React.ReactNode {
  const renderer = useRenderer();
  const nav = useNavigation();
  const panels = usePanelFocus();
  // DagStateStore — xray DAG UI state (#311). Constructed once at App
  // mount so collapse/highlight/focus survive every PanelManager
  // re-render. ScreenManager has its own equivalent; the two providers
  // are mounted on disjoint code paths (advanced mode vs welcome flow).
  const [dagStateStore] = useState<DagStateStore>(() => new DagStateStore());
  const { showTooltips, dismissAll: dismissTooltips } = useFirstLaunchTooltips();
  const { savedState, saveState } = useTuiStatePersistence("global", groveDir);
  const fileOverrides = useKeybindingOverrides();
  // Merge config.json keymap (lower priority) with file-based overrides (higher priority).
  const keybindingOverrides = useMemo(
    () => ({ ...userConfig?.keymap, ...fileOverrides }),
    [userConfig?.keymap, fileOverrides],
  );
  const keyActionMap = useMemo(() => buildKeyActionMap(keybindingOverrides), [keybindingOverrides]);
  const [ks, dispatch] = useReducer(tuiReducer, INITIAL_KEYBOARD_STATE);

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
  const [frontierCids, setFrontierCids] = useState<readonly string[]>([]);

  // Last error for status bar display (auto-clears after 5s)
  const [lastError, setLastError] = useState<string | undefined>();
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showError = useCallback((message: string) => {
    if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
    setLastError(message);
    errorTimerRef.current = setTimeout(() => setLastError(undefined), 5_000);
  }, []);

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
  const paletteItems = useMemo(
    () =>
      buildPaletteItems(
        topology,
        activeClaims ?? [],
        paletteSessions ?? [],
        tmux !== undefined,
        canSpawn,
        true,
        paletteParentId,
        canDelegate ? (gossipPeers ?? undefined) : undefined,
        agentProfiles ?? undefined,
        hasGoals,
      ),
    [
      topology,
      activeClaims,
      paletteSessions,
      tmux,
      canSpawn,
      canDelegate,
      paletteParentId,
      gossipPeers,
      agentProfiles,
      hasGoals,
    ],
  );

  // Filtered + ranked palette items — matches CommandPalette's rendering order
  // so Enter always executes the visually selected item.
  const filteredPaletteItems = useMemo(() => {
    const q = ks.paletteQuery.trim();
    if (!q) return paletteItems;
    const ranked = paletteItems
      .map((item) => ({ item, score: fuzzyMatch(q, item.label) }))
      .filter((r) => r.score.match)
      .sort((a, b) => b.score.score - a.score.score)
      .map((r) => r.item);
    return ranked;
  }, [paletteItems, ks.paletteQuery]);

  const handleContributionsLoaded = useCallback((contributions: readonly Contribution[]) => {
    if (!contributions) return;
    setContributionList(contributions);
    setRowCount(contributions.length);
  }, []);

  const handleRowCountChanged = useCallback((count: number) => {
    setRowCount(count);
  }, []);

  const handleFrontierCidsChanged = useCallback((cids: readonly string[]) => {
    setFrontierCids(cids);
  }, []);

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

      spawnManager.spawn(agentId, command, parentAgentId, depth, context).catch((err) => {
        const msg = err instanceof Error ? err.message : "Spawn failed";
        showError(msg);
      });
    },
    [topology, activeClaims, showError, spawnManager],
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

  const handleCommandPaletteClose = useCallback(() => {
    panels.setMode(InputMode.Normal);
  }, [panels]);

  // ---------------------------------------------------------------------------
  // KeyboardActions adapter — maps routeKey callbacks to state transitions.
  // Complex palette execution (spawn/kill/register/delegate) and paste safety
  // remain here because they need closure access to spawnManager, etc.
  // ---------------------------------------------------------------------------

  const keyboardActions: KeyboardActions = useMemo(
    () => ({
      panels,
      nav,
      onQuit: handleQuit,
      onSpawnPalette: () => dispatch({ type: "PALETTE_RESET" }),
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
        showError(`Adopted: ${(cid ?? "").slice(0, 16)}...`);
        dispatch({ type: "COMPARE_ADOPT" });
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
        const item = filteredPaletteItems[ks.paletteIndex];
        if (!item?.enabled) return;
        if (item.kind === "spawn") {
          const profileCommand = agentProfiles?.find((p) => p.role === item.id)?.command;
          const roleCommand = topology?.roles.find((r) => r.name === item.id)?.command;
          const shell = profileCommand ?? roleCommand ?? process.env.SHELL ?? "bash";
          handleSpawn(item.id, shell, "HEAD", paletteParentId);
        } else if (item.kind === "kill") {
          handleKill(item.id);
        } else if (item.kind === "register") {
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
        } else if (item.kind === "delegate") {
          void handleDelegate(item.id);
        } else if (item.kind === "goal") {
          panels.setMode(InputMode.GoalInput);
          dispatch({ type: "GOAL_INPUT_MODE" });
          dispatch({ type: "PALETTE_RESET" });
          return;
        }
        panels.setMode(InputMode.Normal);
        dispatch({ type: "PALETTE_RESET" });
      },
      onSelect: handleSelect,
      rowCount,
      pageSize: PAGE_SIZE,
      paletteItemCount: filteredPaletteItems.length,
      compareMode: ks.compareMode,
      frontierCids,
      selectedSession,
      hasTmux: tmux !== undefined,
      keybindingOverrides,
      keyActionMap,
    }),
    [
      panels,
      nav,
      handleQuit,
      handleSelect,
      handleApproveQuestion,
      handleDenyQuestion,
      handleSpawn,
      handleKill,
      handleDelegate,
      sendTuiMessage,
      showError,
      tmux,
      selectedSession,
      rowCount,
      filteredPaletteItems,
      ks.compareMode,
      ks.compareCids,
      ks.searchQuery,
      ks.messageBuffer,
      ks.messageRecipients,
      ks.goalBuffer,
      ks.paletteIndex,
      frontierCids,
      agentProfiles,
      topology,
      paletteParentId,
      keybindingOverrides,
      keyActionMap,
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
          keybindingOverrides={keybindingOverrides}
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
              tmux={tmux}
              onClose={handleCommandPaletteClose}
              onSpawn={handleSpawn}
              onKill={handleKill}
              topology={topology}
              activeClaims={activeClaims ?? undefined}
              selectedIndex={ks.paletteIndex}
              sessions={paletteSessions ?? undefined}
              parentAgentId={paletteParentId}
              items={paletteItems}
              query={ks.paletteQuery}
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
          zoomLevel={ks.zoomLevel}
          activeSessions={paletteSessions?.filter((s) => s.startsWith("grove-"))}
          terminalScrollOffset={ks.terminalScrollOffset}
          terminalBuffers={terminalBuffers ?? undefined}
          layoutMode={ks.layoutMode}
          presetName={presetName}
        />
        <StatusBar
          mode={panels.state.mode}
          isDetailView={nav.isDetailView}
          error={lastError}
          focusedPanel={panels.state.focused}
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
