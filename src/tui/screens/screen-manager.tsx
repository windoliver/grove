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
import type { AppProps } from "../app.js";
import { App } from "../app.js";
import { useDoneDetection } from "../hooks/use-done-detection.js";
import { usePermissionDetection } from "../hooks/use-permission-detection.js";
import type { SessionRecord } from "../provider.js";
import { isGoalProvider, isSessionProvider } from "../provider.js";
import { FileSessionStore } from "../session-store.js";
import { SpawnManager } from "../spawn-manager.js";
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
    const { provider, topology, groveDir } = appProps;

    // Initialize state: use initialState override (testing), or compute from props
    const [state, setState] = useState<ScreenState>(
      () =>
        initialState ?? {
          screen: startOnRunning
            ? ("running" as const)
            : topology
              ? ("goal-input" as const) // Has topology → goal first, detect later
              : presets && presets.length > 0
                ? ("preset-select" as const)
                : ("running" as const),
          ...(appProps.presetName ? { selectedPreset: appProps.presetName } : {}),
        },
    );

    // SpawnManager for auto-spawning agents
    const spawnManagerRef = useRef<SpawnManager | undefined>(undefined);
    if (spawnManagerRef.current === undefined) {
      let sessionStore: FileSessionStore | undefined;
      if (groveDir) {
        try {
          sessionStore = new FileSessionStore(groveDir);
        } catch {
          // Best-effort
        }
      }
      spawnManagerRef.current = new SpawnManager(
        provider,
        appProps.tmux,
        () => {
          // errors shown in RunningView via provider polling
        },
        sessionStore,
        appProps.groveDir,
        appProps.agentRuntime,
      );

      // Wire NexusWsBridge for push-based IPC: TUI watches inboxes, pushes to agents
      const rt = appProps.agentRuntime;
      const nexusUrl = process.env.GROVE_NEXUS_URL;
      const apiKey = process.env.NEXUS_API_KEY;
      if (rt && topology && nexusUrl && apiKey) {
        void import("../nexus-ws-bridge.js")
          .then(({ NexusWsBridge }) => {
            const bridge = new NexusWsBridge({
              topology,
              runtime: rt,
              nexusUrl,
              apiKey,
              eventBus: appProps.eventBus,
            });
            bridge.connect();
            spawnManagerRef.current?.setWsBridge(bridge);
          })
          .catch(() => {
            /* best-effort */
          });
      }
    }

    // Reconcile agent sessions when entering running view (reattach to acpx).
    // Always bump reconcileVersion after reconcile to force RunningView re-render
    // with updated activeRoles from SpawnManager.
    const [reconcileVersion, setReconcileVersion] = useState(0);
    const lastReconciledScreenRef = useRef<string>("");
    useEffect(() => {
      if (
        state.screen === "running" &&
        lastReconciledScreenRef.current !== "running" &&
        spawnManagerRef.current
      ) {
        lastReconciledScreenRef.current = "running";
        void spawnManagerRef.current
          .reconcile()
          .then(() => {
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
      }
    }, [state.screen]);

    // Track session start time for duration calculation
    const sessionStartRef = useRef<number>(Date.now());
    // Track if grove_done was signaled — stops IPC routing to prevent ping-pong
    const doneSignaledRef = useRef(false);

    // ---------------------------------------------------------------------------
    // Done detection — extracted to custom hook (supports event-driven + polling)
    // ---------------------------------------------------------------------------
    const snapshotAndComplete = useCallback(
      async (reason: string) => {
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
      [provider],
    );
    const handleDone = useCallback(() => {
      void snapshotAndComplete("All roles signaled done");
    }, [snapshotAndComplete]);
    useDoneDetection(provider, topology, state.screen, appProps.eventBus, handleDone);

    // ---------------------------------------------------------------------------
    // Permission prompt detection — extracted to custom hook
    // ---------------------------------------------------------------------------
    const pendingPermissions = usePermissionDetection(appProps.tmux);

    const handleQuit = useCallback(() => {
      // Archive active session (persists to DB, agents stay alive in acpx)
      if (state.sessionId && isSessionProvider(provider)) {
        void provider.archiveSession(state.sessionId).catch(() => {
          /* best-effort */
        });
      }
      spawnManagerRef.current?.destroy();
      provider.close();
      renderer.destroy();
    }, [provider, renderer, state.sessionId]);

    // Screen 1 -> Screen 2: preset selected → go to goal input
    const handlePresetSelect = useCallback((presetName: string) => {
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
      setState((s) => ({ ...s, screen: "goal-input" }));
    }, []);

    /**
     * Spawn agents and transition to running view.
     * Called from handleLaunchConfirm with explicit roleMapping.
     */
    const spawnAgents = useCallback(
      (goal: string, roleMapping: Map<string, string>) => {
        sessionStartRef.current = Date.now();
        const sessionStartedAt = new Date().toISOString();

        // Set goal on provider if supported
        if (isGoalProvider(provider)) {
          void provider.setGoal(goal, []).catch(() => {
            // Goal setting is best-effort
          });
        }

        // Create session if supported
        if (isSessionProvider(provider)) {
          void provider
            .createSession({ goal, presetName: state.selectedPreset })
            .then((session) => {
              setState((s) => ({ ...s, sessionId: session.sessionId }));
            })
            .catch(() => {
              // Session creation is best-effort
            });
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

          spawnManagerRef.current?.setSessionGoal(goal);

          // Spawn each role and track progress
          for (const role of topology.roles) {
            // Use roleMapping from launch preview (user-selected CLI), fall back to GROVE.md command
            const command = roleMapping.get(role.name) ?? role.command ?? "codex";
            const context: Record<string, unknown> = {};
            const editedPrompt = rolePromptsRef.current.get(role.name);
            context.rolePrompt = editedPrompt ?? role.prompt ?? "";
            if (role.description) context.roleDescription = role.description;
            if (role.goal) context.roleGoal = role.goal;
            if (topology) context.topology = topology;

            // Mark as spawning
            setState((s) => ({
              ...s,
              spawnStates: (s.spawnStates ?? []).map((a) =>
                a.role === role.name ? { ...a, status: "spawning" as const } : a,
              ),
            }));

            void spawnManagerRef.current
              ?.spawn(role.name, command, undefined, 0, context)
              .then(() => {
                setState((s) => ({
                  ...s,
                  spawnStates: (s.spawnStates ?? []).map((a) =>
                    a.role === role.name ? { ...a, status: "started" as const } : a,
                  ),
                }));
              })
              .catch((err) => {
                setState((s) => ({
                  ...s,
                  spawnStates: (s.spawnStates ?? []).map((a) =>
                    a.role === role.name
                      ? { ...a, status: "failed" as const, error: String(err) }
                      : a,
                  ),
                }));
              });
          }
        } else {
          // No topology — go straight to running
          setState((s) => ({ ...s, screen: "running", goal, sessionStartedAt }));
        }
      },
      [provider, topology, state.selectedPreset],
    );

    // Screen 3 (launch preview) -> spawning: Ctrl+Enter confirmed launch
    const handleLaunchConfirm = useCallback(
      (
        detected: Map<string, boolean>,
        roleMappingFromPreview: Map<string, string>,
        rolePrompts: Map<string, string>,
      ) => {
        rolePromptsRef.current = rolePrompts;
        setState((s) => ({
          ...s,
          detectedAgents: detected,
          roleMapping: roleMappingFromPreview,
        }));
        spawnAgents(state.goal ?? "", roleMappingFromPreview);
      },
      [state.goal, spawnAgents],
    );

    // Screen 3.5 -> Screen 4: all spawns resolved
    const handleSpawnComplete = useCallback(() => {
      setState((s) => ({ ...s, screen: "running" }));
    }, []);

    // Screen 2 -> back: go to preset-select if presets exist, otherwise quit
    // (topology-first launches skip preset-select, so Esc should exit, not dead-end)
    const handleGoalBack = useCallback(() => {
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
            onNewContribution={(c) => {
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
              if (c.agent?.role && spawnManagerRef.current) {
                void spawnManagerRef.current.routeContribution(
                  c.agent.role,
                  c.summary,
                  c.kind,
                  topology,
                );
              }
              if (state.sessionId && isSessionProvider(provider)) {
                void provider.addContributionToSession(state.sessionId, c.cid).catch(() => {
                  /* best-effort */
                });
              }
            }}
            onSendToAgent={async (role, message) => {
              if (!spawnManagerRef.current) return false;
              return spawnManagerRef.current.sendToAgent(role, message);
            }}
            activeRoles={
              reconcileVersion >= 0 ? (spawnManagerRef.current?.getActiveRoles() ?? []) : []
            }
            onToggleAdvanced={handleToggleAdvanced}
            onComplete={handleComplete}
            onQuit={handleQuit}
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
