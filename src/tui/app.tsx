/**
 * Root TUI application component.
 *
 * Multi-panel agent command center with graph-first layout.
 * Uses OpenTUI for rendering, usePanelFocus for panel state,
 * and useNavigation for within-panel navigation.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Claim, Contribution } from "../core/models.js";
import { checkSpawn, checkSpawnDepth } from "./agents/spawn-validator.js";
import { agentIdFromSession } from "./agents/tmux-manager.js";
import { buildPaletteItems, CommandPalette } from "./components/command-palette.js";
import { InputBar } from "./components/input-bar.js";
import { StatusBar } from "./components/status-bar.js";
import { PanelBar } from "./components/tab-bar.js";
import { useNavigation } from "./hooks/use-navigation.js";
import { InputMode, Panel, usePanelFocus } from "./hooks/use-panel-focus.js";
import { usePolledData } from "./hooks/use-polled-data.js";
import { PanelManager } from "./panels/panel-manager.js";
import type { TuiDataProvider } from "./provider.js";
import { SpawnManager } from "./spawn-manager.js";

/** Props for the root App component. */
export interface AppProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly tmux?: import("./agents/tmux-manager.js").TmuxManager | undefined;
  readonly topology?: import("../core/topology.js").AgentTopology | undefined;
}

const PAGE_SIZE = 20;

/** Root TUI application. */
export function App({ provider, intervalMs, tmux, topology }: AppProps): React.ReactNode {
  const renderer = useRenderer();
  const nav = useNavigation();
  const panels = usePanelFocus();

  const [contributionList, setContributionList] = useState<readonly Contribution[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [selectedSession, setSelectedSession] = useState<string | undefined>();

  // VFS navigation trigger — incremented when Enter pressed in VFS panel
  const [vfsNavigateTrigger, setVfsNavigateTrigger] = useState(0);

  // Artifact cycling state
  const [artifactIndex, setArtifactIndex] = useState(0);

  // Artifact diff toggle
  const [showArtifactDiff, setShowArtifactDiff] = useState(false);

  // Command palette selection cursor
  const [paletteIndex, setPaletteIndex] = useState(0);

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
    spawnManagerRef.current = new SpawnManager(provider, tmux, showError);
  }

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

  // Poll tmux sessions for the command palette kill list
  const paletteVisible = panels.state.mode === InputMode.CommandPalette;
  const sessionsFetcher = useCallback(async () => {
    if (!tmux) return [] as readonly string[];
    const available = await tmux.isAvailable();
    if (!available) return [] as readonly string[];
    return tmux.listSessions();
  }, [tmux]);
  const { data: paletteSessions } = usePolledData<readonly string[]>(
    sessionsFetcher,
    intervalMs * 2,
    paletteVisible && tmux !== undefined,
  );

  // Derive parentAgentId from the selected session for lineage-aware palette display
  const paletteParentId = selectedSession ? agentIdFromSession(selectedSession) : undefined;

  // Derive the palette items so the keyboard handler can look up the selected action
  const paletteItems = useMemo(
    () =>
      buildPaletteItems(
        topology,
        activeClaims ?? [],
        paletteSessions ?? [],
        tmux !== undefined,
        true,
        true,
        paletteParentId,
      ),
    [topology, activeClaims, paletteSessions, tmux, paletteParentId],
  );

  const handleContributionsLoaded = useCallback((contributions: readonly Contribution[]) => {
    setContributionList(contributions);
    setRowCount(contributions.length);
  }, []);

  const handleRowCountChanged = useCallback((count: number) => {
    setRowCount(count);
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

  const handleQuit = useCallback(() => {
    provider.close();
    renderer.destroy();
  }, [provider, renderer]);

  // Main keyboard handler — routes based on input mode
  useKeyboard((key) => {
    const input = key.name;
    const isCtrl = key.ctrl;

    // Command palette toggle (works in all modes)
    if (isCtrl && input === "p") {
      if (panels.state.mode === InputMode.CommandPalette) {
        panels.setMode(InputMode.Normal);
      } else {
        setPaletteIndex(0);
        panels.setMode(InputMode.CommandPalette);
      }
      return;
    }

    // Escape always exits current mode
    if (input === "escape") {
      if (panels.state.mode !== InputMode.Normal) {
        panels.setMode(InputMode.Normal);
        return;
      }
      if (nav.isDetailView) {
        nav.popDetail();
        return;
      }
      return;
    }

    // In terminal input mode, forward keystrokes to the selected tmux session
    if (panels.state.mode === InputMode.TerminalInput) {
      if (tmux && selectedSession && input) {
        tmux.sendKeys(selectedSession, input).catch(() => {});
      }
      return;
    }

    // In command palette mode, handle navigation and execution
    if (panels.state.mode === InputMode.CommandPalette) {
      const itemCount = paletteItems.length;
      if ((input === "j" || input === "down") && itemCount > 0) {
        setPaletteIndex((i) => Math.min(i + 1, itemCount - 1));
        return;
      }
      if ((input === "k" || input === "up") && itemCount > 0) {
        setPaletteIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (input === "return" && itemCount > 0) {
        const item = paletteItems[paletteIndex];
        if (item?.enabled) {
          if (item.kind === "spawn") {
            // Use role's command if defined, else $SHELL (or fallback to bash).
            const roleCommand = topology?.roles.find((r) => r.name === item.id)?.command;
            const shell = roleCommand ?? process.env.SHELL ?? "bash";
            handleSpawn(item.id, shell, "HEAD", paletteParentId);
          } else if (item.kind === "kill") {
            handleKill(item.id);
          }
          panels.setMode(InputMode.Normal);
          setPaletteIndex(0);
        }
        return;
      }
      return;
    }

    // Normal mode keybindings
    if (input === "q") {
      handleQuit();
      return;
    }

    // Panel focus: 1-4
    if (input === "1") {
      panels.focus(Panel.Dag);
      return;
    }
    if (input === "2") {
      panels.focus(Panel.Detail);
      return;
    }
    if (input === "3") {
      panels.focus(Panel.Frontier);
      return;
    }
    if (input === "4") {
      panels.focus(Panel.Claims);
      return;
    }

    // Panel toggle: 5-8
    if (input === "5") {
      panels.toggle(Panel.AgentList);
      return;
    }
    if (input === "6") {
      panels.toggle(Panel.Terminal);
      return;
    }
    if (input === "7") {
      panels.toggle(Panel.Artifact);
      return;
    }
    if (input === "8") {
      panels.toggle(Panel.Vfs);
      return;
    }

    // Tab/Shift+Tab: cycle focus
    if (input === "tab") {
      if (key.shift) {
        panels.cyclePrev();
      } else {
        panels.cycleNext();
      }
      return;
    }

    // Terminal input mode entry
    if (input === "i" && panels.state.focused === Panel.Terminal) {
      panels.setMode(InputMode.TerminalInput);
      return;
    }

    // Within-panel navigation
    if (input === "j" || input === "down") {
      nav.cursorDown(Math.max(0, rowCount - 1));
      return;
    }
    if (input === "k" || input === "up") {
      nav.cursorUp();
      return;
    }

    if (input === "return") {
      if (panels.state.focused === Panel.Vfs) {
        setVfsNavigateTrigger((n) => n + 1);
        return;
      }
      const isClaimsPanel = panels.state.focused === Panel.Claims;
      if (!nav.isDetailView && !isClaimsPanel && rowCount > 0) {
        handleSelect(nav.state.cursor);
      }
      return;
    }

    if (input === "n") {
      const hasFullPage = rowCount >= PAGE_SIZE;
      const totalItems = hasFullPage
        ? nav.state.pageOffset + rowCount + 1
        : nav.state.pageOffset + rowCount;
      nav.nextPage(PAGE_SIZE, totalItems);
      return;
    }
    if (input === "p") {
      nav.prevPage(PAGE_SIZE);
      return;
    }

    // Artifact panel: cycling (h/l, left/right) and diff toggle (d)
    if (panels.state.focused === Panel.Artifact) {
      if (input === "h" || input === "left") {
        setArtifactIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (input === "l" || input === "right") {
        setArtifactIndex((i) => i + 1);
        return;
      }
      if (input === "d") {
        setShowArtifactDiff((v) => !v);
        return;
      }
    }

    if (input === "r") {
      // Force re-render by cycling a key (handled by polling)
      return;
    }
  });

  const handleCommandPaletteClose = useCallback(() => {
    panels.setMode(InputMode.Normal);
  }, [panels]);

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

  return (
    <box flexDirection="column" width="100%" height="100%">
      <PanelBar panelState={panels.state} />
      <CommandPalette
        visible={paletteVisible}
        tmux={tmux}
        onClose={handleCommandPaletteClose}
        onSpawn={handleSpawn}
        onKill={handleKill}
        topology={topology}
        activeClaims={activeClaims ?? undefined}
        selectedIndex={paletteIndex}
        sessions={paletteSessions ?? undefined}
        parentAgentId={paletteParentId}
      />
      <InputBar
        visible={panels.state.mode === InputMode.TerminalInput}
        sessionName={selectedSession}
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
        vfsNavigateTrigger={vfsNavigateTrigger}
        artifactIndex={artifactIndex}
        showArtifactDiff={showArtifactDiff}
        activeClaims={activeClaims ?? undefined}
      />
      <StatusBar mode={panels.state.mode} isDetailView={nav.isDetailView} error={lastError} />
    </box>
  );
}
