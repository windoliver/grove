/**
 * Screen manager — state machine for the simplified 5-screen TUI flow.
 *
 * Manages transitions between:
 *   Screen 1: PresetSelect
 *   Screen 2: GoalInput (goal first, detect later)
 *   Screen 3: LaunchPreview (auto-detect CLIs, Ctrl+Enter to launch)
 *   Screen 4: RunningView (contribution feed + agent status)
 *   Screen 5: CompleteView (session summary)
 *   Ctrl+A: toggle to App (advanced mode) / Ctrl+B back to RunningView
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { lookupPresetTopology } from "../../core/presets.js";
import { topologicalSortRoles } from "../../core/topology.js";
import type { AppProps } from "../app.js";
import { App } from "../app.js";
import { debugLog } from "../debug-log.js";
import { useDoneDetection } from "../hooks/use-done-detection.js";
import { usePermissionDetection } from "../hooks/use-permission-detection.js";
import type { SessionRecord } from "../provider.js";
import { isGoalProvider, isSessionProvider } from "../provider.js";
import { useSpawnManager } from "../spawn-manager-context.js";
import { theme } from "../theme.js";
import type { TuiPresetEntry } from "../tui-app.js";
import { AgentDetect } from "./agent-detect.js";
import { CompleteView } from "./complete-view.js";
import { GoalInput } from "./goal-input.js";
import { PresetSelect } from "./preset-select.js";
import { RunningView } from "./running-view.js";
import type { AgentSpawnState } from "./spawn-progress.js";
import { SpawnProgress } from "./spawn-progress.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Screen identifiers for the state machine. */
export type Screen =
  | "preset-select"
  | "agent-detect"
  | "goal-input"
  | "launch-preview"
  | "spawning"
  | "running"
  | "complete"
  | "advanced";

/** State tracked across screen transitions. */
export interface ScreenState {
  screen: Screen;
  selectedPreset?: string;
  detectedAgents?: Map<string, boolean>;
  roleMapping?: Map<string, string>;
  goal?: string;
  sessionId?: string;
  /** Warning message when session record failed to save. */
  sessionWarning?: string;
  /** ISO timestamp when the current session started — used to scope contribution feed. */
  sessionStartedAt?: string;
  /** Per-agent spawn progress for the spawning screen. */
  spawnStates?: AgentSpawnState[];
  /** Snapshot data captured on transition to complete screen. */
  completeSnapshot?: {
    readonly reason: string;
    readonly contributionCount: number;
    readonly metricResult?: import("./complete-view.js").MetricResult | undefined;
    readonly cost?: string | undefined;
  };
}

/** Props for the ScreenManager component. */
export interface ScreenManagerProps {
  /** AppProps for the advanced boardroom mode. */
  readonly appProps: AppProps;
  /** Presets for Screen 1. */
  readonly presets?: readonly TuiPresetEntry[] | undefined;
  /** Past sessions for Screen 1. */
  readonly sessions?: readonly SessionRecord[] | undefined;
  /** Start on RunningView (Screen 4) for resumed groves. */
  readonly startOnRunning?: boolean | undefined;
  /** Override initial state (testing only). */
  readonly initialState?: ScreenState | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Screen manager that orchestrates the simplified 5-screen TUI flow. */
export const ScreenManager: React.NamedExoticComponent<ScreenManagerProps> = React.memo(
  function ScreenManager({
    appProps,
    presets,
    sessions,
    startOnRunning,
    initialState,
  }: ScreenManagerProps): React.ReactNode {
    const renderer = useRenderer();
    const { provider, topology: initialTopology, contract } = appProps;

    // Resolved topology — starts from GROVE.md default, overridden when user picks a preset.
    const [topology, setTopology] = useState(initialTopology);

    // Capture the resume session ID for setSessionScope — written in the useState
    // initializer (runs synchronously before effects) and read in the mount effect below.
    const resumeScopeIdRef = useRef<string | undefined>(undefined);

    // Initialize state: use initialState override (testing), or compute from props
    const [state, setState] = useState<ScreenState>(() => {
      if (initialState) return initialState;
      // On resume, populate sessionStartedAt from the most recent active session
      let resumeSessionStartedAt: string | undefined;
      let resumeSessionId: string | undefined;
      if (startOnRunning && sessions && sessions.length > 0) {
        const active = sessions.find((s) => s.status === "active");
        if (active) {
          resumeSessionStartedAt = active.createdAt;
          resumeSessionId = active.id;
          resumeScopeIdRef.current = active.id; // captured for mount effect
        }
      }
      return {
        screen: startOnRunning
          ? ("running" as const)
          : topology
            ? ("goal-input" as const) // Has topology → goal first, detect later
            : presets && presets.length > 0
              ? ("preset-select" as const)
              : ("running" as const),
        ...(appProps.presetName ? { selectedPreset: appProps.presetName } : {}),
        ...(resumeSessionStartedAt ? { sessionStartedAt: resumeSessionStartedAt } : {}),
        ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
      };
    });

    // Apply session scope on mount for resumed sessions (startOnRunning path).
    // Must fire before the first contribution poll in the reconcile effect below —
    // both are mount-only effects and React runs them top-to-bottom within the
    // same commit, so ordering is guaranteed.
    // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — provider is stable, resumeScopeIdRef is set once in the useState initializer
    useEffect(() => {
      const id = resumeScopeIdRef.current;
      if (id && "setSessionScope" in provider) {
        (provider as { setSessionScope: (id: string) => void }).setSessionScope(id);
        process.stderr.write(`[screen-manager] resume setSessionScope(${id})\n`);
        // Persist the resumed session id to current-session.json so the HTTP
        // MCP server (serve-http.ts) re-reads and scopes subsequent
        // requests to this session. Without this, resume would leave the
        // HTTP server pinned to bootstrap mode or the prior session's id,
        // and any HTTP MCP clients would see stale scope. Matches the write
        // on new-session creation in handleLaunchConfirm.
        if (appProps.groveDir) {
          void (async () => {
            try {
              const { writeFileSync, renameSync } = await import("node:fs");
              const { join } = await import("node:path");
              // biome-ignore lint/style/noNonNullAssertion: groveDir is set at startup before any session writes
              const finalPath = join(appProps.groveDir!, "current-session.json");
              const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
              writeFileSync(tmpPath, JSON.stringify({ sessionId: id }, null, 2), "utf-8");
              renameSync(tmpPath, finalPath);
            } catch {
              /* best-effort */
            }
          })();
        }
      }
    }, []);

    // SpawnManager singleton — provided by tui-app.tsx via SpawnManagerContext.
    const spawnManager = useSpawnManager();

    // Reconcile agent sessions when entering running view (reattach to acpx).
    // Always bump reconcileVersion after reconcile to force RunningView re-render
    // with updated activeRoles from SpawnManager.
    const [reconcileVersion, setReconcileVersion] = useState(0);
    const lastReconciledScreenRef = useRef<string>("");
    // Tracks the sessionId for which contribution polling was already started.
    // Prevents duplicate startContributionPolling when spawnManager is recreated
    // (useMemo in tui-app.tsx recreates SpawnManager when appProps change).
    const contribPollingStartedRef = useRef<string>("");
    // Whether the HTTP server's SessionOrchestrator is routing IPC (detected async, stored for sync access).
    const serverRoutingActiveRef = useRef<boolean>(false);
    // Spawn guard: prevents duplicate spawn when user presses Escape → Enter twice on agent-detect screen.
    // Reset when user navigates back past goal-input (handleGoalBack) or starts a new session.
    const hasSpawnedRef = useRef<boolean>(false);
    useEffect(() => {
      if (
        state.screen === "running" &&
        lastReconciledScreenRef.current !== "running" &&
        spawnManager
      ) {
        lastReconciledScreenRef.current = "running";
        debugLog(
          "reconcile",
          `starting groveDir=${appProps.groveDir} sessionId=${state.sessionId} topologyRoles=${topology?.roles.map((r) => r.name).join(",")}`,
        );
        void spawnManager
          .reconcile()
          .then(async () => {
            debugLog("reconcile", `done, creating buffers for topology roles`);
            // Ensure log buffers exist for all topology roles (even if reconcile found no live agents)
            if (topology) {
              for (const role of topology.roles) {
                spawnManager.ensureLogBuffer(role.name);
              }
            }
            debugLog(
              "reconcile",
              `buffers=[${[...spawnManager.getLogBuffers().keys()].join(",")}]`,
            );
            // Load historical traces only when resuming an explicit session.
            // Do NOT fall back to "most recent JSONL dir" — that loads a different
            // session's traces into a new session's buffers.
            const sid = state.sessionId;
            if (sid) {
              spawnManager.setSessionId(sid);
              await spawnManager.loadTraces(sid).catch(() => {
                /* non-fatal */
              });
            }
            // Start polling agent log files for live output
            spawnManager.startLogPolling();
            spawnManager.startContributionPolling(
              provider,
              topology,
              state.sessionStartedAt,
              30000,
              false,
            );
            // Always bump — even if reattached=0, we need RunningView to pick up
            // the reconciled state (getActiveRoles may have changed).
            setReconcileVersion((v) => v + 1);
          })
          .catch(() => {
            setReconcileVersion((v) => v + 1); // Force re-render even on error
          });
      }
      // Reset when leaving running screen so we reconcile again on re-entry
      if (state.screen !== "running") {
        lastReconciledScreenRef.current = "";
        contribPollingStartedRef.current = "";
      }
    }, [
      state.screen,
      state.sessionId,
      state.sessionStartedAt,
      spawnManager,
      topology,
      appProps.groveDir,
      provider,
    ]);

    // Track session start time for duration calculation
    const sessionStartRef = useRef<number>(Date.now());
    // Track if grove_done was signaled — stops IPC routing to prevent ping-pong
    const doneSignaledRef = useRef(false);

    // ---------------------------------------------------------------------------
    // Done detection — extracted to custom hook (supports event-driven + polling)
    // ---------------------------------------------------------------------------
    const snapshotAndComplete = useCallback(
      async (reason: string) => {
        // Save trace history before completing
        await spawnManager.saveTraces().catch(() => {
          /* best-effort */
        });
        spawnManager.stopLogPolling();

        let contributionCount = 0;
        try {
          const contributions = await provider.getContributions({ limit: 1000 });
          contributionCount = contributions?.length ?? 0;
        } catch {
          // Best-effort
        }
        // Archive session on completion
        setState((s) => {
          if (s.sessionId && isSessionProvider(provider)) {
            void provider.archiveSession(s.sessionId).catch(() => {
              /* best-effort */
            });
          }
          return {
            ...s,
            screen: "complete",
            completeSnapshot: { reason, contributionCount },
          };
        });
      },
      [provider, spawnManager],
    );
    const handleDone = useCallback(() => {
      void snapshotAndComplete("All roles signaled done");
    }, [snapshotAndComplete]);
    useDoneDetection(provider, topology, state.screen, appProps.eventBus, handleDone);

    // ---------------------------------------------------------------------------
    // Permission prompt detection — extracted to custom hook
    // ---------------------------------------------------------------------------
    const pendingPermissions = usePermissionDetection(appProps.tmux);

    // Back to main: archive session and return to preset select
    const handleBackToMain = useCallback(() => {
      spawnManager.stopLogPolling();
      void (async () => {
        await spawnManager.saveTraces().catch(() => {
          /* best-effort */
        });
        if (state.sessionId && isSessionProvider(provider)) {
          await provider.archiveSession(state.sessionId).catch(() => {
            /* best-effort */
          });
        }
      })();
      setState({
        screen: "preset-select",
      });
    }, [provider, state.sessionId, spawnManager]);

    const handleQuit = useCallback(() => {
      spawnManager.stopLogPolling();
      // Save trace history before quitting, then teardown
      debugLog(
        "quit",
        `saving traces, sessionId=${state.sessionId} buffers=[${[...spawnManager.getLogBuffers().keys()].join(",")}]`,
      );
      void (async () => {
        await spawnManager.saveTraces().catch(() => {
          /* best-effort */
        });
        debugLog("quit", "traces saved");
        // Archive active session (persists to DB, agents stay alive in acpx)
        if (state.sessionId && isSessionProvider(provider)) {
          await provider.archiveSession(state.sessionId).catch(() => {
            /* best-effort */
          });
        }
        // SpawnManager cleanup is owned by tui-app.tsx via useEffect
        provider.close();
        renderer.destroy();
      })();
    }, [provider, renderer, state.sessionId, spawnManager]);

    // Screen 1 -> Screen 2: preset selected → resolve topology and go to goal input
    const handlePresetSelect = useCallback((presetName: string) => {
      // Resolve topology from preset, falling back to GROVE.md default
      const presetTopology = lookupPresetTopology(presetName);
      if (presetTopology) {
        setTopology(presetTopology);
      }
      setState((s) => ({
        ...s,
        screen: "goal-input",
        selectedPreset: presetName,
      }));
    }, []);

    // Screen 2 -> Screen 3: goal entered → go to launch preview (auto-detect)
    const rolePromptsRef = useRef<Map<string, string>>(new Map());
    const handleGoalToPreview = useCallback((goal: string) => {
      setState((s) => ({
        ...s,
        screen: "launch-preview" as const,
        goal,
      }));
    }, []);

    // Screen 3 -> Screen 2: back to goal input
    const handleLaunchBack = useCallback(() => {
      hasSpawnedRef.current = false; // Reset so re-entering launch preview can spawn
      setState((s) => ({ ...s, screen: "goal-input" }));
    }, []);

    /**
     * Spawn agents and transition to running view.
     * Called from handleLaunchConfirm with explicit roleMapping.
     */
    const spawnAgents = useCallback(
      async (goal: string, roleMapping: Map<string, string>) => {
        debugLog(
          "spawnAgents",
          `goal="${goal}" roles=[${[...roleMapping.entries()].map(([k, v]) => `${k}→${v}`).join(",")}]`,
        );
        sessionStartRef.current = Date.now();
        const sessionStartedAt = new Date().toISOString();

        // Set goal on provider if supported
        if (isGoalProvider(provider)) {
          void provider.setGoal(goal, []).catch(() => {
            // Goal setting is best-effort
          });
        }

        // Create session BEFORE spawning agents so MCP gets GROVE_SESSION_ID
        // for session-scoped contribution paths (avoids N+1 VFS reads on 47+ old contributions).
        if (isSessionProvider(provider)) {
          try {
            const session = await provider.createSession({
              goal,
              presetName: state.selectedPreset,
              topology,
              config: contract,
            });
            spawnManager.setSessionId(session.id);
            if ("setSessionScope" in provider) {
              (provider as { setSessionScope: (id: string) => void }).setSessionScope(session.id);
              process.stderr.write(`[spawnAgents] setSessionScope(${session.id}) called\n`);
            } else {
              process.stderr.write(`[spawnAgents] provider does NOT have setSessionScope\n`);
            }
            // Write the session ID to .grove/current-session.json so the HTTP
            // MCP server (spawned before the session exists) can pick it up.
            //
            // Written atomically via temp-file + rename so concurrent readers
            // in serve-http.ts never observe a truncated/partial JSON during
            // a session switch. Without this, a POST hitting /mcp at the
            // same moment as the write could tear down every live HTTP MCP
            // session via invalidateStaleSessions.
            if (appProps.groveDir) {
              try {
                const { writeFileSync, renameSync } = await import("node:fs");
                const { join } = await import("node:path");
                const finalPath = join(appProps.groveDir, "current-session.json");
                const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
                writeFileSync(tmpPath, JSON.stringify({ sessionId: session.id }, null, 2), "utf-8");
                renameSync(tmpPath, finalPath);
              } catch {
                /* best-effort */
              }
            }
            setState((s) => ({ ...s, sessionId: session.id }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[grove] session record failed to save: ${msg}\n`);
            // In Nexus mode, refuse to fabricate a synthetic UUID when the
            // session record (local create OR Nexus mirror) failed. Doing
            // so would set GROVE_SESSION_ID to an id the authoritative
            // Nexus store has never seen, and the stdio MCP server now
            // fails closed when it can't load that record, so every spawned
            // agent would immediately crash against an orphaned id. Keep
            // the synthetic-id path for local-only sessions where there is
            // no Nexus record to be missing.
            // NexusDataProvider exposes `mode = "nexus"`. Using a runtime
            // duck-type check keeps this file decoupled from the provider
            // import graph (which would create a TUI/Nexus coupling cycle).
            const isNexus = (provider as unknown as { mode?: string }).mode === "nexus";
            if (isNexus) {
              setState((s) => ({
                ...s,
                error: `Failed to create Nexus session: ${msg}. Retry or fall back to local mode.`,
                screen: "preset-select",
              }));
              return;
            }
            const fallbackId = crypto.randomUUID();
            spawnManager.setSessionId(fallbackId);
            setState((s) => ({ ...s, sessionId: fallbackId }));
          }
        } else {
          // No session provider — generate a local session ID for MCP scoping
          const fallbackId = crypto.randomUUID();
          spawnManager.setSessionId(fallbackId);
          setState((s) => ({ ...s, sessionId: fallbackId }));
        }

        // Transition to spawning screen with per-agent tracking
        if (topology && topology.roles.length > 0) {
          const initialStates: AgentSpawnState[] = topology.roles.map((role) => ({
            role: role.name,
            command: roleMapping.get(role.name) ?? role.command ?? "codex",
            status: "waiting" as const,
          }));
          setState((s) => ({
            ...s,
            screen: "spawning",
            goal,
            sessionStartedAt,
            spawnStates: initialStates,
          }));

          spawnManager.setSessionGoal(goal);
          // Give SpawnManager the topology so it can resolve edge-type-aware
          // base branches (delegates/feeds/escalates → branch off source).
          spawnManager.setTopology(topology);
          // Ensure log buffers exist for all topology roles BEFORE seekToEnd.
          // startLogPolling(seekToEnd=true) iterates logBuffers to record file
          // offsets; if buffers don't exist yet, the loop has nothing to iterate
          // and no positions are recorded — leaving pollLogFile() reading from 0.
          for (const role of topology.roles) {
            spawnManager.ensureLogBuffer(role.name);
          }
          // New session — record current end-of-file for ALL existing role log
          // files so only lines written AFTER this point are shown.
          spawnManager.startLogPolling(2000, true);
          // Start contribution polling — server routing detected via global flag set in reconcile path.
          spawnManager.startContributionPolling(
            provider,
            topology,
            sessionStartedAt,
            3000,
            serverRoutingActiveRef.current,
          );

          // Spawn roles in topological order so that source branches exist before
          // dependent roles try to base their worktrees on them (delegates/feeds/escalates).
          // Sequential spawning is required because provisionWorkspace happens inside spawn().
          void (async () => {
            const orderedRoles = topologicalSortRoles(topology);
            for (const role of orderedRoles) {
              const userOverrideCmd = roleMapping.get(role.name);
              const command = userOverrideCmd ?? role.command ?? "codex";
              const context: Record<string, unknown> = {};
              const editedPrompt = rolePromptsRef.current.get(role.name);
              context.rolePrompt = editedPrompt ?? role.prompt ?? "";
              if (role.description) context.roleDescription = role.description;
              if (role.goal) context.roleGoal = role.goal;
              // If the user explicitly changed the CLI in launch preview, don't pass
              // the topology's platform — it would override the user's choice in
              // resolveAgent(). Let resolveAgent fall back to command parsing instead.
              if (!userOverrideCmd && role.platform) context.platform = role.platform;
              if (role.model) context.model = role.model;
              if (topology) context.topology = topology;

              // Mark as spawning
              setState((s) => ({
                ...s,
                spawnStates: (s.spawnStates ?? []).map((a) =>
                  a.role === role.name ? { ...a, status: "spawning" as const } : a,
                ),
              }));

              try {
                const result = await spawnManager.spawn(role.name, command, undefined, 0, context);
                setState((s) => ({
                  ...s,
                  spawnStates: (s.spawnStates ?? []).map((a) =>
                    a.role === role.name
                      ? { ...a, status: "started" as const, workspaceMode: result.workspaceMode }
                      : a,
                  ),
                }));
              } catch (err) {
                setState((s) => ({
                  ...s,
                  spawnStates: (s.spawnStates ?? []).map((a) =>
                    a.role === role.name
                      ? { ...a, status: "failed" as const, error: String(err) }
                      : a,
                  ),
                }));
              }
            }
          })();
        } else {
          // No topology — go straight to running
          setState((s) => ({ ...s, screen: "running", goal, sessionStartedAt }));
        }
      },
      [provider, topology, contract, state.selectedPreset, spawnManager, appProps.groveDir],
    );

    // Screen 3 (launch preview) -> spawning: Ctrl+Enter confirmed launch
    const handleLaunchConfirm = useCallback(
      (
        detected: Map<string, boolean>,
        roleMappingFromPreview: Map<string, string>,
        rolePrompts: Map<string, string>,
        edgeTimeouts: Map<string, number>,
      ) => {
        // Guard: prevent duplicate spawn when user presses Escape → Enter twice.
        // hasSpawnedRef is set to true here and only reset in handleNewSession.
        if (hasSpawnedRef.current) {
          debugLog("handleLaunchConfirm", "DUPLICATE SPAWN PREVENTED — already spawned/spawning");
          return;
        }
        hasSpawnedRef.current = true;
        debugLog("handleLaunchConfirm", `spawning with ${roleMappingFromPreview.size} roles, ${edgeTimeouts.size} edge timeouts`);

        // Apply edge timeouts from TUI into the topology. Always walk every
        // edge so that clearing a previously-set deadline (removing it from
        // edgeTimeouts) also removes it from the topology — otherwise the
        // preset/GROVE.md default would leak through as a "removed" deadline
        // that still fires. The HTTP server uses this topology to override
        // config.topology when creating the session record.
        if (topology) {
          for (const role of topology.roles) {
            if (role.edges) {
              for (const edge of role.edges) {
                const key = `${role.name}:${edge.target}`;
                const timeout = edgeTimeouts.get(key);
                if (timeout !== undefined) {
                  (edge as { replyTimeoutSeconds?: number }).replyTimeoutSeconds = timeout;
                } else {
                  delete (edge as { replyTimeoutSeconds?: number }).replyTimeoutSeconds;
                }
              }
            }
          }
        }

        rolePromptsRef.current = rolePrompts;
        setState((s) => ({
          ...s,
          detectedAgents: detected,
          roleMapping: roleMappingFromPreview,
        }));
        spawnAgents(state.goal ?? "", roleMappingFromPreview);
      },
      [state.goal, spawnAgents, topology, contract],
    );

    // Screen 3.5 -> Screen 4: all spawns resolved
    const handleSpawnComplete = useCallback(() => {
      setState((s) => ({ ...s, screen: "running" }));
    }, []);

    // Screen 2 -> back: go to preset-select if presets exist, otherwise quit
    // (topology-first launches skip preset-select, so Esc should exit, not dead-end)
    const handleGoalBack = useCallback(() => {
      hasSpawnedRef.current = false; // Reset so fresh launch is allowed after going back
      if (presets && presets.length > 0) {
        setState((s) => ({ ...s, screen: "preset-select" }));
      } else {
        handleQuit();
      }
    }, [presets, handleQuit]);

    // Screen 4 -> advanced mode (Ctrl+A, deliberate entry)
    const handleToggleAdvanced = useCallback(() => {
      setState((s) => ({ ...s, screen: "advanced" }));
    }, []);

    // Screen 4 -> Screen 5: session complete
    const handleComplete = useCallback(
      (reason: string) => {
        void snapshotAndComplete(reason);
      },
      [snapshotAndComplete],
    );

    // Screen 5 -> Screen 3 (reuse preset) or Screen 1 (no preset state)
    const handleNewSession = useCallback(() => {
      doneSignaledRef.current = false;
      hasSpawnedRef.current = false; // Reset spawn guard for new session
      setState((s) => {
        // If we have preset + role mapping from a prior run, skip to goal input
        if (s.selectedPreset && s.roleMapping) {
          // Destructure to omit session-specific fields, preserve preset/detection state
          const {
            goal: _g,
            sessionId: _s,
            sessionStartedAt: _st,
            spawnStates: _sp,
            completeSnapshot: _c,
            ...preserved
          } = s;
          return { ...preserved, screen: "goal-input" as const };
        }
        // No prior preset state — fall back to preset selection
        return {
          screen: presets && presets.length > 0 ? ("preset-select" as const) : ("running" as const),
        };
      });
    }, [presets]);

    // Compute duration string
    const getDuration = useCallback(() => {
      const ms = Date.now() - sessionStartRef.current;
      const minutes = Math.floor(ms / 60_000);
      const seconds = Math.floor((ms % 60_000) / 1_000);
      if (minutes > 0) return `${minutes}m ${seconds}s`;
      return `${seconds}s`;
    }, []);

    // ---------------------------------------------------------------------------
    // Permission bar (rendered above the current screen when prompts exist)
    // ---------------------------------------------------------------------------
    const permissionBar =
      pendingPermissions.length > 0 ? (
        <box
          flexDirection="column"
          marginX={2}
          borderStyle="round"
          borderColor={theme.warning}
          paddingX={1}
        >
          <text color={theme.warning} bold>
            Permission Request ({pendingPermissions.length})
          </text>
          {pendingPermissions.map((p) => (
            <box key={p.sessionName} flexDirection="row">
              <text color={theme.focus}>{p.agentRole}</text>
              <text color={theme.secondary}> wants to run: </text>
              <text color={theme.text}>{p.command}</text>
            </box>
          ))}
          <text color={theme.secondary}>y:approve n:deny</text>
        </box>
      ) : null;

    // ---------------------------------------------------------------------------
    // Render current screen (with permission bar overlay)
    // ---------------------------------------------------------------------------

    // Wrap screen content with global permission bar
    const wrapWithPermissions = (content: React.ReactNode): React.ReactNode => (
      <box flexDirection="column" width="100%" height="100%">
        {permissionBar}
        <box flexGrow={1}>{content}</box>
      </box>
    );

    switch (state.screen) {
      case "preset-select":
        return (
          <PresetSelect
            presets={presets ?? []}
            sessions={sessions}
            onSelect={handlePresetSelect}
            onQuit={handleQuit}
          />
        );

      case "agent-detect":
      case "launch-preview":
        return (
          <AgentDetect
            topology={topology}
            goal={state.goal}
            onContinue={handleLaunchConfirm}
            onBack={handleLaunchBack}
          />
        );

      case "goal-input":
        return (
          <GoalInput
            presetName={state.selectedPreset ?? "default"}
            topology={topology}
            roleMapping={state.roleMapping}
            onSubmit={handleGoalToPreview}
            onBack={handleGoalBack}
          />
        );

      case "spawning":
        return (
          <SpawnProgress
            agents={state.spawnStates ?? []}
            goal={state.goal ?? ""}
            presetName={state.selectedPreset}
            onAllResolved={handleSpawnComplete}
          />
        );

      case "running":
        return wrapWithPermissions(
          <RunningView
            provider={provider}
            intervalMs={appProps.intervalMs}
            topology={topology}
            goal={state.goal}
            sessionId={state.sessionId}
            sessionStartedAt={state.sessionStartedAt}
            tmux={appProps.tmux}
            eventBus={appProps.eventBus}
            groveDir={appProps.groveDir}
            logBuffers={reconcileVersion >= 0 ? spawnManager.getLogBuffers() : undefined}
            onNewContribution={(c) => {
              debugLog(
                "contribution",
                `NEW cid=${c.cid.slice(0, 12)} kind=${c.kind} role=${c.agent?.role} summary="${c.summary.slice(0, 50)}"`,
              );
              // Once grove_done fires, stop ALL routing (prevents infinite ping-pong)
              if (doneSignaledRef.current) return;
              const isDone =
                c.summary.startsWith("[DONE]") ||
                (c.context &&
                  typeof c.context === "object" &&
                  (c.context as Record<string, unknown>).done === true);
              if (isDone) {
                doneSignaledRef.current = true;
                return;
              }
              // NOTE: routing is handled by spawnManager.startContributionPolling (seenCids dedup).
              // Do NOT call routeContribution here — that causes duplicate IPC delivery.
              if (state.sessionId && isSessionProvider(provider)) {
                void provider.addContributionToSession(state.sessionId, c.cid).catch(() => {
                  /* best-effort */
                });
              }
            }}
            onSendToAgent={async (role, message) => {
              if (!spawnManager) return false;
              return spawnManager.sendToAgent(role, message);
            }}
            activeRoles={reconcileVersion >= 0 ? (spawnManager.getActiveRoles() ?? []) : []}
            onToggleAdvanced={handleToggleAdvanced}
            onComplete={handleComplete}
            onQuit={handleQuit}
            onBackToMain={handleBackToMain}
          />,
        );

      case "advanced":
        return wrapWithPermissions(
          <box flexDirection="column" width="100%" height="100%">
            <box paddingX={2}>
              <text color={theme.secondary}>Ctrl+B:back to running view</text>
            </box>
            <box flexGrow={1}>
              <AdvancedModeWrapper
                appProps={appProps}
                onBack={() => setState((s) => ({ ...s, screen: "running" }))}
              />
            </box>
          </box>,
        );

      case "complete":
        return (
          <CompleteView
            reason={state.completeSnapshot?.reason ?? "Session ended"}
            contributionCount={state.completeSnapshot?.contributionCount ?? 0}
            duration={getDuration()}
            presetName={state.selectedPreset}
            metricResult={state.completeSnapshot?.metricResult}
            cost={state.completeSnapshot?.cost}
            onNewSession={handleNewSession}
            onQuit={handleQuit}
          />
        );

      default:
        return (
          <box paddingX={2} paddingTop={1}>
            <text color={theme.error}>Unknown screen state</text>
          </box>
        );
    }
  },
);

// ---------------------------------------------------------------------------
// Advanced mode wrapper — intercepts Tab to go back to simple view
// ---------------------------------------------------------------------------

interface AdvancedModeWrapperProps {
  readonly appProps: AppProps;
  readonly onBack: () => void;
}

/**
 * Wraps the full App (boardroom) and intercepts Tab key to switch back
 * to the simple RunningView.
 */
const AdvancedModeWrapper: React.NamedExoticComponent<AdvancedModeWrapperProps> = React.memo(
  function AdvancedModeWrapper({ appProps, onBack }: AdvancedModeWrapperProps): React.ReactNode {
    // Intercept Ctrl+B (back) to return to simple view.
    // Tab is used by App for panel cycling, so we use a dedicated back key.
    useKeyboard(
      useCallback(
        (key) => {
          if (key.ctrl && key.name === "b") {
            onBack();
          }
        },
        [onBack],
      ),
    );
    return React.createElement(App, appProps);
  },
);
