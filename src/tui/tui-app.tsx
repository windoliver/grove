/**
 * TUI application wrapper — handles the setup -> starting -> boardroom lifecycle.
 *
 * Always shows the setup screen first so the user can choose what to do:
 * - Resume an existing grove (if .grove/ exists)
 * - Create a new grove (select preset)
 * - Connect to a remote Nexus
 *
 * After the user picks an action, services start inside the TUI with
 * progress feedback, then transitions to the simplified 5-screen flow
 * (ScreenManager) or the full boardroom App (advanced mode via Tab).
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppProps } from "./app.js";
import { createAcpMessageSink } from "./data/acp-message-sink.js";
import { AcpSessionStore } from "./data/acp-session-store.js";
import { debugLog } from "./debug-log.js";
import { ScreenManager } from "./screens/screen-manager.js";
import { FileSessionStore } from "./session-store.js";
import { SpawnManager } from "./spawn-manager.js";
import { SpawnManagerContext } from "./spawn-manager-context.js";
import { theme } from "./theme.js";
import { InitProgressView } from "./views/init-progress.js";
import { WelcomeScreen } from "./views/welcome.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The TUI mode state machine: setup -> initializing/starting -> boardroom. */
type TuiMode = "setup" | "initializing" | "starting" | "boardroom";

/** A preset entry for the welcome screen. */
export interface TuiPresetEntry {
  readonly name: string;
  readonly description: string;
  /** Extended details for the ? overlay (mode, backend, topology summary). */
  readonly details?: string | undefined;
}

/** Props for the TuiApp wrapper component. */
export interface TuiAppProps {
  /** Whether a .grove/ directory exists. */
  readonly groveExists: boolean;
  /** Info about the existing grove (name + preset), if .grove/ exists. */
  readonly groveInfo?: { name: string; preset: string } | undefined;
  /** Presets for the welcome screen. */
  readonly presets?: readonly TuiPresetEntry[] | undefined;
  /** Past sessions to display on the welcome screen for context. */
  readonly sessions?: readonly import("./provider.js").SessionRecord[] | undefined;
  /** Callback to run init for a selected preset + grove name. Returns AppProps on success. */
  readonly onInit?:
    | ((
        presetName: string,
        groveName: string,
        onProgress?: (step: string) => void,
      ) => Promise<AppProps>)
    | undefined;
  /** Callback to start services for an existing grove. Accepts a progress reporter. */
  readonly onStart?: ((onProgress?: (step: string) => void) => Promise<AppProps>) | undefined;
  /** Callback to connect to a remote Nexus URL. Returns AppProps on success. */
  readonly onConnect?: ((nexusUrl: string) => Promise<AppProps>) | undefined;
  /** If set, auto-connect to this Nexus URL on mount (skip welcome screen). */
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** TUI application root that manages the setup -> boardroom lifecycle. */
export const TuiApp: React.NamedExoticComponent<TuiAppProps> = React.memo(function TuiApp(
  props: TuiAppProps,
): React.ReactNode {
  const { groveExists, groveInfo, presets, onInit, onStart, onConnect, autoConnectNexus } = props;
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
  /** Tracks whether we reached boardroom via Resume (start on RunningView). */
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
          setMode("boardroom");
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
    (presetName: string, groveName: string) => {
      if (!onInit) return;

      setMode("initializing");
      setInitPreset(presetName);
      setInitError(undefined);
      setInitSteps(INIT_STEPS.map((label) => ({ label, done: false })));

      // Run init asynchronously with progressive step updates
      void (async () => {
        try {
          const markStep = (index: number) => {
            setInitSteps((prev) => prev.map((s, i) => (i <= index ? { ...s, done: true } : s)));
          };

          // Mark first step immediately
          markStep(0);

          const result = await onInit(presetName, groveName, (step) => {
            // Mark all existing static steps done, then append the live progress step
            setInitSteps((prev) => {
              const updated = prev.map((s) => ({ ...s, done: true }));
              // Avoid duplicate labels
              if (updated.some((s) => s.label === step)) return updated;
              return [...updated, { label: step, done: false }];
            });
          });

          // Mark all steps done on success
          setInitSteps((prev) => prev.map((s) => ({ ...s, done: true })));

          // Brief pause to show completion state before transitioning
          await new Promise<void>((resolve) => setTimeout(resolve, 500));

          setAppProps(result);
          setMode("boardroom");
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
  const handleResume = useCallback(() => {
    if (!onStart) return;

    setMode("starting");
    setInitError(undefined);
    setStartingDone(false);
    setStartingSteps(["Starting services..."]);
    isResumedRef.current = true;

    void (async () => {
      try {
        const result = await onStart((step) => {
          setStartingSteps((prev) => [...prev, step]);
        });

        // Mark all steps complete, brief pause to show completion
        setStartingDone(true);
        await new Promise<void>((resolve) => setTimeout(resolve, 300));

        setAppProps(result);
        setMode("boardroom");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setInitError(message);
      }
    })();
  }, [onStart]);

  /** Handle "Connect to remote Nexus" — connect without starting local services. */
  const handleConnect = useCallback(
    (nexusUrl: string) => {
      if (!onConnect) return;

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
          setMode("boardroom");
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
  // Shared via SpawnManagerContext to both ScreenManager and App (advanced mode).
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
      sessionStore,
      groveDir,
      agentRuntime,
      acpSessionStore,
    );

    // Wire NexusWsBridge for push-based IPC
    const nexusUrl = process.env.GROVE_NEXUS_URL;
    const apiKey = process.env.NEXUS_API_KEY;
    const topo = appProps.topology;
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
          };
          const handoffStore =
            typeof maybeProvider.getHandoffStore === "function"
              ? maybeProvider.getHandoffStore()
              : undefined;
          const bridge = new NexusWsBridge({
            topology: topo,
            runtime: agentRuntime,
            nexusUrl,
            apiKey,
            eventBus: appProps.eventBus,
            handoffStore,
            onAcpEvent: (ev) => acpSink.handleGroveEvent(ev),
            localInstanceId,
            onBeforeDeliver: (sender, recipient) => {
              // Rsync workspace files from sender to recipient before IPC delivery
              manager.syncWorkspaces(sender, recipient);
            },
          });
          // Bridge readiness is a startup invariant: connect() resolves only
          // after at least one role registration returns 2xx, which proves
          // endpoint + credentials. Without polling fallback, we must not
          // expose an unready bridge or a "connected" log that outruns reality.
          await bridge.connect();
          manager.setWsBridge(bridge);
          debugLog("wsBridge", "connected");
        })
        .catch((err) => {
          // Bridge is the ONLY inter-agent delivery channel (no polling
          // fallback). A silent failure here produces a session that looks
          // alive but can't route any contributions between roles. Surface
          // it on stderr in addition to debugLog so operators see it.
          const detail = err instanceof Error ? err.message : String(err);
          debugLog("wsBridge", `FAILED: ${detail}`);
          process.stderr.write(
            `[grove] FATAL: NexusWsBridge init failed — contributions will not reach agents. ${detail}\n`,
          );
        });
    } else if (agentRuntime && topo) {
      // Bridge preconditions missing: without a Nexus endpoint + credentials,
      // nothing will route contributions between agents. Warn loudly — this
      // used to be silently masked by the (now removed) TUI polling path.
      process.stderr.write(
        `[grove] WARNING: Nexus bridge not initialized (nexusUrl=${nexusUrl ?? "none"} apiKey=${apiKey ? "set" : "missing"}). Inter-agent contribution delivery is disabled.\n`,
      );
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

  if (mode === "boardroom" && appProps && spawnManager) {
    // Resumed groves start on RunningView (Screen 4); new groves start on
    // PresetSelect (Screen 1) — but for resumed groves that already went
    // through welcome, we skip directly to RunningView.
    return (
      <SpawnManagerContext value={spawnManager}>
        {React.createElement(ScreenManager, {
          appProps,
          presets,
          sessions: props.sessions,
          startOnRunning: isResumedRef.current,
        })}
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
      onSelect: handleSelect,
      onResume: handleResume,
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
