/**
 * Root TUI application component.
 *
 * Multi-panel agent command center with graph-first layout.
 * Uses OpenTUI for rendering, usePanelFocus for panel state,
 * useNavigation for within-panel navigation, and routeKey as
 * the single source of truth for keyboard handling.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import type React from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Claim, Contribution } from "../core/models.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import { checkSpawn, checkSpawnDepth } from "./agents/spawn-validator.js";
import { agentIdFromSession } from "./agents/tmux-manager.js";
import { buildPaletteItems, CommandPalette } from "./components/command-palette.js";
import { HelpOverlay } from "./components/help-overlay.js";
import { InputBar } from "./components/input-bar.js";
import { StatusBar } from "./components/status-bar.js";
import { PanelBar } from "./components/tab-bar.js";
import { TooltipOverlay, useFirstLaunchTooltips } from "./components/tooltip-overlay.js";
import { useKeybindingOverrides } from "./hooks/use-keybinding-overrides.js";
import type { KeyboardActions } from "./hooks/use-keyboard-handler.js";
import { nextZoom, routeKey } from "./hooks/use-keyboard-handler.js";
import { useNavigation } from "./hooks/use-navigation.js";
import { InputMode, usePanelFocus } from "./hooks/use-panel-focus.js";
import { usePolledData } from "./hooks/use-polled-data.js";
import { useSessionPersistence } from "./hooks/use-session-persistence.js";
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
import { FileSessionStore } from "./session-store.js";
import { SpawnManager } from "./spawn-manager.js";

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
}

const PAGE_SIZE = 20;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${n} tok`;
}

// ---------------------------------------------------------------------------
// TUI keyboard state — consolidated into a reducer for testability
// and future session persistence support.
// ---------------------------------------------------------------------------

/** State managed by the keyboard-driven reducer. */
export interface TuiKeyboardState {
  readonly vfsNavigateTrigger: number;
  readonly artifactIndex: number;
  readonly showArtifactDiff: boolean;
  readonly paletteIndex: number;
  readonly searchQuery: string;
  readonly searchBuffer: string;
  readonly messageBuffer: string;
  readonly messageRecipients: string;
  readonly goalBuffer: string;
  readonly compareMode: boolean;
  readonly compareCids: readonly string[];
  readonly zoomLevel: ZoomLevel;
  readonly terminalScrollOffset: number;
  readonly layoutMode: "grid" | "tab";
}

/** Actions for the TUI keyboard state reducer. */
export type TuiAction =
  | { readonly type: "VFS_NAVIGATE" }
  | { readonly type: "ARTIFACT_PREV" }
  | { readonly type: "ARTIFACT_NEXT" }
  | { readonly type: "ARTIFACT_DIFF_TOGGLE" }
  | { readonly type: "PALETTE_UP" }
  | { readonly type: "PALETTE_DOWN"; readonly maxIndex: number }
  | { readonly type: "PALETTE_RESET" }
  | { readonly type: "SEARCH_START"; readonly currentQuery: string }
  | { readonly type: "SEARCH_CHAR"; readonly char: string }
  | { readonly type: "SEARCH_BACKSPACE" }
  | { readonly type: "SEARCH_SUBMIT" }
  | { readonly type: "MESSAGE_CHAR"; readonly char: string }
  | { readonly type: "MESSAGE_BACKSPACE" }
  | { readonly type: "MESSAGE_CLEAR" }
  | { readonly type: "BROADCAST_MODE" }
  | { readonly type: "DIRECT_MESSAGE_MODE" }
  | { readonly type: "GOAL_INPUT_MODE" }
  | { readonly type: "GOAL_CHAR"; readonly char: string }
  | { readonly type: "GOAL_BACKSPACE" }
  | { readonly type: "GOAL_SUBMIT" }
  | { readonly type: "COMPARE_TOGGLE" }
  | { readonly type: "COMPARE_SELECT"; readonly cid: string }
  | { readonly type: "COMPARE_ADOPT" }
  | { readonly type: "ZOOM_CYCLE" }
  | { readonly type: "ZOOM_RESET" }
  | { readonly type: "TERMINAL_SCROLL_UP" }
  | { readonly type: "TERMINAL_SCROLL_DOWN" }
  | { readonly type: "TERMINAL_SCROLL_BOTTOM" }
  | { readonly type: "LAYOUT_TOGGLE" };

const INITIAL_KEYBOARD_STATE: TuiKeyboardState = {
  vfsNavigateTrigger: 0,
  artifactIndex: 0,
  showArtifactDiff: false,
  paletteIndex: 0,
  searchQuery: "",
  searchBuffer: "",
  messageBuffer: "",
  messageRecipients: "",
  goalBuffer: "",
  compareMode: false,
  compareCids: [],
  zoomLevel: "normal",
  terminalScrollOffset: 0,
  layoutMode: "tab",
};

/** Pure reducer for TUI keyboard state — testable and serializable. */
export function tuiReducer(state: TuiKeyboardState, action: TuiAction): TuiKeyboardState {
  switch (action.type) {
    case "VFS_NAVIGATE":
      return { ...state, vfsNavigateTrigger: state.vfsNavigateTrigger + 1 };
    case "ARTIFACT_PREV":
      return { ...state, artifactIndex: Math.max(0, state.artifactIndex - 1) };
    case "ARTIFACT_NEXT":
      return { ...state, artifactIndex: state.artifactIndex + 1 };
    case "ARTIFACT_DIFF_TOGGLE":
      return { ...state, showArtifactDiff: !state.showArtifactDiff };
    case "PALETTE_UP":
      return { ...state, paletteIndex: Math.max(0, state.paletteIndex - 1) };
    case "PALETTE_DOWN":
      return { ...state, paletteIndex: Math.min(state.paletteIndex + 1, action.maxIndex) };
    case "PALETTE_RESET":
      return { ...state, paletteIndex: 0 };
    case "SEARCH_START":
      return { ...state, searchBuffer: action.currentQuery };
    case "SEARCH_CHAR":
      return { ...state, searchBuffer: state.searchBuffer + action.char };
    case "SEARCH_BACKSPACE":
      return { ...state, searchBuffer: state.searchBuffer.slice(0, -1) };
    case "SEARCH_SUBMIT":
      return { ...state, searchQuery: state.searchBuffer };
    case "MESSAGE_CHAR":
      return { ...state, messageBuffer: state.messageBuffer + action.char };
    case "MESSAGE_BACKSPACE":
      return { ...state, messageBuffer: state.messageBuffer.slice(0, -1) };
    case "MESSAGE_CLEAR":
      return { ...state, messageBuffer: "", messageRecipients: "" };
    case "BROADCAST_MODE":
      return { ...state, messageBuffer: "", messageRecipients: "@all" };
    case "DIRECT_MESSAGE_MODE":
      return { ...state, messageBuffer: "@", messageRecipients: "@direct" };
    case "GOAL_INPUT_MODE":
      return { ...state, goalBuffer: "" };
    case "GOAL_CHAR":
      return { ...state, goalBuffer: state.goalBuffer + action.char };
    case "GOAL_BACKSPACE":
      return { ...state, goalBuffer: state.goalBuffer.slice(0, -1) };
    case "GOAL_SUBMIT":
      return { ...state, goalBuffer: "" };
    case "COMPARE_TOGGLE":
      return {
        ...state,
        compareMode: !state.compareMode,
        compareCids: state.compareMode ? state.compareCids : [],
      };
    case "COMPARE_SELECT": {
      const prev = state.compareCids;
      if (prev.includes(action.cid)) {
        return { ...state, compareCids: prev.filter((c) => c !== action.cid) };
      }
      if (prev.length >= 2) {
        const second = prev[1] ?? prev[0] ?? action.cid;
        return { ...state, compareCids: [second, action.cid] };
      }
      return { ...state, compareCids: [...prev, action.cid] };
    }
    case "COMPARE_ADOPT":
      return { ...state, compareMode: false, compareCids: [] };
    case "ZOOM_CYCLE":
      return { ...state, zoomLevel: nextZoom(state.zoomLevel) };
    case "ZOOM_RESET":
      return state.zoomLevel === "normal" ? state : { ...state, zoomLevel: "normal" };
    case "TERMINAL_SCROLL_UP":
      return { ...state, terminalScrollOffset: state.terminalScrollOffset + 5 };
    case "TERMINAL_SCROLL_DOWN":
      return { ...state, terminalScrollOffset: Math.max(0, state.terminalScrollOffset - 5) };
    case "TERMINAL_SCROLL_BOTTOM":
      return state.terminalScrollOffset === 0 ? state : { ...state, terminalScrollOffset: 0 };
    case "LAYOUT_TOGGLE":
      return { ...state, layoutMode: state.layoutMode === "tab" ? "grid" : "tab" };
  }
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
}: AppProps): React.ReactNode {
  const renderer = useRenderer();
  const nav = useNavigation();
  const panels = usePanelFocus();
  const { showTooltips, dismissAll: dismissTooltips } = useFirstLaunchTooltips();
  const { persistedState, saveState } = useSessionPersistence();
  const keybindingOverrides = useKeybindingOverrides();
  const [ks, dispatch] = useReducer(tuiReducer, INITIAL_KEYBOARD_STATE);

  // Restore persisted state on first load (item 13)
  // restoredRef gates both restore AND save — save must not run before restore.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !persistedState) return;
    restoredRef.current = true;
    // Restore zoom level
    if (persistedState.zoomLevel && persistedState.zoomLevel !== "normal") {
      let current: ZoomLevel = "normal";
      while (current !== persistedState.zoomLevel) {
        dispatch({ type: "ZOOM_CYCLE" });
        current = nextZoom(current);
      }
    }
    // Restore search query
    if (persistedState.searchQuery) {
      for (const ch of persistedState.searchQuery) {
        dispatch({ type: "SEARCH_CHAR", char: ch });
      }
      dispatch({ type: "SEARCH_SUBMIT" });
    }
    // Restore visible operator panels FIRST (so focus can land on them)
    if (persistedState.visibleOperatorPanels) {
      for (const p of persistedState.visibleOperatorPanels) {
        panels.toggle(p as import("./hooks/use-panel-focus.js").Panel);
      }
    }
    // Restore focused panel AFTER panels are visible
    if (persistedState.focusedPanel !== undefined) {
      panels.focus(persistedState.focusedPanel as import("./hooks/use-panel-focus.js").Panel);
    }
  }, [persistedState, panels]);

  // Persist state on changes (item 13)
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

  // SpawnManager handles workspace/claim/heartbeat lifecycle
  const spawnManagerRef = useRef<SpawnManager | undefined>(undefined);
  if (spawnManagerRef.current === undefined) {
    // Use the resolved groveDir from props for session persistence
    let sessionStore: FileSessionStore | undefined;
    if (groveDir) {
      try {
        sessionStore = new FileSessionStore(groveDir);
      } catch {
        // Session persistence is best-effort
      }
    }
    spawnManagerRef.current = new SpawnManager(provider, tmux, showError, sessionStore);
  }

  // Reconcile persisted sessions on startup (reattach live, clean dead)
  useEffect(() => {
    spawnManagerRef.current?.reconcile().catch(() => {
      // Reconciliation is best-effort — don't block TUI startup
    });
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
      spawnManagerRef.current?.destroy();
    };
  }, []);

  // Poll active claims for topology-aware command palette
  const claimsFetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
  const { data: activeClaims } = usePolledData<readonly Claim[]>(
    claimsFetcher,
    intervalMs,
    topology !== undefined,
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
  const { data: paletteSessions } = usePolledData<readonly string[]>(
    sessionsFetcher,
    paletteVisible ? intervalMs * 2 : intervalMs * 4,
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
  const { data: sessionCosts } = usePolledData<
    { totalCostUsd: number; totalTokens: number } | undefined
  >(
    costFetcher,
    intervalMs * 3,
    hasCosts, // Only poll when provider actually supports costs
  );

  // Poll active PR and set context on SpawnManager so agents get env vars
  const hasGitHub = isGitHubProvider(provider);
  const prFetcher = useCallback(async (): Promise<GitHubPRSummary | undefined> => {
    if (!hasGitHub) return undefined;
    return (
      provider as TuiDataProvider & { getActivePR: () => Promise<GitHubPRSummary | undefined> }
    ).getActivePR();
  }, [provider, hasGitHub]);
  const { data: activePR } = usePolledData<GitHubPRSummary | undefined>(
    prFetcher,
    intervalMs * 4,
    hasGitHub,
  );

  // Poll dashboard for goal metadata (shown in status bar)
  const dashboardFetcher = useCallback(() => provider.getDashboard(), [provider]);
  const { data: dashboardData } = usePolledData<DashboardData>(
    dashboardFetcher,
    intervalMs * 3,
    true,
  );

  // Sync PR context to SpawnManager whenever it changes
  useEffect(() => {
    if (!spawnManagerRef.current) return;
    if (activePR) {
      spawnManagerRef.current.setPrContext({
        number: activePR.number,
        title: activePR.title,
        filesChanged: activePR.filesChanged,
      });
    } else {
      spawnManagerRef.current.setPrContext(undefined);
    }
  }, [activePR]);

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
  const { data: gossipPeers } = usePolledData(gossipFetcher, intervalMs * 4, paletteVisible);

  // Derive parentAgentId from the selected session for lineage-aware palette display
  const paletteParentId = selectedSession ? agentIdFromSession(selectedSession) : undefined;

  // Derive the palette items so the keyboard handler can look up the selected action.
  // Only advertise spawn if the provider supports workspace checkout (remote does not).
  const canSpawn = provider.checkoutWorkspace !== undefined;

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
  const { data: agentProfiles } = usePolledData(profilesFetcher, intervalMs * 10, true);

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
  const { data: terminalBuffers } = usePolledData<Map<string, string>>(
    terminalBuffersFetcher,
    intervalMs * 5, // cold tier — transcript search is infrequent
    activeGroveSessions.length > 0,
  );

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
        gossipPeers ?? undefined,
        agentProfiles ?? undefined,
        hasGoals,
      ),
    [
      topology,
      activeClaims,
      paletteSessions,
      tmux,
      canSpawn,
      paletteParentId,
      gossipPeers,
      agentProfiles,
      hasGoals,
    ],
  );

  const handleContributionsLoaded = useCallback((contributions: readonly Contribution[]) => {
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
        const rp = provider as unknown as { baseUrl?: string };
        const baseUrl = rp.baseUrl ?? "http://localhost:4515";
        const resp = await fetch(`${baseUrl}/api/boardroom/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
      const spawnCheck = checkSpawn(topology, agentId, activeClaims ?? [], parentAgentId);
      if (!spawnCheck.allowed) return;

      let depth = 0;
      if (parentAgentId !== undefined) {
        const parentClaim = (activeClaims ?? []).find((c) => c.agent.agentId === parentAgentId);
        const parentDepth =
          typeof parentClaim?.context?.depth === "number" ? parentClaim.context.depth : 0;
        depth = parentDepth + 1;
      }

      const depthCheck = checkSpawnDepth(topology, depth);
      if (!depthCheck.allowed) return;

      spawnManagerRef.current?.spawn(agentId, command, parentAgentId, depth).catch((err) => {
        const msg = err instanceof Error ? err.message : "Spawn failed";
        showError(msg);
      });
    },
    [topology, activeClaims, showError],
  );

  /** Kill tmux session → stop heartbeat → release claim → clean workspace. */
  const handleKill = useCallback(
    (sessionName: string) => {
      spawnManagerRef.current?.kill(sessionName).catch((err) => {
        const msg = err instanceof Error ? err.message : "Kill failed";
        showError(msg);
      });
    },
    [showError],
  );

  const handleCommandPaletteClose = useCallback(() => {
    panels.setMode(InputMode.Normal);
  }, [panels]);

  // ---------------------------------------------------------------------------
  // KeyboardActions adapter — maps routeKey callbacks to state transitions.
  // Complex palette execution (spawn/kill/register/delegate) and paste safety
  // remain here because they need closure access to spawnManagerRef, etc.
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
              await provider.setGoal(buf, []);
              showError(`Goal set: ${buf}`);
            } catch (err) {
              showError(err instanceof Error ? err.message : "Failed to set goal");
            }
          })();
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
      onPaletteSelect: () => {
        const item = paletteItems[ks.paletteIndex];
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
      paletteItemCount: paletteItems.length,
      compareMode: ks.compareMode,
      frontierCids,
      selectedSession,
      hasTmux: tmux !== undefined,
      keybindingOverrides,
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
      paletteItems,
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
      provider,
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
    <box flexDirection="column" width="100%" height="100%">
      <TooltipOverlay visible={showTooltips} onDismissAll={dismissTooltips} />
      <PanelBar panelState={panels.state} />
      <HelpOverlay
        visible={panels.state.mode === InputMode.Help}
        isDetailView={nav.isDetailView}
        focusedPanel={panels.state.focused}
      />
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
      />
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
        searchQuery={panels.state.mode === InputMode.SearchInput ? ks.searchBuffer : ks.searchQuery}
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
        goalLabel={dashboardData?.metadata.goal}
      />
    </box>
  );
}
