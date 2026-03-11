/**
 * Polling hook for real-time TUI data refresh.
 *
 * Fetches data on mount, then polls at a configurable interval.
 * Preserves last-known-good data on fetch errors.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Result of the usePolledData hook. */
export interface PolledDataResult<T> {
  /** The most recent successfully fetched data, or null before first fetch. */
  readonly data: T | null;
  /** True during the initial fetch (before any data is available). */
  readonly loading: boolean;
  /** The most recent error, or null if the last fetch succeeded. */
  readonly error: Error | null;
  /** Trigger an immediate refresh, resetting the poll interval. */
  readonly refresh: () => void;
}

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
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (mountedRef.current) {
        setData(result);
        setError(null);
        setLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
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

  return { data, loading, error, refresh };
}
