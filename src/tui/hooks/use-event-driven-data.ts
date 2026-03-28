/**
 * Event-driven data hook for Nexus mode.
 *
 * Replaces usePolledData when EventBus is available:
 * 1. Fetches once on mount
 * 2. Subscribes to EventBus — re-fetches when events arrive
 *
 * NO polling. EventBus is the single source of truth.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { EventBus, EventHandler, GroveEvent } from "../../core/event-bus.js";

/** Result — same interface as usePolledData for drop-in replacement. */
export interface EventDrivenResult<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly isStale: boolean;
  readonly lastSuccessAt: number | null;
  readonly refresh: () => void;
}

interface State<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly lastSuccessAt: number | null;
}

type Action<T> =
  | { type: "success"; data: T; timestamp: number }
  | { type: "error"; error: Error }
  | { type: "reset" };

function reducer<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case "success":
      return { data: action.data, loading: false, error: null, lastSuccessAt: action.timestamp };
    case "error":
      return { ...state, loading: false, error: action.error };
    case "reset":
      return { data: null, loading: true, error: null, lastSuccessAt: null };
  }
}

/**
 * Hook that fetches data once, then re-fetches on EventBus events.
 * No polling — EventBus push is the only update trigger.
 *
 * @param fetcher — async function to get data
 * @param eventBus — EventBus to subscribe to (if undefined, no updates after initial fetch)
 * @param role — role to subscribe to (receives events targeted at this role)
 * @param active — whether to fetch at all
 */
export function useEventDrivenData<T>(
  fetcher: () => Promise<T>,
  eventBus: EventBus | undefined,
  role: string | undefined,
  active: boolean,
): EventDrivenResult<T> {
  const [state, dispatch] = useReducer(reducer<T>, {
    data: null,
    loading: true,
    error: null,
    lastSuccessAt: null,
  });

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(async () => {
    try {
      const data = await fetcherRef.current();
      dispatch({ type: "success", data, timestamp: Date.now() });
    } catch (err) {
      dispatch({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    if (!active) return;
    void doFetch();
  }, [active, doFetch]);

  // Subscribe to EventBus — re-fetch on any event for this role
  useEffect(() => {
    if (!active || !eventBus || !role) return;

    const handler: EventHandler = (_event: GroveEvent) => {
      void doFetch();
    };

    eventBus.subscribe(role, handler);
    // Also subscribe to "system" events (stop broadcasts)
    eventBus.subscribe("system", handler);

    return () => {
      eventBus.unsubscribe(role, handler);
      eventBus.unsubscribe("system", handler);
    };
  }, [active, eventBus, role, doFetch]);

  // No polling. EventBus is the single update path.

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    isStale: state.error !== null && state.data !== null,
    lastSuccessAt: state.lastSuccessAt,
    refresh: doFetch,
  };
}
