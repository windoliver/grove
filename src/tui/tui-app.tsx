/**
 * TUI application wrapper — handles the welcome -> init -> boardroom transition.
 *
 * When launched without an existing .grove/ directory, shows the welcome
 * screen for preset selection, runs initialization with progress feedback,
 * and then transitions to the full boardroom App.
 *
 * When .grove/ already exists, renders the boardroom App directly.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useState } from "react";
import type { AppProps } from "./app.js";
import { theme } from "./theme.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The TUI mode state machine: welcome -> initializing -> boardroom. */
type TuiMode = "welcome" | "initializing" | "boardroom";

/** A preset entry for the welcome screen. */
export interface TuiPresetEntry {
  readonly name: string;
  readonly description: string;
  /** Extended details for the ? overlay (mode, backend, topology summary). */
  readonly details?: string | undefined;
}

/** Props for the TuiApp wrapper component. */
export interface TuiAppProps {
  /** If true, start in welcome mode (no .grove/ found). */
  readonly welcomeMode: boolean;
  /** Props for the boardroom App (undefined in welcome mode until init completes). */
  readonly appProps?: AppProps | undefined;
  /** Presets for the welcome screen. */
  readonly presets?: readonly TuiPresetEntry[] | undefined;
  /** Callback to run init for a selected preset + grove name. Returns AppProps on success. */
  readonly onInit?: ((presetName: string, groveName: string) => Promise<AppProps>) | undefined;
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

/** TUI application root that manages the welcome -> boardroom lifecycle. */
export const TuiApp: React.NamedExoticComponent<TuiAppProps> = React.memo(function TuiApp(
  props: TuiAppProps,
): React.ReactNode {
  const { welcomeMode, appProps: initialAppProps, presets, onInit } = props;
  const renderer = useRenderer();

  const [mode, setMode] = useState<TuiMode>(welcomeMode ? "welcome" : "boardroom");
  const [appProps, setAppProps] = useState<AppProps | undefined>(initialAppProps);
  const [initPreset, setInitPreset] = useState<string>("");
  const [initSteps, setInitSteps] = useState<readonly { label: string; done: boolean }[]>(
    INIT_STEPS.map((label) => ({ label, done: false })),
  );
  const [initError, setInitError] = useState<string | undefined>();

  /** Handle quit from the welcome screen. */
  const handleQuit = useCallback(() => {
    renderer.destroy();
  }, [renderer]);

  /** Handle preset + name selection — kicks off initialization. */
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

          const result = await onInit(presetName, groveName);

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

  // Keyboard handler for init error state (q to quit)
  useKeyboard(
    useCallback(
      (key) => {
        if (mode === "initializing" && initError && key.name === "q") {
          handleQuit();
        }
      },
      [mode, initError, handleQuit],
    ),
  );

  // ---------------------------------------------------------------------------
  // Render based on mode
  // ---------------------------------------------------------------------------

  if (mode === "boardroom" && appProps) {
    // Lazy import App to avoid circular deps — rendered via React.createElement
    // The App component is loaded by the caller and passed via appProps
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

  // Welcome mode
  if (presets && presets.length > 0) {
    const { WelcomeScreen } = require("./views/welcome.js") as typeof import("./views/welcome.js");
    return React.createElement(WelcomeScreen, {
      presets,
      onSelect: handleSelect,
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
