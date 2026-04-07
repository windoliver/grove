/**
 * usePanelState — discriminated union wrapper over usePolledData.
 *
 * Forces exhaustive state handling at every call site, eliminating the
 * per-panel copy of `if (loading && !data) / if (error && !data)` ladders.
 *
 * State machine (matches pollReducer invariants):
 *   loading  — initial fetch in progress, no data yet
 *   error    — initial fetch failed, no previous data to show
 *   ready    — data is available; isStale=true when last re-fetch failed
 */

import { type PolledDataResult, usePolledData } from "./use-polled-data.js";

/** Initial fetch in progress — no data is available yet. */
export interface LoadingState {
  readonly status: "loading";
}

/** Initial fetch failed with no prior data to fall back on. */
export interface ErrorState {
  readonly status: "error";
  readonly error: Error;
}

/**
 * Data is available. When isStale is true, the data is from a previous
 * successful fetch and the most recent re-fetch failed (error is set).
 */
export interface ReadyState<T> {
  readonly status: "ready";
  readonly data: T;
  readonly isStale: boolean;
  /** Non-null when the most recent fetch failed but stale data is shown. */
  readonly error: Error | null;
}

export type PanelState<T> = LoadingState | ErrorState | ReadyState<T>;

export interface UsePanelStateResult<T> {
  readonly state: PanelState<T>;
  readonly refresh: () => void;
}

/**
 * Map a PolledDataResult to a PanelState discriminated union.
 * Exported as a pure function for unit testing without React.
 */
export function mapPollResult<T>(
  result: Pick<PolledDataResult<T>, "data" | "loading" | "error" | "isStale">,
): PanelState<T> {
  if (result.loading && result.data === null) {
    return { status: "loading" };
  }
  if (result.error !== null && result.data === null) {
    return { status: "error", error: result.error };
  }
  // Invariant: data is non-null here.
  // (loading=true + data!=null) and (loading=false + data=null + error=null)
  // cannot occur given pollReducer's transitions.
  return {
    status: "ready",
    data: result.data as T,
    isStale: result.isStale,
    error: result.error,
  };
}

/**
 * Poll a data source and return a typed panel state union.
 *
 * @param fetcher    Async function that returns fresh data.
 * @param intervalMs Polling interval in milliseconds. Pass 0 to disable.
 * @param active     Set to false to pause polling for inactive panels.
 */
export function usePanelState<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  active = true,
): UsePanelStateResult<T> {
  const result = usePolledData<T>(fetcher, intervalMs, active);
  return {
    state: mapPollResult(result),
    refresh: result.refresh,
  };
}
