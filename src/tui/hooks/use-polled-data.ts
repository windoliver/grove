/**
 * Polling hook for real-time TUI data refresh.
 *
 * Fetches data on mount, then polls at a configurable interval.
 * Preserves last-known-good data on fetch errors.
 * Uses useReducer for atomic state updates (single re-render per poll).
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

/** Result of the usePolledData hook. */
export interface PolledDataResult<T> {
  /** The most recent successfully fetched data, or null before first fetch. */
  readonly data: T | null;
  /** True during the initial fetch (before any data is available). */
  readonly loading: boolean;
  /** The most recent error, or null if the last fetch succeeded. */
  readonly error: Error | null;
  /** Whether the displayed data is stale (error occurred but old data is shown). */
  readonly isStale: boolean;
  /** Timestamp (ms since epoch) of the last successful fetch, or null. */
  readonly lastSuccessAt: number | null;
  /** Trigger an immediate refresh, resetting the poll interval. */
  readonly refresh: () => void;
}

// ---------------------------------------------------------------------------
// Pure state logic (exported for testing)
// ---------------------------------------------------------------------------

/** Internal poll state — all fields updated atomically via reducer. */
export interface PollState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly lastSuccessAt: number | null;
}

export type PollAction<T> =
  | { readonly type: "success"; readonly data: T; readonly timestamp: number }
  | { readonly type: "error"; readonly error: Error }
  | { readonly type: "reset" };

/** Pure reducer for poll state. */
export function pollReducer<T>(state: PollState<T>, action: PollAction<T>): PollState<T> {
  switch (action.type) {
    case "success":
      return {
        data: action.data,
        loading: false,
        error: null,
        lastSuccessAt: action.timestamp,
      };
    case "error":
      return {
        ...state,
        loading: false,
        error: action.error,
        // data and lastSuccessAt are preserved (stale)
      };
    case "reset":
      return { data: null, loading: true, error: null, lastSuccessAt: null };
  }
}

/** Compute whether displayed data is stale. */
export function computeIsStale<T>(state: PollState<T>): boolean {
  return state.error !== null && state.data !== null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Poll a data source at regular intervals.
 *
 * - Fetches immediately on mount.
 * - On error, retains the last successful data and sets `error`.
 * - Cleans up on unmount (no state updates after unmount).
 * - Manual `refresh()` triggers an immediate fetch and resets the interval.
 *
 * @param fetcher - Async function that returns fresh data.
 * @param intervalMs - Polling interval in milliseconds. Pass 0 to disable.
 * @param active - Whether this hook should poll. Set to false for inactive views.
 */
export function usePolledData<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  active = true,
): PolledDataResult<T> {
  const initialState: PollState<T> = {
    data: null,
    loading: true,
    error: null,
    lastSuccessAt: null,
  };

  const [state, dispatch] = useReducer(pollReducer<T>, initialState);

  const mountedRef = useRef(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (mountedRef.current) {
        dispatch({ type: "success", data: result, timestamp: Date.now() });
      }
    } catch (err) {
      if (mountedRef.current) {
        dispatch({
          type: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }, []);

  const startPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
    }
    if (intervalMs > 0 && active) {
      intervalRef.current = setInterval(() => {
        void doFetch();
      }, intervalMs);
    }
  }, [intervalMs, active, doFetch]);

  // Initial fetch + start polling
  useEffect(() => {
    mountedRef.current = true;

    if (active) {
      void doFetch();
      startPolling();
    }

    return () => {
      mountedRef.current = false;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, doFetch, startPolling]);

  const refresh = useCallback(() => {
    void doFetch();
    startPolling();
  }, [doFetch, startPolling]);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    isStale: computeIsStale(state),
    lastSuccessAt: state.lastSuccessAt,
    refresh,
  };
}
