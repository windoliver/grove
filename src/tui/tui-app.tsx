/**
 * TUI application wrapper — handles the setup -> starting -> boardroom lifecycle.
 *
 * Always shows the setup screen first so the user can choose what to do:
 * - Resume an existing grove (if .grove/ exists)
 * - Create a new grove (select preset)
 * - Connect to a remote Nexus
 *
 * After the user picks an action, services start inside the TUI with
 * progress feedback, then transitions to the full boardroom App.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useRef, useState } from "react";
import type { AppProps } from "./app.js";
import { theme } from "./theme.js";

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
  const { groveExists, groveInfo, presets, onInit, onStart, onConnect } = props;
  const renderer = useRenderer();

  const [mode, setMode] = useState<TuiMode>("setup");
  const [appProps, setAppProps] = useState<AppProps | undefined>();
  const [initPreset, setInitPreset] = useState<string>("");
  const [initSteps, setInitSteps] = useState<readonly { label: string; done: boolean }[]>(
    INIT_STEPS.map((label) => ({ label, done: false })),
  );
  const [initError, setInitError] = useState<string | undefined>();
  const [startingSteps, setStartingSteps] = useState<string[]>([]);
  const [startingDone, setStartingDone] = useState(false);

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
  // Render based on mode
  // ---------------------------------------------------------------------------

  if (mode === "boardroom" && appProps) {
    // Lazy import App to avoid circular deps — rendered via React.createElement
    const { App } = require("./app.js") as typeof import("./app.js");
    return React.createElement(App, appProps);
  }

  if (mode === "initializing") {
    const { InitProgressView } =
      require("./views/init-progress.js") as typeof import("./views/init-progress.js");
    return React.createElement(InitProgressView, {
      presetName: initPreset,
      steps: initSteps,
      error: initError,
    });
  }

  if (mode === "starting") {
    const { InitProgressView } =
      require("./views/init-progress.js") as typeof import("./views/init-progress.js");
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
    const { WelcomeScreen } = require("./views/welcome.js") as typeof import("./views/welcome.js");
    return React.createElement(WelcomeScreen, {
      presets,
      groveExists,
      groveInfo,
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
