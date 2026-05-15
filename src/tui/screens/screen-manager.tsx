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

import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lookupPresetTopology } from "../../core/presets.js";
import {
  applySessionSkillOverrides,
  type SessionSkillOverrideClause,
} from "../../core/session-skill-overrides.js";
import type { AgentTopology } from "../../core/topology.js";
import { topologicalSortRoles } from "../../core/topology.js";
import type { AppProps } from "../app.js";
import { App } from "../app.js";
import { PagesRouter, type PagesRouterComponentMap } from "../components/pages-router.js";
import { DagStateStore } from "../data/dag-state-store.js";
import { type PageKind, PagesStore } from "../data/pages-store.js";
import { debugLog } from "../debug-log.js";
import { DagStateProvider } from "../hooks/dag-state-context.js";
import { isDoneContribution, useDoneDetection } from "../hooks/use-done-detection.js";
import { usePermissionDetection } from "../hooks/use-permission-detection.js";
import { PagesStoreProvider } from "../hooks/use-screen-stack.js";
import type {
  SessionRecord,
  TuiDataProvider,
  TuiGoalProvider,
  TuiSessionProvider,
} from "../provider.js";
import { isGoalProvider, isSessionProvider } from "../provider.js";
import { useConfirmAndMutate } from "../safety/index.js";
import { mintTokenForCompensation } from "../safety/internal/compensation.js";
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
  /** Scope the resumed session's feed/history to this session id. */
  readonly resumeSessionId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Compensation helpers (C6 #304, T11)
//
// These wrap the dangerous archive/setGoal client methods for screen
// teardown and spawn-time goal seeding. They're internal cleanup paths
// with no operator confirmation, so they use `mintTokenForCompensation`
// (deep import from `safety/internal/compensation.js`) — the conspicuous
// import path is the social signal that this bypasses the normal
// `useConfirmAndMutate` UI.
//
// Both helpers fetch a fresh RV inline so the CAS check at the server
// gate passes; a 409 here means the entity changed between the read and
// the write (e.g., another operator archived the same session). Best-
// effort behaviour is acceptable for teardown — losing a race just
// means the work was already done.
// ---------------------------------------------------------------------------

async function archiveSessionForCompensation(
  provider: TuiDataProvider & TuiSessionProvider,
  sessionId: string,
): Promise<void> {
  const fresh = await provider.getSession(sessionId).catch(() => undefined);
  const rv = String(fresh?.resourceVersion ?? 0);
  const token = mintTokenForCompensation("AgentSession", sessionId, rv);
  await provider.archiveSession(token);
}

async function setGoalForCompensation(
  provider: TuiDataProvider & TuiGoalProvider,
  goal: string,
  acceptance: readonly string[],
): Promise<void> {
  const existing = await provider.getGoal().catch(() => undefined);
  // No row → INSERT path bypasses CAS, so "" is fine. Existing row → use
  // its RV so the UPDATE succeeds. The compensation helper does NOT retry;
  // if the goal changed under us we surface the error to the caller.
  const rv = existing?.resourceVersion !== undefined ? String(existing.resourceVersion) : "";
  const token = mintTokenForCompensation("Goal", "goal", rv);
  await provider.setGoal(token, goal, acceptance);
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
    resumeSessionId: resumeSessionIdFromProps,
  }: ScreenManagerProps): React.ReactNode {
    const renderer = useRenderer();
    const { width: termWidth } = useTerminalDimensions();
    const { provider, topology: initialTopology, contract } = appProps;

    // Resolved topology — starts from GROVE.md default, or from a preset
    // supplied by TuiApp's existing-grove "new session" shortcut.
    const [topology, setTopology] = useState<AgentTopology | undefined>(() => {
      if (initialTopology) return initialTopology;
      const presetName = initialState?.selectedPreset ?? appProps.presetName;
      return presetName ? lookupPresetTopology(presetName) : undefined;
    });

    const resolveBaselineTopology = useCallback(
      (presetName?: string): AgentTopology | undefined => {
        if (presetName) {
          return lookupPresetTopology(presetName) ?? initialTopology;
        }
        return initialTopology;
      },
      [initialTopology],
    );

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
        const active = resumeSessionIdFromProps
          ? sessions.find((s) => s.id === resumeSessionIdFromProps)
          : sessions.find((s) => s.status === "active");
        if (active) {
          resumeSessionStartedAt = active.createdAt;
          resumeSessionId = active.id;
          resumeScopeIdRef.current = active.id; // captured for mount effect
        } else if (resumeSessionIdFromProps) {
          // Explicit resume choice wasn't in the startup session list (e.g.
          // created after main.ts snapshotted it). Honor the user's choice
          // anyway and hydrate sessionStartedAt asynchronously from the
          // provider so the elapsed timer and handoff cutoff recover.
          resumeSessionId = resumeSessionIdFromProps;
          resumeScopeIdRef.current = resumeSessionIdFromProps;
          process.stderr.write(
            `[screen-manager] resume: session ${resumeSessionIdFromProps} not in startup list; scoping anyway\n`,
          );
        }
      }
      // startOnRunning only makes sense when there is actually a session to
      // resume. A fresh grove with no active session and startOnRunning=true
      // would drop straight into the running view with no agents spawned and
      // no goal — silently stuck. Fall back to the normal new-session flow
      // (goal-input if topology is known, otherwise preset-select) whenever
      // there is nothing running to reattach to.
      const hasResumableSession = resumeSessionId !== undefined;
      const effectiveResume = startOnRunning && hasResumableSession;
      return {
        screen: effectiveResume
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

    // PagesStore — k9s-style navigation stack. Created once at mount and
    // seeded with the initial screen so the router has a top page to render.
    // Kept in sync with state.screen below: every setState that flips screen
    // also calls the equivalent pages.{push|pop|replace|resetTo}.
    const [pages] = useState<PagesStore>(() => {
      const store = new PagesStore();
      store.push({ kind: state.screen as PageKind });
      return store;
    });

    // DagStateStore — xray DAG view UI state (#311). Constructed once at
    // mount so expansion / focus / highlight survive DagView unmount when
    // the user navigates between panels.
    const [dagStateStore] = useState<DagStateStore>(() => new DagStateStore());

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
        // Hydrate sessionStartedAt when we scoped to a resume id that wasn't
        // in the startup session list — without it, RunningView's elapsed
        // timer starts at 0 and handoff fetches fall back to now-2h.
        if (!state.sessionStartedAt && "getSession" in provider) {
          void (async () => {
            try {
              const rec = await (
                provider as {
                  getSession: (id: string) => Promise<{ createdAt?: string } | undefined>;
                }
              ).getSession(id);
              const createdAt = rec?.createdAt;
              if (createdAt) {
                setState((prev) => ({ ...prev, sessionStartedAt: createdAt }));
              }
            } catch {
              /* best-effort hydration */
            }
          })();
        }
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
    }, [state.screen, state.sessionId, spawnManager, topology, appProps.groveDir]);

    // Track session start time for duration calculation
    const sessionStartRef = useRef<number>(Date.now());
    // Track if grove_done was signaled — stops IPC routing to prevent ping-pong
    const doneSignaledRef = useRef(false);
    const completionStartedRef = useRef(false);

    // ---------------------------------------------------------------------------
    // Done detection — extracted to custom hook (supports event-driven + polling)
    // ---------------------------------------------------------------------------
    const snapshotAndComplete = useCallback(
      async (reason: string) => {
        if (completionStartedRef.current) return;
        completionStartedRef.current = true;
        doneSignaledRef.current = true;

        // stopActiveSession synchronously unregisters IPC routes and clears
        // active session maps before awaiting process teardown. Do not await
        // the teardown here: a stuck adapter close must not keep the session
        // row active after grove_done has already completed the session.
        void spawnManager.stopActiveSession().catch(() => {
          /* best-effort */
        });
        await spawnManager.saveTraces().catch(() => {
          /* best-effort */
        });

        let contributionCount = 0;
        try {
          const contributions = await provider.getContributions({ limit: 1000 });
          contributionCount = contributions?.length ?? 0;
        } catch {
          // Best-effort
        }
        // Archive session on completion (compensation — internal teardown,
        // no operator confirmation; CAS still enforced server-side).
        setState((s) => {
          if (s.sessionId && isSessionProvider(provider)) {
            void archiveSessionForCompensation(provider, s.sessionId).catch(() => {
              /* best-effort */
            });
          }
          return {
            ...s,
            screen: "complete",
            completeSnapshot: { reason, contributionCount },
          };
        });
        // Collapse wizard onto the complete page so esc on complete doesn't
        // walk back into running/spawning history.
        pages.replace({ kind: "complete" });
      },
      [provider, spawnManager, pages],
    );
    const handleDone = useCallback(() => {
      void snapshotAndComplete("Session signaled done");
    }, [snapshotAndComplete]);
    const observeDoneContribution = useDoneDetection(
      topology,
      state.screen,
      appProps.eventBus,
      handleDone,
    );

    // ---------------------------------------------------------------------------
    // Permission prompt detection — extracted to custom hook
    // ---------------------------------------------------------------------------
    const pendingPermissions = usePermissionDetection(appProps.tmux);

    // Back to main: navigation + teardown (post-archive). The modal
    // confirmation + archive itself runs in `RunningPageWithBackConfirm`
    // (a child of `<ConfirmAndMutateProvider>`). This callback only fires
    // AFTER the operator has confirmed (or the modal short-circuited because
    // there is no session to archive). It is intentionally idempotent:
    // saveTraces is best-effort and the navigation reset is safe to repeat.
    const handleNavigateBackToMain = useCallback(() => {
      spawnManager.stopLogPolling();
      void spawnManager.saveTraces().catch(() => {
        /* best-effort */
      });
      setState({
        screen: "preset-select",
      });
      pages.resetTo({ kind: "preset-select" });
    }, [spawnManager, pages]);

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
        // Archive active session (persists to DB, agents stay alive in acpx).
        // Compensation path — quit-time teardown, no operator confirmation.
        if (state.sessionId && isSessionProvider(provider)) {
          await archiveSessionForCompensation(provider, state.sessionId).catch(() => {
            /* best-effort */
          });
        }
        // SpawnManager cleanup is owned by tui-app.tsx via useEffect
        provider.close();
        renderer.destroy();
      })();
    }, [provider, renderer, state.sessionId, spawnManager]);

    // Screen 1 -> Screen 2: preset selected → resolve topology and go to goal input
    const handlePresetSelect = useCallback(
      (presetName: string) => {
        // Resolve topology from preset, falling back to GROVE.md default
        const presetTopology = resolveBaselineTopology(presetName);
        if (presetTopology) {
          setTopology(presetTopology);
        }
        setState((s) => ({
          ...s,
          screen: "goal-input",
          selectedPreset: presetName,
        }));
        pages.push({ kind: "goal-input" });
      },
      [pages, resolveBaselineTopology],
    );

    // Screen 2 -> Screen 3: goal entered → go to launch preview (auto-detect)
    const rolePromptsRef = useRef<Map<string, string>>(new Map());
    /**
     * Per-launch topology override set by handleLaunchConfirm after applying
     * TUI edge timeout edits. spawnAgents reads this (via ref) to bypass the
     * stale closure on `topology` state, and to ensure the cloned topology
     * is what reaches createSession — without it, session-specific edits
     * would either not apply (stale closure) or mutate the shared preset.
     */
    const sessionTopologyRef = useRef<AgentTopology | undefined>(undefined);
    const handleGoalToPreview = useCallback(
      (goal: string) => {
        setState((s) => ({
          ...s,
          screen: "launch-preview" as const,
          goal,
        }));
        pages.push({ kind: "launch-preview" });
      },
      [pages],
    );

    // Screen 3 -> Screen 2: back to goal input
    const handleLaunchBack = useCallback(() => {
      hasSpawnedRef.current = false; // Reset so re-entering launch preview can spawn
      setState((s) => ({ ...s, screen: "goal-input" }));
      pages.pop();
    }, [pages]);

    /**
     * Spawn agents and transition to running view.
     * Called from handleLaunchConfirm with explicit roleMapping.
     */
    const spawnAgents = useCallback(
      async (goal: string, roleMapping: Map<string, string>) => {
        const resolvedTopology = sessionTopologyRef.current ?? topology;
        debugLog(
          "spawnAgents",
          `goal="${goal}" roles=[${[...roleMapping.entries()].map(([k, v]) => `${k}→${v}`).join(",")}]`,
        );
        sessionStartRef.current = Date.now();
        const sessionStartedAt = new Date().toISOString();

        // Set goal on provider if supported. Compensation path: this is
        // an internal controller-driven write at spawn time (no operator
        // dialog), so we read the current RV inline and mint a token
        // directly. CAS still enforced server-side.
        if (isGoalProvider(provider)) {
          void setGoalForCompensation(provider, goal, []).catch(() => {
            // Goal setting is best-effort
          });
        }

        // Create session BEFORE spawning agents so MCP gets GROVE_SESSION_ID
        // for session-scoped contribution paths (avoids N+1 VFS reads on 47+ old contributions).
        //
        // Use sessionTopologyRef (set by handleLaunchConfirm after applying
        // TUI edge edits) when available. React state updates are async so
        // the closed-over `topology` variable would still reference the
        // pre-edit object here — using the ref ensures we send the cloned,
        // edited topology to createSession.
        if (isSessionProvider(provider)) {
          try {
            const sessionTopology = resolvedTopology;
            const sessionConfig =
              contract && sessionTopology ? { ...contract, topology: sessionTopology } : contract;
            const session = await provider.createSession({
              goal,
              presetName: state.selectedPreset,
              topology: sessionTopology,
              config: sessionConfig,
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
              pages.resetTo({ kind: "preset-select" });
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
        if (resolvedTopology && resolvedTopology.roles.length > 0) {
          const initialStates: AgentSpawnState[] = resolvedTopology.roles.map((role) => ({
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
          pages.push({ kind: "spawning" });

          spawnManager.setSessionGoal(goal);
          // Give SpawnManager the topology so it can resolve edge-type-aware
          // base branches (delegates/feeds/escalates → branch off source).
          spawnManager.setTopology(resolvedTopology);
          // Ensure log buffers exist for all topology roles BEFORE seekToEnd.
          // startLogPolling(seekToEnd=true) iterates logBuffers to record file
          // offsets; if buffers don't exist yet, the loop has nothing to iterate
          // and no positions are recorded — leaving pollLogFile() reading from 0.
          for (const role of resolvedTopology.roles) {
            spawnManager.ensureLogBuffer(role.name);
          }
          // New session — record current end-of-file for ALL existing role log
          // files so only lines written AFTER this point are shown.
          spawnManager.startLogPolling(2000, true);
          // Contributions are delivered to agents via the SSE push bridge owned
          // by tui-app.tsx. No TUI-side polling — that was a duplicate path.

          // Spawn roles in topological order so that source branches exist before
          // dependent roles try to base their worktrees on them (delegates/feeds/escalates).
          // Sequential spawning is required because provisionWorkspace happens inside spawn().
          void (async () => {
            const orderedRoles = topologicalSortRoles(resolvedTopology);
            for (const role of orderedRoles) {
              const userOverrideCmd = roleMapping.get(role.name);
              const command = userOverrideCmd ?? role.command ?? "codex";
              const context: Record<string, unknown> = {};
              const editedPrompt = rolePromptsRef.current.get(role.name);
              context.rolePrompt = editedPrompt ?? role.prompt ?? "";
              if (role.description) context.roleDescription = role.description;
              if (role.goal) context.roleGoal = role.goal;
              if (role.skills && role.skills.length > 0) context.skills = role.skills;
              // If the user explicitly changed the CLI in launch preview, don't pass
              // the topology's platform — it would override the user's choice in
              // resolveAgent(). Let resolveAgent fall back to command parsing instead.
              if (!userOverrideCmd && role.platform) context.platform = role.platform;
              if (role.model) context.model = role.model;
              context.topology = resolvedTopology;

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
          // Collapse the wizard so esc from running doesn't re-enter launch-preview.
          // Use resetTo (not replace) for parity with the topology branch in
          // handleSpawnComplete — both paths must collapse the entire wizard
          // stack into a single running entry.
          pages.resetTo({ kind: "running" });
        }
      },
      [provider, topology, contract, state.selectedPreset, spawnManager, appProps.groveDir, pages],
    );

    // Screen 3 (launch preview) -> spawning: Ctrl+Enter confirmed launch
    const handleLaunchConfirm = useCallback(
      (
        detected: Map<string, boolean>,
        roleMappingFromPreview: Map<string, string>,
        rolePrompts: Map<string, string>,
        edgeTimeouts: Map<string, number>,
        roleSkills: Map<string, readonly string[]>,
      ) => {
        // Guard: prevent duplicate spawn when user presses Escape → Enter twice.
        // hasSpawnedRef is set to true here and only reset in handleNewSession.
        if (hasSpawnedRef.current) {
          debugLog("handleLaunchConfirm", "DUPLICATE SPAWN PREVENTED — already spawned/spawning");
          return;
        }
        hasSpawnedRef.current = true;
        debugLog(
          "handleLaunchConfirm",
          `spawning with ${roleMappingFromPreview.size} roles, ${edgeTimeouts.size} edge timeouts`,
        );

        // Apply edge timeouts from TUI to a DEEP CLONE of the topology so
        // session-specific edits don't mutate the shared preset object (which
        // is memoized by lookupPresetTopology and reused across launches) or
        // the GROVE.md topology. Without cloning, editing deadlines in one
        // session silently leaks into later sessions in the same TUI process.
        //
        // We store the cloned topology in a ref (sessionTopologyRef) so
        // spawnAgents picks it up bypassing React's async state update. Also
        // call setTopology so the UI reflects the current session's config.
        if (topology) {
          let sessionTopology = structuredClone(topology);
          for (const role of sessionTopology.roles) {
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
          const skillClauses: SessionSkillOverrideClause[] = [...roleSkills.entries()].map(
            ([target, skills]) => ({
              target,
              op: "replace",
              skills: [...skills],
            }),
          );
          sessionTopology = applySessionSkillOverrides(sessionTopology, skillClauses);
          sessionTopologyRef.current = sessionTopology;
          setTopology(sessionTopology);
        }

        rolePromptsRef.current = rolePrompts;
        setState((s) => ({
          ...s,
          detectedAgents: detected,
          roleMapping: roleMappingFromPreview,
        }));
        spawnAgents(state.goal ?? "", roleMappingFromPreview);
      },
      [state.goal, spawnAgents, topology],
    );

    // Screen 3.5 -> Screen 4: all spawns resolved
    const handleSpawnComplete = useCallback(() => {
      setState((s) => ({ ...s, screen: "running" }));
      // Collapse spawning + launch-preview + goal-input + preset-select into
      // a single running entry so esc on running doesn't walk back into
      // wizard pages.
      pages.resetTo({ kind: "running" });
    }, [pages]);

    // Screen 2 -> back: go to preset-select if presets exist, otherwise quit
    // (topology-first launches skip preset-select, so Esc should exit, not dead-end)
    const handleGoalBack = useCallback(() => {
      hasSpawnedRef.current = false; // Reset so fresh launch is allowed after going back
      if (presets && presets.length > 0) {
        setState((s) => ({ ...s, screen: "preset-select" }));
        // Pop goal-input off the stack so the router lands back on
        // preset-select. resetTo guards against the case where goal-input
        // was the only entry (topology-first init).
        if (pages.depth() > 1) {
          pages.pop();
        } else {
          pages.resetTo({ kind: "preset-select" });
        }
      } else {
        handleQuit();
      }
    }, [presets, handleQuit, pages]);

    // Screen 4 -> advanced mode (Ctrl+A, deliberate entry)
    const handleToggleAdvanced = useCallback(() => {
      setState((s) => ({ ...s, screen: "advanced" }));
      pages.push({ kind: "advanced" });
    }, [pages]);

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
      completionStartedRef.current = false;
      hasSpawnedRef.current = false; // Reset spawn guard for new session
      sessionTopologyRef.current = undefined;

      let nextKind: PageKind = "preset-select";
      if (state.selectedPreset && state.roleMapping) {
        setTopology(resolveBaselineTopology(state.selectedPreset));
        const {
          goal: _g,
          sessionId: _s,
          sessionStartedAt: _st,
          spawnStates: _sp,
          completeSnapshot: _c,
          ...preserved
        } = state;
        setState({ ...preserved, screen: "goal-input" as const });
        nextKind = "goal-input";
      } else {
        const fallback =
          presets && presets.length > 0 ? ("preset-select" as const) : ("running" as const);
        setState({ screen: fallback });
        nextKind = fallback;
      }
      pages.resetTo({ kind: nextKind });
    }, [presets, pages, resolveBaselineTopology, state]);

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
    const wrapWithPermissions = useCallback(
      (content: React.ReactNode): React.ReactNode => (
        <box flexDirection="column" width="100%" height="100%">
          {permissionBar}
          <box flexGrow={1}>{content}</box>
        </box>
      ),
      [permissionBar],
    );

    // Advanced -> Running back handler. setState keeps state.screen in sync;
    // pages.pop() walks back off the advanced page that was pushed on entry.
    const handleAdvancedBack = useCallback(() => {
      setState((s) => ({ ...s, screen: "running" }));
      pages.pop();
    }, [pages]);

    // ---------------------------------------------------------------------------
    // Page → component bindings for PagesRouter.
    // ---------------------------------------------------------------------------
    //
    // PagesRouter calls each entry as `<Component page={top} />`. We close
    // over the real props (handlers, topology, state) and ignore the page
    // arg — keeping the existing wiring identical to the prior switch
    // statement so behavior, lifecycle, and tests don't shift.
    const components = useMemo<PagesRouterComponentMap>(() => {
      const PresetSelectPage = (): React.ReactNode => (
        <PresetSelect
          presets={presets ?? []}
          sessions={sessions}
          onSelect={handlePresetSelect}
          onQuit={handleQuit}
        />
      );
      const GoalInputPage = (): React.ReactNode => (
        <GoalInput
          presetName={state.selectedPreset ?? "default"}
          topology={topology}
          roleMapping={state.roleMapping}
          onSubmit={handleGoalToPreview}
          onBack={handleGoalBack}
        />
      );
      const LaunchPreviewPage = (): React.ReactNode => (
        <AgentDetect
          topology={topology}
          goal={state.goal}
          onContinue={handleLaunchConfirm}
          onBack={handleLaunchBack}
        />
      );
      const SpawningPage = (): React.ReactNode => (
        <SpawnProgress
          agents={state.spawnStates ?? []}
          goal={state.goal ?? ""}
          presetName={state.selectedPreset}
          onAllResolved={handleSpawnComplete}
        />
      );
      const RunningPage = (): React.ReactNode =>
        wrapWithPermissions(
          <RunningPageWithBackConfirm
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
              const isDone = isDoneContribution({ summary: c.summary, context: c.context });
              if (isDone) {
                observeDoneContribution(c);
                return;
              }
              // Once grove_done fires, stop ALL routing (prevents infinite ping-pong)
              if (doneSignaledRef.current) return;
              // Routing is handled by the SSE push bridge — don't re-deliver here.
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
            onNavigateBackToMain={handleNavigateBackToMain}
          />,
        );
      const AdvancedPage = (): React.ReactNode =>
        wrapWithPermissions(
          <box flexDirection="column" width="100%" height="100%">
            <box paddingX={2}>
              <text color={theme.secondary}>Ctrl+B:back to running view</text>
            </box>
            <box flexGrow={1}>
              <AdvancedModeWrapper appProps={appProps} onBack={handleAdvancedBack} />
            </box>
          </box>,
        );
      const CompletePage = (): React.ReactNode => (
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
      // panel and entity-detail share the same RunningPage component reference
      // (not wrapper functions) so React's reconciler sees the same type across
      // running/panel/entity-detail stack pushes and preserves the mounted
      // RunningView subtree. Distinct wrapper functions (PanelPage, EntityDetailPage)
      // would cause React to unmount+remount on every :a/:s/:d/:t/:r push, losing
      // feed cursor, autoFollow, traceSelectedAgent, and other local state.
      return {
        "preset-select": PresetSelectPage,
        "goal-input": GoalInputPage,
        "agent-detect": LaunchPreviewPage,
        "launch-preview": LaunchPreviewPage,
        spawning: SpawningPage,
        running: RunningPage,
        advanced: AdvancedPage,
        complete: CompletePage,
        panel: RunningPage,
        "entity-detail": RunningPage,
      };
    }, [
      presets,
      sessions,
      handlePresetSelect,
      handleQuit,
      state.selectedPreset,
      state.roleMapping,
      state.goal,
      state.sessionId,
      state.sessionStartedAt,
      state.spawnStates,
      state.completeSnapshot,
      topology,
      handleGoalToPreview,
      handleGoalBack,
      handleLaunchConfirm,
      handleLaunchBack,
      handleSpawnComplete,
      handleToggleAdvanced,
      handleComplete,
      handleNavigateBackToMain,
      handleAdvancedBack,
      handleNewSession,
      provider,
      appProps,
      spawnManager,
      reconcileVersion,
      observeDoneContribution,
      getDuration,
      wrapWithPermissions,
    ]);

    return (
      <PagesStoreProvider store={pages}>
        <DagStateProvider store={dagStateStore}>
          <PagesRouter
            store={pages}
            components={components}
            width={termWidth}
            presetName={state.selectedPreset}
            sessionId={state.sessionId}
          />
        </DagStateProvider>
      </PagesStoreProvider>
    );
  },
);

// ---------------------------------------------------------------------------
// RunningPageWithBackConfirm — wraps RunningView and routes the operator's
// "back to main" intent through the C6 confirm-and-mutate modal (#304).
//
// `useConfirmAndMutate()` requires the caller to be a descendant of the
// `<ConfirmAndMutateProvider>` mounted inside `<PagesRouter>`. ScreenManager
// itself sits ABOVE the provider, so the modal trigger lives here in a
// component rendered by PagesRouter's component map.
//
// Responsibilities:
//   1. Build a synthetic AgentSession entity snapshot from the SessionRecord
//      so the modal has a `kind`/`id`/`resourceVersion` to render and to
//      mint a DangerousToken from. The entity store doesn't carry a
//      grove-session record, so a synthetic snapshot is the simplest path
//      — the CAS check is enforced server-side regardless.
//   2. Open the modal via `confirmAndMutate({ entity, mutation })`.
//      Operator presses 'y' → `provider.archiveSession(token)` runs with
//      the snapshot's RV. 409 → modal updates snapshot RV from the response
//      and re-prompts (up to 3 retries). Operator presses 'n' → returns
//      cancelled → caller stays on the running screen.
//   3. After the modal resolves with `ok` or `max-retries`, navigate back
//      via the parent's `onNavigateBackToMain`.
//
// When there is no session id (e.g., topology-less local launch) or no
// session provider, we skip the modal and navigate immediately — there is
// nothing to confirm an archive of.
// ---------------------------------------------------------------------------

interface RunningPageWithBackConfirmProps
  extends Omit<
    import("./running-view.js").RunningViewProps,
    "onBackToMain" | "sessionId" | "provider"
  > {
  readonly provider: TuiDataProvider;
  readonly sessionId?: string | undefined;
  /**
   * Navigate back to the preset-select / main screen, AFTER the operator
   * has confirmed the archive (or there was nothing to archive).
   */
  readonly onNavigateBackToMain: () => void;
}

const RunningPageWithBackConfirm: React.NamedExoticComponent<RunningPageWithBackConfirmProps> =
  React.memo(function RunningPageWithBackConfirm(
    props: RunningPageWithBackConfirmProps,
  ): React.ReactNode {
    const { provider, sessionId, onNavigateBackToMain, ...rest } = props;
    const confirmAndMutate = useConfirmAndMutate();

    const handleBackToMain = useCallback(() => {
      void (async () => {
        // No session to archive → just navigate. Covers topology-less
        // launches and providers that don't expose session management.
        if (!sessionId || !isSessionProvider(provider)) {
          onNavigateBackToMain();
          return;
        }

        // Pull the freshest RV inline. The modal opens with this snapshot;
        // a stale RV will still produce a 409 the modal handles, but
        // starting from the latest cached value minimizes false retries.
        const fresh = await provider.getSession(sessionId).catch(() => undefined);
        const rv = String(fresh?.resourceVersion ?? 0);

        // Build a minimal AgentSessionEntity snapshot. The modal renders
        // `kind`/`id`/`resourceVersion`; the rest of the entity is unused
        // by the modal UI but the EntityForKind<"AgentSession"> shape
        // requires the spec/status/conditions fields to be present.
        const entity: import("../../core/entity.js").AgentSessionEntity = {
          kind: "AgentSession",
          namespace: "default",
          id: sessionId,
          spec: { role: "session" },
          status: { phase: "running" },
          conditions: [],
          observedGeneration: 0,
          resourceVersion: rv,
          metadata: { generation: 1 },
        };

        try {
          const result = await confirmAndMutate<"AgentSession", void>({
            entity,
            message: "Archive session before going back?",
            dangerous: true,
            mutation: (token) => provider.archiveSession(token),
          });
          if (!result.ok && result.reason === "cancelled") {
            // Operator cancelled — stay on the running screen.
            return;
          }
          // ok | max-retries → navigate back regardless. max-retries means
          // the server kept rejecting our RV; the operator already saw the
          // banner and chose to give up, so don't strand them on a screen
          // they explicitly tried to leave.
          onNavigateBackToMain();
        } catch {
          // Non-409 failure (network, 5xx). Best-effort: still navigate so
          // the operator isn't trapped on the running screen. Server-side
          // archive can be retried from preset-select if needed.
          onNavigateBackToMain();
        }
      })();
    }, [provider, sessionId, confirmAndMutate, onNavigateBackToMain]);

    return (
      <RunningView
        {...rest}
        provider={provider}
        sessionId={sessionId}
        onBackToMain={handleBackToMain}
      />
    );
  });

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
