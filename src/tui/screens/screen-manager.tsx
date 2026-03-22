/**
 * Screen manager — state machine for the simplified 5-screen TUI flow.
 *
 * Manages transitions between:
 *   Screen 1: PresetSelect
 *   Screen 2: AgentDetect
 *   Screen 3: GoalInput -> auto-spawn agents
 *   Screen 4: RunningView (contribution feed + agent status)
 *   Screen 5: CompleteView (session summary)
 *   Tab: toggle to App (advanced mode) / back to RunningView
 */

import { useRenderer } from "@opentui/react";
import { useKeyboard } from "@opentui/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AppProps } from "../app.js";
import { App } from "../app.js";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Screen identifiers for the state machine. */
export type Screen =
  | "preset-select"
  | "agent-detect"
  | "goal-input"
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
  }: ScreenManagerProps): React.ReactNode {
    const renderer = useRenderer();
    const { provider, topology, groveDir } = appProps;

    // Initialize state: resumed groves start on running, new groves on preset-select
    const [state, setState] = useState<ScreenState>(() => ({
      screen: startOnRunning
        ? ("running" as const)
        : presets && presets.length > 0
          ? ("preset-select" as const)
          : ("running" as const),
      ...(appProps.presetName ? { selectedPreset: appProps.presetName } : {}),
    }));

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
      );
    }

    // Track session start time for duration calculation
    const sessionStartRef = useRef<number>(Date.now());

    // ---------------------------------------------------------------------------
    // Done detection — watch for grove_done contributions from all roles
    // ---------------------------------------------------------------------------
    useEffect(() => {
      if (state.screen !== "running" && state.screen !== "advanced") return;
      if (!topology) return;

      const roleNames = new Set(topology.roles.map((r) => r.name));
      const timer = setInterval(async () => {
        try {
          const contributions = await provider.getContributions({ limit: 50 });
          if (!contributions) return;

          // Find done signals: contributions with [DONE] prefix or context.done
          const doneRoles = new Set<string>();
          for (const c of contributions) {
            const isDone =
              c.summary.startsWith("[DONE]") ||
              (c.context && (c.context as Record<string, unknown>).done === true);
            if (isDone) {
              const role = c.agent.role;
              if (role) doneRoles.add(role);
            }
          }

          // Check if all topology roles have signaled done
          const allDone = [...roleNames].every((r) => doneRoles.has(r));
          if (allDone && roleNames.size > 0) {
            setState((s) => ({ ...s, screen: "complete" }));
          }
        } catch {
          // Non-fatal
        }
      }, 5000);
      return () => clearInterval(timer);
    }, [state.screen, topology, provider]);

    // ---------------------------------------------------------------------------
    // Global permission prompt detection — works across ALL screens
    // ---------------------------------------------------------------------------
    const [pendingPermissions, setPendingPermissions] = useState<
      Array<{ sessionName: string; agentRole: string; command: string }>
    >([]);

    const tmux = appProps.tmux;
    useEffect(() => {
      if (!tmux) return;
      const timer = setInterval(async () => {
        try {
          const sessions = await tmux.listSessions();
          const prompts: Array<{ sessionName: string; agentRole: string; command: string }> = [];
          for (const sess of sessions) {
            if (!sess.startsWith("grove-")) continue;
            const pane = await tmux.capturePanes(sess);
            if (pane.includes("Do you want to proceed")) {
              const lines = pane.split("\n");
              let cmd = "";
              for (const line of lines) {
                const t = line.trim();
                if (t && !t.startsWith("Permission") && !t.startsWith("Do you") && !t.startsWith("❯") && !t.startsWith("Esc") && !t.startsWith("1.") && !t.startsWith("2.")) {
                  cmd = t;
                }
              }
              const role = sess.replace("grove-", "").replace(/-[a-z0-9]+$/i, "");
              prompts.push({ sessionName: sess, agentRole: role, command: cmd.slice(0, 80) });
            }
          }
          setPendingPermissions(prompts);
        } catch {
          // Non-fatal
        }
      }, 2000);
      return () => clearInterval(timer);
    }, [tmux]);

    // Global y/n keybinding for permission approval — works on any screen
    useKeyboard(
      useCallback(
        (key) => {
          if (pendingPermissions.length === 0) return;
          if (key.name === "y") {
            const prompt = pendingPermissions[0];
            if (prompt) {
              const proc = Bun.spawn(
                ["tmux", "-L", "grove", "send-keys", "-t", prompt.sessionName, "Enter"],
                { stdout: "pipe", stderr: "pipe" },
              );
              void proc.exited;
            }
          }
          if (key.name === "n") {
            const prompt = pendingPermissions[0];
            if (prompt) {
              const proc = Bun.spawn(
                ["tmux", "-L", "grove", "send-keys", "-t", prompt.sessionName, "Escape"],
                { stdout: "pipe", stderr: "pipe" },
              );
              void proc.exited;
            }
          }
        },
        [pendingPermissions],
      ),
    );

    const handleQuit = useCallback(() => {
      spawnManagerRef.current?.destroy();
      provider.close();
      renderer.destroy();
    }, [provider, renderer]);

    // Screen 1 -> Screen 2: preset selected
    const handlePresetSelect = useCallback((presetName: string) => {
      setState((s) => ({
        ...s,
        screen: "agent-detect",
        selectedPreset: presetName,
      }));
    }, []);

    // Screen 2 -> Screen 3: agents detected, continue with edited prompts
    const rolePromptsRef = useRef<Map<string, string>>(new Map());
    const handleAgentDetectContinue = useCallback(
      (detected: Map<string, boolean>, roleMapping: Map<string, string>, rolePrompts: Map<string, string>) => {
        rolePromptsRef.current = rolePrompts;
        setState((s) => ({
          ...s,
          screen: "goal-input",
          detectedAgents: detected,
          roleMapping,
        }));
      },
      [],
    );

    // Screen 2 -> Screen 1: back
    const handleAgentDetectBack = useCallback(() => {
      setState((s) => ({ ...s, screen: "preset-select" }));
    }, []);

    // Screen 3 -> Screen 4: goal submitted, auto-spawn agents
    const handleGoalSubmit = useCallback(
      (goal: string) => {
        sessionStartRef.current = Date.now();
        setState((s) => ({ ...s, screen: "running", goal }));

        // Set goal on provider if supported
        if (isGoalProvider(provider)) {
          void provider.setGoal(goal, []).catch(() => {
            // Goal setting is best-effort
          });
        }

        // Create session if supported
        if (isSessionProvider(provider)) {
          void provider
            .createSession({ goal })
            .then((session) => {
              setState((s) => ({ ...s, sessionId: session.sessionId }));
            })
            .catch(() => {
              // Session creation is best-effort
            });
        }

        // Auto-spawn all roles from topology with user-edited prompts
        if (topology) {
          spawnManagerRef.current?.setSessionGoal(goal);

          for (const role of topology.roles) {
            const command = role.command ?? "claude";
            const context: Record<string, unknown> = {};
            // Use user-edited prompt from Screen 2, fall back to GROVE.md
            const editedPrompt = rolePromptsRef.current.get(role.name);
            context.rolePrompt = editedPrompt ?? role.prompt ?? "";
            if (role.description) context.roleDescription = role.description;

            void spawnManagerRef.current?.spawn(role.name, command, undefined, 0, context).catch(() => {
              // Spawn failures are shown in RunningView via provider polling
            });
          }
        }
      },
      [provider, topology],
    );

    // Screen 3 -> Screen 2: back
    const handleGoalBack = useCallback(() => {
      setState((s) => ({ ...s, screen: "agent-detect" }));
    }, []);

    // Screen 4 -> advanced mode toggle
    const handleToggleAdvanced = useCallback(() => {
      setState((s) => ({ ...s, screen: "advanced" }));
    }, []);

    // Screen 4 -> Screen 5: session complete
    const handleComplete = useCallback((_reason: string) => {
      setState((s) => ({ ...s, screen: "complete" }));
    }, []);

    // Screen 5 -> Screen 1: new session
    const handleNewSession = useCallback(() => {
      setState({
        screen: presets && presets.length > 0 ? "preset-select" : "running",
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
          <text color={theme.dimmed}>y:approve  n:deny</text>
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
        return (
          <AgentDetect
            topology={topology}
            onContinue={handleAgentDetectContinue}
            onBack={handleAgentDetectBack}
          />
        );

      case "goal-input":
        return (
          <GoalInput
            presetName={state.selectedPreset ?? "default"}
            onSubmit={handleGoalSubmit}
            onBack={handleGoalBack}
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
            tmux={appProps.tmux}
            eventBus={appProps.eventBus}
            onToggleAdvanced={handleToggleAdvanced}
            onComplete={handleComplete}
            onQuit={handleQuit}
          />,
        );

      case "complete":
        return (
          <CompleteView
            reason="Session ended"
            contributionCount={0}
            duration={getDuration()}
            presetName={state.selectedPreset}
            onNewSession={handleNewSession}
            onQuit={handleQuit}
          />
        );

      case "advanced":
        return wrapWithPermissions(
          <box flexDirection="column" width="100%" height="100%">
            <box paddingX={2}>
              <text color={theme.dimmed}>Ctrl+B:back to simple view</text>
            </box>
            <box flexGrow={1}>
              <AdvancedModeWrapper
                appProps={appProps}
                onBack={() => setState((s) => ({ ...s, screen: "running" }))}
              />
            </box>
          </box>,
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
  function AdvancedModeWrapper({
    appProps,
    onBack,
  }: AdvancedModeWrapperProps): React.ReactNode {
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
