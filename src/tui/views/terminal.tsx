/**
 * Terminal view — shows captured output from the selected agent's tmux session.
 *
 * When ghostty-opentui is available, renders via GhosttyTerminalRenderable for
 * full ANSI/VT support (colors, cursor, SGR attributes). Falls back to plain
 * text capture when the native library is not loadable (e.g., missing Zig
 * shared object on the current platform).
 *
 * The dynamic import is wrapped in a module-level promise so that:
 *  1. We only attempt the import once (not on every render).
 *  2. The fallback path has zero overhead — no per-frame try/catch.
 *
 * In terminal input mode (press 'i' when Terminal panel focused),
 * keystrokes are forwarded to the tmux session via sendKeys.
 */

import React, { createElement, useCallback, useEffect, useState } from "react";
import type { TmuxManager } from "../agents/tmux-manager.js";
import type { InputMode } from "../hooks/use-panel-focus.js";
import { usePolledData } from "../hooks/use-polled-data.js";

// ---------------------------------------------------------------------------
// Ghostty integration — dynamic import with graceful fallback
// ---------------------------------------------------------------------------

/**
 * We attempt to load ghostty-opentui/opentui at module level so the cost is
 * paid once. The package exports `GhosttyTerminalRenderable`, a subclass of
 * OpenTUI's `TextBufferRenderable` that renders ANSI/VT content natively.
 *
 * If the import fails (missing native binary, unsupported platform, etc.)
 * we fall back to the plain-text capture path — no user-visible error.
 */
interface GhosttyModule {
  readonly GhosttyTerminalRenderable: unknown;
}

let ghosttyRegistered = false;

const ghosttyPromise: Promise<GhosttyModule | null> = Promise.all([
  import("ghostty-opentui/opentui") as Promise<GhosttyModule>,
  import("@opentui/react") as Promise<{ extend?: (objects: Record<string, unknown>) => void }>,
])
  .then(([mod, opentui]) => {
    // Register the renderable as an intrinsic element so it can be used in JSX
    // via React.createElement("ghostty-terminal", { ... }).
    // `extend` from @opentui/react maps element names to renderable classes.
    if (typeof opentui.extend === "function" && mod.GhosttyTerminalRenderable) {
      opentui.extend({ "ghostty-terminal": mod.GhosttyTerminalRenderable });
      ghosttyRegistered = true;
    }
    return mod;
  })
  .catch(() => null);

/** Hook that resolves the ghostty module once and caches the result. */
function useGhosttyAvailable(): boolean {
  const [available, setAvailable] = useState(ghosttyRegistered);
  useEffect(() => {
    if (ghosttyRegistered) {
      setAvailable(true);
      return;
    }
    let cancelled = false;
    ghosttyPromise.then((mod) => {
      if (!cancelled && mod !== null && ghosttyRegistered) {
        setAvailable(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Props for the Terminal view. */
export interface TerminalProps {
  /** The tmux session name to display. */
  readonly sessionName?: string | undefined;
  /** TmuxManager for pane capture. */
  readonly tmux?: TmuxManager | undefined;
  /** Polling interval for capture refresh. */
  readonly intervalMs: number;
  /** Whether this view is actively polling. */
  readonly active: boolean;
  /** Current input mode. */
  readonly mode: InputMode;
}

/** Terminal output view. */
export const TerminalView: React.NamedExoticComponent<TerminalProps> = React.memo(
  function TerminalView({
    sessionName,
    tmux,
    intervalMs,
    active,
    mode,
  }: TerminalProps): React.ReactNode {
    const captureMs = Math.max(intervalMs, 200); // minimum 200ms for terminal
    const ghosttyAvailable = useGhosttyAvailable();

    const fetcher = useCallback(async () => {
      if (!tmux || !sessionName) return "";
      return tmux.capturePanes(sessionName);
    }, [tmux, sessionName]);

    const { data: output } = usePolledData<string>(
      fetcher,
      captureMs,
      active && !!sessionName && !!tmux,
    );

    if (!tmux) {
      return (
        <box>
          <text opacity={0.5}>Terminal requires tmux — not available</text>
        </box>
      );
    }

    if (!sessionName) {
      return (
        <box flexDirection="column">
          <text opacity={0.5}>Select an agent (panel 5) to view terminal output</text>
          <text opacity={0.5}>Press i to enter input mode, Esc to exit</text>
        </box>
      );
    }

    const isInputMode = mode === "terminal_input";
    const rawOutput = output ?? "";

    // Status header — shared by both rendering paths
    const header = (
      <box>
        <text color="#888888">
          session: {sessionName}
          {isInputMode ? (
            <text color="#00cccc"> [INPUT]</text>
          ) : (
            <text opacity={0.5}> (press i to type)</text>
          )}
        </text>
      </box>
    );

    // --- Ghostty path: full ANSI/VT rendering ---
    if (ghosttyAvailable && rawOutput.length > 0) {
      return (
        <box flexDirection="column">
          {header}
          {/* createElement used because "ghostty-terminal" is a dynamically
              registered intrinsic element without static JSX type definitions. */}
          {createElement("ghostty-terminal" as string, {
            ansi: rawOutput,
            cols: 120,
            rows: 30,
            trimEnd: true,
          })}
        </box>
      );
    }

    // --- Fallback path: plain text line rendering ---
    const trimmedOutput = rawOutput.trimEnd();
    const lines = trimmedOutput ? trimmedOutput.split("\n").slice(-30) : [];

    return (
      <box flexDirection="column">
        {header}
        {lines.length > 0 ? (
          <box flexDirection="column">
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: terminal lines have no stable identity
              <text key={i}>{line}</text>
            ))}
          </box>
        ) : (
          <text opacity={0.5}>(no output)</text>
        )}
      </box>
    );
  },
);
