/**
 * Session state persistence — saves and restores TUI layout state.
 *
 * Persists to `.grove/.sessions/<sessionId>-tui-state.json`:
 * - Panel focus (which panel is selected)
 * - Zoom level (normal/half/full)
 * - Visible operator panels
 * - Search query
 *
 * On restart/resume, restores layout so the user picks up where they left off.
 *
 * Writes are atomic (temp-file → rename) to prevent corruption on crash.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  /** Index of the focused panel in the panel-manager (inspect overlay). */
  readonly focusedPanel?: number | undefined;
  /** Visible operator panel IDs (for grid layout restore). */
  readonly visibleOperatorPanels?: readonly number[] | undefined;
  /** Active search query (restored on resume). */
  readonly searchQuery?: string | undefined;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve the per-session state file path. */
export function sessionStatePath(groveDir: string, sessionId: string): string {
  return join(groveDir, ".sessions", `${sessionId}-tui-state.json`);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/**
 * Atomically write `content` to `filePath` using temp-file → rename.
 *
 * On POSIX filesystems, `rename` is atomic — the original file is never
 * partially overwritten, so a crash mid-write cannot corrupt the state file.
 */
export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}

/** Read per-session TuiViewState from disk. Returns null if not found. */
export async function readViewState(
  groveDir: string,
  sessionId: string,
): Promise<TuiViewState | null> {
  try {
    const path = sessionStatePath(groveDir, sessionId);
    const raw = await readFile(path, "utf-8");
    const json = JSON.parse(raw) as Record<string, unknown>;
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
      visibleOperatorPanels: Array.isArray(json.visibleOperatorPanels)
        ? (json.visibleOperatorPanels as number[])
        : undefined,
      searchQuery: typeof json.searchQuery === "string" ? json.searchQuery : undefined,
    };
  } catch {
    return null;
  }
}

/** Write per-session TuiViewState to disk atomically. */
async function writeViewState(
  groveDir: string,
  sessionId: string,
  state: TuiViewState,
): Promise<void> {
  const path = sessionStatePath(groveDir, sessionId);
  await writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// useTuiStatePersistence — per-session hook
// ---------------------------------------------------------------------------

/**
 * Hook to save and restore per-session TUI view state.
 *
 * - On mount: reads `.grove/.sessions/<sessionId>-tui-state.json` if it exists.
 * - On state changes: debounced write (500 ms) using atomic temp→rename.
 *
 * Returns `{ savedState, saveState }`.
 *   - `savedState` is undefined while loading, null if no prior state.
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
      // Cancel any pending debounced write to avoid post-unmount I/O (Issue 15A)
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [sessionId, groveDir]);

  const saveState = useCallback(
    (state: TuiViewState) => {
      if (!sessionId || !groveDir) return;
      if (!loadedRef.current) return; // block writes until restore completes
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void writeViewState(groveDir, sessionId, state);
      }, 500);
    },
    [sessionId, groveDir],
  );

  return { savedState, saveState };
}
