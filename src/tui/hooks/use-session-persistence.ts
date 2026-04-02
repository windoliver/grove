/**
 * Session state persistence — saves and restores TUI layout state.
 *
 * Persists to `.grove/.sessions/<sessionId>-tui-state.json`:
 * - Panel focus (which panel is selected)
 * - Zoom level (normal/half/full)
 * - Expanded panel (which panel is expanded, or null)
 * - Selected agent index in trace view
 *
 * On restart/resume, restores layout so the user picks up where they left off.
 *
 * Also maintains the legacy `.grove/tui-state.json` write for backward compat.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ZoomLevel } from "../panels/panel-registry.js";
import type { RunningPanel } from "../screens/running-keyboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-session TUI view state that is persisted and restored on resume. */
export interface TuiViewState {
  /** Which panel is currently focused/expanded, or null for feed-only. */
  readonly expandedPanel?: RunningPanel | null | undefined;
  /** Zoom level of the expanded panel. */
  readonly zoomLevel?: ZoomLevel | undefined;
  /** Index of the selected agent in the trace view. */
  readonly traceSelectedAgent?: number | undefined;
  /** Index of the focused panel in the panel-manager (advanced mode). */
  readonly focusedPanel?: number | undefined;
}

/** Persisted TUI session state (legacy + new combined). */
export interface PersistedTuiState {
  readonly zoomLevel?: ZoomLevel | undefined;
  readonly focusedPanel?: number | undefined;
  readonly visibleOperatorPanels?: readonly number[] | undefined;
  readonly searchQuery?: string | undefined;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LEGACY_TUI_STATE_PATH = ".grove/tui-state.json";

function sessionStatePath(groveDir: string, sessionId: string): string {
  const { join } = require("node:path") as typeof import("node:path");
  return join(groveDir, ".sessions", `${sessionId}-tui-state.json`);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/** Read persisted TUI state from disk. */
async function readTuiState(): Promise<PersistedTuiState> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const path = resolve(process.cwd(), LEGACY_TUI_STATE_PATH);
    const json = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return {
      zoomLevel: typeof json.zoomLevel === "string" ? (json.zoomLevel as ZoomLevel) : undefined,
      focusedPanel: typeof json.focusedPanel === "number" ? json.focusedPanel : undefined,
      visibleOperatorPanels: Array.isArray(json.visibleOperatorPanels)
        ? (json.visibleOperatorPanels as number[])
        : undefined,
      searchQuery: typeof json.searchQuery === "string" ? json.searchQuery : undefined,
    };
  } catch {
    return {};
  }
}

/** Persist TUI state to disk (merges with existing state). */
async function writeTuiState(state: PersistedTuiState): Promise<void> {
  try {
    const { existsSync, writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const path = resolve(process.cwd(), LEGACY_TUI_STATE_PATH);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      // File doesn't exist yet
    }

    const merged = { ...existing, ...state };
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort persistence
  }
}

/** Read per-session TuiViewState from `.grove/.sessions/<id>-tui-state.json`. */
async function readViewState(groveDir: string, sessionId: string): Promise<TuiViewState | null> {
  try {
    const { readFileSync } = await import("node:fs");
    const path = sessionStatePath(groveDir, sessionId);
    const json = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return {
      expandedPanel:
        json.expandedPanel === null
          ? null
          : typeof json.expandedPanel === "number"
            ? (json.expandedPanel as RunningPanel)
            : undefined,
      zoomLevel: typeof json.zoomLevel === "string" ? (json.zoomLevel as ZoomLevel) : undefined,
      traceSelectedAgent:
        typeof json.traceSelectedAgent === "number" ? json.traceSelectedAgent : undefined,
      focusedPanel: typeof json.focusedPanel === "number" ? json.focusedPanel : undefined,
    };
  } catch {
    return null;
  }
}

/** Write per-session TuiViewState to disk (debounced by caller). */
function writeViewStateSync(groveDir: string, sessionId: string, state: TuiViewState): void {
  try {
    const { existsSync, writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const { join, dirname } = require("node:path") as typeof import("node:path");
    const path = join(groveDir, ".sessions", `${sessionId}-tui-state.json`);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// useTuiStatePersistence — per-session hook
// ---------------------------------------------------------------------------

/**
 * Hook to save and restore per-session TUI view state.
 *
 * - On mount: reads `.grove/.sessions/<sessionId>-tui-state.json` if it exists.
 * - On state changes: debounced write (500 ms) to the same file.
 *
 * Returns `{ savedState, saveState }`.
 *   - `savedState` is null until load completes (undefined means not yet loaded).
 *   - `saveState` debounces writes at 500 ms.
 */
export function useTuiStatePersistence(
  sessionId: string | undefined,
  groveDir: string | undefined,
): {
  /** Loaded state on resume, null if no prior state, undefined while loading. */
  savedState: TuiViewState | null | undefined;
  /** Persist new view state (debounced 500 ms). */
  saveState: (state: TuiViewState) => void;
} {
  const [savedState, setSavedState] = useState<TuiViewState | null | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Gate writes per session — reset on every sessionId/groveDir change
  const loadedRef = useRef(false);

  // Load on mount and whenever sessionId/groveDir change.
  // Reset load gate so writes are blocked until the new session's state is read.
  useEffect(() => {
    loadedRef.current = false;
    setSavedState(undefined); // mark as loading
    if (!sessionId || !groveDir) {
      setSavedState(null);
      return;
    }
    let cancelled = false;
    readViewState(groveDir, sessionId).then((state) => {
      if (!cancelled) {
        setSavedState(state);
        loadedRef.current = true;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, groveDir]);

  const saveState = useCallback(
    (state: TuiViewState) => {
      if (!sessionId || !groveDir) return;
      if (!loadedRef.current) return; // block writes until restore finishes
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        writeViewStateSync(groveDir, sessionId, state);
      }, 500);
    },
    [sessionId, groveDir],
  );

  return { savedState, saveState };
}

// ---------------------------------------------------------------------------
// useSessionPersistence — legacy hook (unchanged public API)
// ---------------------------------------------------------------------------

/** Hook to manage TUI session state persistence. */
export function useSessionPersistence(): {
  /** Loaded persisted state (undefined until loaded). */
  persistedState: PersistedTuiState | undefined;
  /** Save current state to disk. */
  saveState: (state: PersistedTuiState) => void;
} {
  const [persistedState, setPersistedState] = useState<PersistedTuiState | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    readTuiState().then((state) => {
      if (!cancelled) setPersistedState(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveState = useCallback((state: PersistedTuiState) => {
    void writeTuiState(state);
  }, []);

  return { persistedState, saveState };
}
