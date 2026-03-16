/**
 * Terminal view — shows captured output from the selected agent's tmux session.
 *
 * Uses @grove/libghostty for full ANSI/VT rendering when available, with
 * persistent terminal state per agent. Falls back to ghostty-opentui, then
 * to plain text if neither native library is loadable.
 *
 * Persistent mode: Each agent gets a GhosttyTerminal that maintains state
 * across .write() calls. On each poll, only the *new* bytes from tmux are
 * fed, avoiding re-parsing the entire ANSI blob every cycle.
 *
 * In terminal input mode (press 'i' when Terminal panel focused),
 * keystrokes are forwarded to the tmux session via sendKeys.
 */

import React, { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { TmuxManager } from "../agents/tmux-manager.js";
import type { InputMode } from "../hooks/use-panel-focus.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { theme } from "../theme.js";

// ---------------------------------------------------------------------------
// Ghostty integration — try @grove/libghostty first, fall back to ghostty-opentui
// ---------------------------------------------------------------------------

let ghosttyRegistered = false;
/** True when @grove/libghostty is available (persistent terminal support). */
let libghosttyAvailable = false;

/**
 * Try to load and register the terminal renderable.
 * Priority: @grove/libghostty → ghostty-opentui → plain text fallback.
 */
const ghosttyPromise: Promise<boolean> = (async () => {
  const opentui = (await import("@opentui/react").catch(() => null)) as {
    extend?: (objects: Record<string, unknown>) => void;
  } | null;
  if (!opentui?.extend) return false;

  // Try @grove/libghostty first (our own FFI bindings)
  try {
    const { GhosttyRenderable } = await import("@grove/libghostty/renderable");
    opentui.extend({ "ghostty-terminal": GhosttyRenderable as unknown });
    ghosttyRegistered = true;
    libghosttyAvailable = true;
    return true;
  } catch {
    // @grove/libghostty not available — try ghostty-opentui fallback
  }

  // Fallback: ghostty-opentui (third-party wrapper)
  try {
    const mod = (await import("ghostty-opentui/opentui")) as {
      GhosttyTerminalRenderable?: unknown;
    };
    if (mod.GhosttyTerminalRenderable) {
      opentui.extend({ "ghostty-terminal": mod.GhosttyTerminalRenderable });
      ghosttyRegistered = true;
      return true;
    }
  } catch {
    // Neither available — fall back to plain text
  }

  return false;
})();

/** Hook that resolves the ghostty module once and caches the result. */
function useGhosttyAvailable(): boolean {
  const [available, setAvailable] = useState(ghosttyRegistered);
  useEffect(() => {
    if (ghosttyRegistered) {
      setAvailable(true);
      return;
    }
    let cancelled = false;
    ghosttyPromise.then((ok) => {
      if (!cancelled && ok) {
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
// Persistent terminal state per agent
// ---------------------------------------------------------------------------

/**
 * Tracks per-agent terminal state for delta-based feeding.
 * When @grove/libghostty is available, we track how many bytes we've
 * already fed and only send the new portion on each poll.
 */
interface AgentTerminalState {
  /** Number of bytes previously fed to the terminal. */
  prevLength: number;
  /** Full previous capture content for prefix comparison. */
  prevContent: string;
}

/** Global map of agent session → terminal state. */
const agentStates = new Map<string, AgentTerminalState>();

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

    // Track the renderable ref for persistent feeding
    const renderableRef = useRef<{
      feed?: (data: string | Uint8Array) => void;
      reset?: () => void;
    } | null>(null);

    const fetcher = useCallback(async () => {
      if (!tmux || !sessionName) return "";
      return tmux.capturePanes(sessionName);
    }, [tmux, sessionName]);

    const { data: output } = usePolledData<string>(
      fetcher,
      captureMs,
      active && !!sessionName && !!tmux,
    );

    // When session changes, reset persistent state
    useEffect(() => {
      if (sessionName) {
        agentStates.delete(sessionName);
        renderableRef.current?.reset?.();
      }
    }, [sessionName]);

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

    // Status header — shared by all rendering paths
    const header = (
      <box>
        <text color={theme.muted}>
          session: {sessionName}
          {isInputMode ? (
            <text color={theme.focus}> [INPUT]</text>
          ) : (
            <text opacity={0.5}> (press i to type)</text>
          )}
        </text>
      </box>
    );

    // --- Ghostty path: ANSI/VT rendering ---
    if (ghosttyAvailable && rawOutput.length > 0) {
      // Determine rendering mode when @grove/libghostty is available
      let useDelta = false;
      let deltaContent = rawOutput;

      if (libghosttyAvailable && sessionName) {
        const state = agentStates.get(sessionName);
        if (state) {
          if (rawOutput.length > state.prevLength && rawOutput.startsWith(state.prevContent)) {
            // Output grew and prefix matches — safe to feed only delta
            useDelta = true;
            deltaContent = rawOutput.slice(state.prevLength);
          }
          // Otherwise output shrank, changed, or screen cleared —
          // fall back to full re-parse (ansi prop, not delta)
        }
        agentStates.set(sessionName, {
          prevLength: rawOutput.length,
          prevContent: rawOutput,
        });
      }

      return (
        <box flexDirection="column">
          {header}
          {createElement("ghostty-terminal" as string, {
            // delta = persistent (append only), ansi = stateless (full re-parse)
            ...(libghosttyAvailable && useDelta ? { delta: deltaContent } : { ansi: rawOutput }),
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
