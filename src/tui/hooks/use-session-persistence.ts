/**
 * Session state persistence — saves and restores TUI layout state.
 *
 * Persists to `.grove/tui-state.json`:
 * - Last focused panel + visible operator panels
 * - Zoom level
 * - Search query
 * - Compare mode selection
 *
 * On restart, restores layout so the user picks up where they left off (item 13).
 */

import { useCallback, useEffect, useState } from "react";
import type { ZoomLevel } from "../panels/panel-manager.js";

/** Persisted TUI session state. */
export interface PersistedTuiState {
  readonly zoomLevel?: ZoomLevel | undefined;
  readonly focusedPanel?: number | undefined;
  readonly visibleOperatorPanels?: readonly number[] | undefined;
  readonly searchQuery?: string | undefined;
}

const TUI_STATE_PATH = ".grove/tui-state.json";

/** Read persisted TUI state from disk. */
async function readTuiState(): Promise<PersistedTuiState> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const path = resolve(process.cwd(), TUI_STATE_PATH);
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
    const path = resolve(process.cwd(), TUI_STATE_PATH);
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
