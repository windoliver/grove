/**
 * TUI application wrapper — handles the setup -> starting -> session lifecycle.
 *
 * Always shows the setup screen first so the user can choose what to do:
 * - Resume an existing grove (if .grove/ exists)
 * - Create a new grove (select preset)
 * - Connect to a remote Nexus
 *
 * After the user picks an action, services start inside the TUI with
 * progress feedback, then transitions to the simplified 5-screen flow
 * (ScreenManager). The boardroom App is reachable only as a deep-inspect
 * overlay via Ctrl+G from RunningView.
 */

import { join } from "node:path";
import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppProps } from "./app.js";
import { connectBridgeWithRetry } from "./bridge-retry.js";
import { createAcpMessageSink } from "./data/acp-message-sink.js";
import { AcpSessionStore } from "./data/acp-session-store.js";
import { debugLog } from "./debug-log.js";
import { useEntityStoreFactoryOptional } from "./hooks/entity-store-context.js";
import type { SessionRecord } from "./provider.js";
import {
  type ConfirmAndMutateEntityBus,
  ConfirmAndMutateProvider,
  makeEntityBusFromStore,
} from "./safety/index.js";
import { ScreenManager } from "./screens/screen-manager.js";
import { FileSessionStore } from "./session-store.js";
import { SpawnManager } from "./spawn-manager.js";
import { SpawnManagerContext } from "./spawn-manager-context.js";
import { theme } from "./theme.js";
import { InitProgressView } from "./views/init-progress.js";
import { WelcomeScreen } from "./views/welcome/index.js";

// C6 (#304) round-3: ConfirmAndMutateProvider must sit ABOVE ScreenManager
// so the open-state context propagates to usePermissionDetection (which is
// called inside ScreenManager's render). Originally the provider lived in
// PagesRouter (a descendant) — but React context only flows downward, so
// the permission hook above PagesRouter read the default `false` value and
// its y/n shortcuts could fire alongside the modal's confirm/cancel keys.
// (Round-3 review #1.)
const NULL_BUS: ConfirmAndMutateEntityBus = {
  get: () => undefined,
  subscribe: () => () => undefined,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The TUI mode state machine: setup -> initializing/starting -> session. */
type TuiMode = "setup" | "initializing" | "starting" | "session";

/** A preset entry for the welcome screen. */
export interface TuiPresetEntry {
  readonly name: string;
  readonly description: string;
  /** Extended details for the ? overlay (mode, backend, topology summary). */
  readonly details?: string | undefined;
}

/** Props for the TuiApp wrapper component. */
export interface TuiAppProps {
  readonly groveExists: boolean;
  readonly groveInfo?: { name: string; preset: string } | undefined;
  readonly presets?: readonly TuiPresetEntry[] | undefined;
  readonly sessions?: readonly import("./provider.js").SessionRecord[] | undefined;
  readonly onInit?:
    | ((
        presetName: string,
        groveName: string,
        onProgress?: (step: string) => void,
      ) => Promise<AppProps>)
    | undefined;
  /** Called when resuming an existing grove. `sessionId` is provided when the user picked a specific session from the fast-path list. */
  readonly onStart?:
    | ((onProgress?: (step: string) => void, sessionId?: string) => Promise<AppProps>)
    | undefined;
  readonly onConnect?: ((nexusUrl: string) => Promise<AppProps>) | undefined;
  /** Start a new session in an existing grove. */
  readonly onNewSession?: ((presetName: string) => Promise<AppProps>) | undefined;
  readonly autoConnectNexus?: string | undefined;
}

// ---------------------------------------------------------------------------
// Init progress step definitions
// ---------------------------------------------------------------------------

const INIT_STEPS = [
  "Creating .grove/ directory",
  "Initializing database",
  "Generating GROVE.md contract",
  "Writing configuration",
  "Seeding demo data",
  "Starting services",
] as const;

export function shouldUseLocalContributionRoutingForMissingBridge(
  backendMode: AppProps["backendMode"],
): boolean {
  return backendMode === "local";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** TUI application root that manages the setup -> session lifecycle. */
export const TuiApp: React.NamedExoticComponent<TuiAppProps> = React.memo(function TuiApp(
  props: TuiAppProps,
): React.ReactNode {
  const {
    groveExists,
    groveInfo,
    presets,
    onInit,
    onStart,
    onConnect,
    onNewSession,
    autoConnectNexus,
  } = props;
  const renderer = useRenderer();

  const [mode, setMode] = useState<TuiMode>(autoConnectNexus ? "starting" : "setup");
  const [appProps, setAppProps] = useState<AppProps | undefined>();
  const [initPreset, setInitPreset] = useState<string>("");
  const [initSteps, setInitSteps] = useState<readonly { label: string; done: boolean }[]>(
    INIT_STEPS.map((label) => ({ label, done: false })),
  );
  const [initError, setInitError] = useState<string | undefined>();
  const [startingSteps, setStartingSteps] = useState<string[]>([]);
  const [startingDone, setStartingDone] = useState(false);
  /** Tracks whether we reached the session view via Resume (start on RunningView). */
  const isResumedRef = useRef(false);
  const autoConnectTriggered = useRef(false);

  // Auto-connect to Nexus when --nexus flag is passed
  React.useEffect(() => {
    if (autoConnectNexus && onConnect && !autoConnectTriggered.current) {
      autoConnectTriggered.current = true;
      setStartingSteps([`Connecting to ${autoConnectNexus}...`]);
      // Don't set isResumed — we want the full interactive flow (goal → prompts → run)

      void (async () => {
        try {
          const result = await onConnect(autoConnectNexus);
          setStartingDone(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 300));
          setAppProps(result);
          setMode("session");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setInitError(message);
          setMode("setup"); // Fall back to setup on failure
        }
      })();
    }
  }, [autoConnectNexus, onConnect]);

  /** Handle quit from the setup screen. */
  const handleQuit = useCallback(() => {
    renderer.destroy();
  }, [renderer]);

  /** Handle "New grove" — preset + name selected, kicks off initialization. */
  const handleSelect = useCallback(
    (args: {
      preset: string;
      name: string;
      mode: import("./views/welcome/router.js").WelcomeMode;
      keymap: import("./views/welcome/customize-keyboard.js").KeymapChoice;
    }) => {
      if (!onInit) return;
      const { preset: presetName, name: groveName } = args;
      // mode + keymap are honored upstream (keymap via Customize, mode via main.ts resolveBackend).
      setMode("initializing");
      setInitPreset(presetName);
      setInitError(undefined);
      setInitSteps(INIT_STEPS.map((label) => ({ label, done: false })));

      void (async () => {
        try {
          const markStep = (index: number) => {
            setInitSteps((prev) => prev.map((s, i) => (i <= index ? { ...s, done: true } : s)));
          };
          markStep(0);

          const result = await onInit(presetName, groveName, (step) => {
            setInitSteps((prev) => {
              const updated = prev.map((s) => ({ ...s, done: true }));
              if (updated.some((s) => s.label === step)) return updated;
              return [...updated, { label: step, done: false }];
            });
          });

          setInitSteps((prev) => prev.map((s) => ({ ...s, done: true })));
          await new Promise<void>((resolve) => setTimeout(resolve, 500));

          setAppProps(result);
          setMode("session");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[grove init failed] ${message}\n`);
          setInitError(message);
        }
      })();
    },
    [onInit],
  );

  /** Handle "Resume" — start services for existing grove. */
  const handleResume = useCallback(
    (sessionId?: string) => {
      if (!onStart) return;

      setMode("starting");
      setInitError(undefined);
      setStartingDone(false);
      setStartingSteps(["Starting services..."]);
      isResumedRef.current = true;

      void (async () => {
        try {
          const result = await onStart(
            (step) => setStartingSteps((prev) => [...prev, step]),
            sessionId,
          );

          setStartingDone(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 300));

          setAppProps(result);
          setMode("session");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setInitError(message);
        }
      })();
    },
    [onStart],
  );

  /** Handle `n` on fast-path — new session in existing grove. */
  const handleNewSession = useCallback(
    (presetName: string) => {
      if (!onNewSession) return;

      setMode("starting");
      setInitError(undefined);
      setStartingDone(false);
      setStartingSteps(["Starting session..."]);
      isResumedRef.current = false;

      void (async () => {
        try {
          const result = await onNewSession(presetName);
          setStartingDone(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          setAppProps(result);
          setMode("session");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setInitError(message);
        }
      })();
    },
    [onNewSession],
  );

  // Preserve the last-attempted Nexus URL across WelcomeScreen unmounts so
  // an operator who hits a connect error doesn't lose their typed URL when
  // they Esc back to setup and re-enter Connect.
  const [lastNexusUrl, setLastNexusUrl] = useState<string | undefined>(undefined);

  /** Handle "Connect to remote Nexus" — connect without starting local services. */
  const handleConnect = useCallback(
    (nexusUrl: string) => {
      if (!onConnect) return;

      setLastNexusUrl(nexusUrl);
      setMode("starting");
      setInitError(undefined);
      setStartingDone(false);
      setStartingSteps([`Connecting to ${nexusUrl}...`]);
      isResumedRef.current = true;

      void (async () => {
        try {
          const result = await onConnect(nexusUrl);

          setStartingDone(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 300));

          setAppProps(result);
          setMode("session");
          // Drop the stored URL once we've successfully transitioned —
          // no future session→setup path should pre-fill Connect with
          // the previously-successful URL.
          setLastNexusUrl(undefined);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setInitError(message);
        }
      })();
    },
    [onConnect],
  );

  // Use refs to avoid stale closures in useKeyboard (opentui may not
  // re-subscribe when the callback reference changes).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const initErrorRef = useRef(initError);
  initErrorRef.current = initError;
  // Tracks ACP event-bus subscriptions so they can be unsubscribed when
  // the SpawnManager is rebuilt or the component unmounts. Without this,
  // handlers would leak and reprocess future events through stale sinks.
  const acpBusUnsubscribesRef = useRef<Array<() => void>>([]);

  // Keyboard handler for error states (q to quit, Esc to go back to setup)
  useKeyboard(
    useCallback(
      (key) => {
        if (
          (modeRef.current === "initializing" || modeRef.current === "starting") &&
          initErrorRef.current
        ) {
          if (key.name === "q") {
            handleQuit();
          } else if (key.name === "escape") {
            setMode("setup");
            setInitError(undefined);
          }
        }
      },
      [handleQuit],
    ),
  );

  // ---------------------------------------------------------------------------
  // SpawnManager singleton — created once when AppProps first resolve.
  // Shared via SpawnManagerContext to both ScreenManager and App (inspect overlay).
  // ---------------------------------------------------------------------------

  const spawnManager = useMemo(() => {
    if (!appProps) return undefined;
    const { provider, tmux, groveDir, agentRuntime } = appProps;

    // Null-provider guard (flagged as critical failure mode in eng review)
    if (!provider) return undefined;

    let sessionStore: FileSessionStore | undefined;
    if (groveDir) {
      try {
        sessionStore = new FileSessionStore(groveDir);
      } catch {
        // Session persistence is best-effort
      }
    }
    // Tear down subscriptions from a previous manager incarnation before
    // rebuilding — useMemo may run more than once per component lifetime
    // when `appProps` changes, and unsubscribed handlers retain stale sink
    // closures that would otherwise ingest events forever.
    for (const unsubscribe of acpBusUnsubscribesRef.current) {
      unsubscribe();
    }
    acpBusUnsubscribesRef.current = [];

    const acpSessionStore = new AcpSessionStore();
    const acpSink = createAcpMessageSink(acpSessionStore);
    // Stable per-TUI-process identity, threaded into the bridge so SSE
    // self-loop dedupe is strict-matched against `payload.sourceInstance`
    // (see NexusWsBridge.handleIpcEnvelope). Without this, two Grove
    // instances sharing a Nexus and reusing role names would drop each
    // other's typed ACP events. Publisher callers must embed the same
    // value as `sourceInstance` — wiring that in is tracked in a
    // follow-up once a production publisher call site lands.
    const localInstanceId = crypto.randomUUID();
    if (appProps.eventBus && appProps.topology) {
      const bus = appProps.eventBus;
      for (const role of appProps.topology.roles) {
        const handler = (ev: import("../core/event-bus.js").GroveEvent): void => {
          acpSink.handleGroveEvent(ev);
        };
        bus.subscribe(role.name, handler);
        acpBusUnsubscribesRef.current.push(() => bus.unsubscribe(role.name, handler));
      }
    }

    const manager = new SpawnManager(
      provider,
      tmux,
      (msg) => {
        process.stderr.write(`[spawn] ${msg}\n`);
      },
      groveDir
        ? [{ kind: "local" as const, path: join(groveDir, "..") }]
        : [{ kind: "local" as const, path: process.cwd() }],
      sessionStore,
      groveDir,
      agentRuntime,
      acpSessionStore,
    );

    // Wire NexusWsBridge for push-based IPC
    const nexusUrl = process.env.GROVE_NEXUS_URL;
    const apiKey = process.env.NEXUS_API_KEY;
    const topo = appProps.topology;
    // Seed topology synchronously so the fail-closed catch below and
    // onRoleUnhealthy callback see the right role count even if bridge
    // init fails before the screen-manager flow calls setTopology.
    if (topo) manager.setTopology(topo);
    debugLog(
      "wsBridge",
      `check: agentRuntime=${!!agentRuntime} topo=${!!topo} nexusUrl=${nexusUrl ?? "none"} hasApiKey=${!!apiKey} hasEventBus=${!!appProps.eventBus}`,
    );
    if (agentRuntime && topo && nexusUrl && apiKey) {
      void import("./nexus-ws-bridge.js")
        .then(async ({ NexusWsBridge }) => {
          debugLog("wsBridge", `creating NexusWsBridge at ${nexusUrl}`);
          // Extract handoffStore from the provider so the bridge can mark
          // handoffs delivered / dead-lettered on IPC lifecycle events.
          // Without this thread, the bridge's handoff bookkeeping is dead
          // code in production (opts.handoffStore would be undefined and
          // every store-touching path short-circuits).
          const maybeProvider = appProps.provider as {
            getHandoffStore?: () => import("../core/handoff.js").HandoffStore | undefined;
            getNexusZoneId?: () => string;
          };
          const handoffStore =
            typeof maybeProvider.getHandoffStore === "function"
              ? maybeProvider.getHandoffStore()
              : undefined;
          const zoneId =
            typeof maybeProvider.getNexusZoneId === "function"
              ? maybeProvider.getNexusZoneId()
              : undefined;
          const bridge = new NexusWsBridge({
            topology: topo,
            runtime: agentRuntime,
            nexusUrl,
            apiKey,
            getSessionId: () => manager.getSessionId(),
            zoneId,
            eventBus: appProps.eventBus,
            handoffStore,
            onAcpEvent: (ev) => acpSink.handleGroveEvent(ev),
            localInstanceId,
            onBeforeDeliver: (sender, recipient) => {
              // Rsync workspace files from sender to recipient before IPC delivery
              manager.syncWorkspaces(sender, recipient);
            },
            // Post-start outage escalation: if a role's SSE reconnect loop
            // fails repeatedly, stop pretending the session has delivery.
            // Flips the SpawnManager to disabled so new spawns for
            // multi-role topologies fail fast instead of accumulating work
            // that silently drops. Polling is NOT reintroduced.
            onRoleUnhealthy: (role, fails) => {
              const reason = `SSE stream for role=${role} unhealthy after ${fails} consecutive failures`;
              process.stderr.write(`[grove] DEGRADED: ${reason}\n`);
              // Query live topology at callback time — a session
              // topology change after construction (preset picked in
              // screen-manager) would make the captured `topo` stale.
              // Fail closed only when the ACTIVE topology is multi-role.
              if ((manager.getTopology()?.roles.length ?? 0) > 1) {
                manager.markDeliveryDisabled(reason);
              }
            },
            // Recovery: when the SSE channel comes back after a degraded
            // window, flip delivery back to ready so the session resumes
            // accepting work instead of staying fail-closed forever.
            onRoleRecovered: (role) => {
              process.stderr.write(`[grove] RECOVERED: SSE stream for role=${role}\n`);
              manager.markDeliveryRecovered();
            },
          });
          // Bridge readiness is a startup invariant: connect() resolves only
          // after every role passes registration + SSE stream handshake.
          // Without polling fallback, we must not expose an unready bridge
          // or a "connected" log that outruns reality. Transient startup
          // faults (a brief Nexus blip, DNS flake) shouldn't kill a session
          // permanently, so retry with exponential backoff before giving up.
          await connectBridgeWithRetry(bridge, {
            onAttemptFailure: (attempt, attempts, detail) => {
              debugLog("wsBridge", `attempt ${attempt}/${attempts} failed: ${detail}`);
            },
          });
          manager.setWsBridge(bridge);
          debugLog("wsBridge", "connected");
        })
        .catch((err) => {
          // Bridge is the ONLY inter-agent delivery channel (no polling
          // fallback). After bounded retries fail, fail closed for
          // multi-role topologies only — single-role sessions don't
          // need IPC and shouldn't be blocked by a bridge outage.
          // Query live topology (session topology may have changed
          // after this useMemo ran, making `topo` stale).
          const detail = err instanceof Error ? err.message : String(err);
          debugLog("wsBridge", `FAILED: ${detail}`);
          if ((manager.getTopology()?.roles.length ?? 0) > 1) {
            manager.markDeliveryDisabled(detail);
          }
          process.stderr.write(
            `[grove] FATAL: NexusWsBridge init failed — contributions will not reach agents. ${detail}\n`,
          );
        });
    } else if (agentRuntime && topo) {
      // Bridge preconditions missing. In local mode, agent MCP processes write
      // signed contributions into the shared local store; the SpawnManager
      // polls that store and pushes verified work to downstream ACP sessions.
      // Remote/Nexus backends need their configured push path so we fail closed
      // instead of polling a provider that may not share the agent write path.
      const reason = `missing Nexus config (nexusUrl=${nexusUrl ?? "none"} apiKey=${apiKey ? "set" : "missing"})`;
      const useLocalRouting = shouldUseLocalContributionRoutingForMissingBridge(
        appProps.backendMode,
      );
      if (topo.roles.length > 1) {
        if (useLocalRouting) {
          manager.enableLocalContributionDelivery();
        } else {
          manager.markDeliveryDisabled(reason);
        }
      }
      process.stderr.write(
        useLocalRouting
          ? `[grove] WARNING: Nexus bridge not initialized (${reason}). Using local contribution polling for inter-agent delivery.\n`
          : `[grove] WARNING: Nexus bridge not initialized (${reason}). Inter-agent contribution delivery is disabled.\n`,
      );
    } else if (topo && !agentRuntime) {
      // Topology declared but no agent runtime. Multi-role sessions
      // can't deliver contributions without one — fail closed. Single-
      // role sessions (e.g., tmux fallback with one role) stay spawnable.
      const reason = "agentRuntime unavailable — ACP spawn and delivery are disabled";
      if (topo.roles.length > 1) {
        manager.markDeliveryDisabled(reason);
      }
      process.stderr.write(`[grove] WARNING: ${reason}.\n`);
    }

    return manager;
  }, [appProps]);

  // Cleanup SpawnManager on unmount or when appProps change
  useEffect(() => {
    return () => {
      for (const unsubscribe of acpBusUnsubscribesRef.current) {
        unsubscribe();
      }
      acpBusUnsubscribesRef.current = [];
      spawnManager?.destroy();
    };
  }, [spawnManager]);

  // ---------------------------------------------------------------------------
  // Render based on mode
  // ---------------------------------------------------------------------------

  if (mode === "session" && appProps && spawnManager) {
    // Resumed groves start on RunningView (Screen 4); new groves start on
    // PresetSelect (Screen 1) — but for resumed groves that already went
    // through welcome, we skip directly to RunningView.
    const initialState = appProps.newSessionPreset
      ? { screen: "goal-input" as const, selectedPreset: appProps.newSessionPreset }
      : undefined;
    return (
      <SpawnManagerContext value={spawnManager}>
        <BoardroomShell
          appProps={appProps}
          presets={presets}
          sessions={props.sessions}
          startOnRunning={isResumedRef.current && !appProps.newSessionPreset}
          initialState={initialState}
          resumeSessionId={appProps.resumeSessionId}
        />
      </SpawnManagerContext>
    );
  }

  if (mode === "initializing") {
    return React.createElement(InitProgressView, {
      presetName: initPreset,
      steps: initSteps,
      error: initError,
    });
  }

  if (mode === "starting") {
    const steps = startingSteps.map((label, i) => ({
      label,
      done: startingDone || i < startingSteps.length - 1,
    }));
    // If there's an error, mark the last step as not done for visual distinction
    if (initError && steps.length > 0) {
      const last = steps[steps.length - 1];
      if (last) steps[steps.length - 1] = { ...last, done: false };
    }
    return React.createElement(InitProgressView, {
      presetName: groveInfo?.name ?? "services",
      steps,
      error: initError,
    });
  }

  // Setup mode — always shown first
  if (presets && presets.length > 0) {
    return React.createElement(WelcomeScreen, {
      presets,
      groveExists,
      groveInfo,
      sessions: props.sessions,
      connectError: initError,
      initialNexusUrl: lastNexusUrl,
      onSelect: handleSelect,
      onResume: handleResume,
      onNewSession: handleNewSession,
      onConnect: handleConnect,
      onQuit: handleQuit,
    });
  }

  // Fallback: no presets loaded
  return (
    <box flexDirection="column" paddingX={2} paddingTop={1}>
      <text color={theme.error}>No presets available. Run grove init manually.</text>
    </box>
  );
});

// ---------------------------------------------------------------------------
// BoardroomShell — mounts ConfirmAndMutateProvider above ScreenManager so
// usePermissionDetection (called inside ScreenManager's render) sees the
// open-state context. Pre-round-3 the provider lived in PagesRouter, which
// is a descendant; the permission y/n shortcut therefore stayed active
// while the modal was open and could double-fire on confirm/cancel keys.
// ---------------------------------------------------------------------------

interface BoardroomShellProps {
  readonly appProps: AppProps;
  readonly presets?: readonly TuiPresetEntry[] | undefined;
  readonly sessions?: readonly SessionRecord[] | undefined;
  readonly startOnRunning?: boolean | undefined;
  readonly initialState?: { screen: "goal-input"; selectedPreset: string } | undefined;
  readonly resumeSessionId?: string | undefined;
}

const BoardroomShell: React.NamedExoticComponent<BoardroomShellProps> = React.memo(
  function BoardroomShell({
    appProps,
    presets,
    sessions,
    startOnRunning,
    initialState,
    resumeSessionId,
  }: BoardroomShellProps) {
    const entityStoreFactory = useEntityStoreFactoryOptional();
    const entityBus = useMemo<ConfirmAndMutateEntityBus>(
      () => (entityStoreFactory ? makeEntityBusFromStore(entityStoreFactory) : NULL_BUS),
      [entityStoreFactory],
    );
    return (
      <ConfirmAndMutateProvider entityBus={entityBus}>
        {React.createElement(ScreenManager, {
          appProps,
          presets,
          sessions,
          startOnRunning,
          initialState,
          resumeSessionId,
        })}
      </ConfirmAndMutateProvider>
    );
  },
);
