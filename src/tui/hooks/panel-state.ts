/**
 * PanelState — discriminated union over the data-hook result, kept as a pure
 * mapper so callers force exhaustive state handling at every site (eliminates
 * the per-panel `if (loading && !data) / if (error && !data)` ladders).
 *
 * Lives on after the legacy `usePanelState` deletion (A8.5 #391): callers wrap
 * `useEventDrivenData(...)` with `mapPollResult(...)` to get the same union.
 *
 * State machine matches the underlying `useEventDrivenData` invariants:
 *   loading  — initial fetch in progress, no data yet
 *   error    — initial fetch failed, no previous data to show
 *   ready    — data is available; isStale=true when the most recent re-fetch failed
 */

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

/**
 * Map a polled / event-driven result to a PanelState discriminated union.
 *
 * Pure function — exported for unit testing without React.
 */
export function mapPollResult<T>(result: {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly isStale: boolean;
}): PanelState<T> {
  if (result.loading && result.data === null) {
    return { status: "loading" };
  }
  if (result.error !== null && result.data === null) {
    return { status: "error", error: result.error };
  }
  return {
    status: "ready",
    data: result.data as T,
    isStale: result.isStale,
    error: result.error,
  };
}
