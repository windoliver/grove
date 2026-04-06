/**
 * Shared refresh signal for manual refresh (r-key) to reach panel-level pollers.
 *
 * App increments the signal counter each time the operator triggers refresh.
 * Panel views subscribe with useRefreshSignal(refresh) and re-fetch immediately
 * when the signal changes — without requiring prop-drilling into every panel.
 */

import { createContext, useContext, useEffect, useRef } from "react";

export interface RefreshSignalContext {
  readonly signal: number;
}

export const RefreshContext = createContext<RefreshSignalContext>({ signal: 0 });

/**
 * Subscribe a panel's usePolledData refresh() to the global refresh signal.
 *
 * Call this in any panel view that has its own usePolledData and should respond
 * to the operator's manual refresh (r-key / custom refresh keybinding).
 *
 * @example
 *   const { data, refresh } = usePolledData(fetcher, intervalMs, active);
 *   useRefreshSignal(refresh);
 */
export function useRefreshSignal(onRefresh: () => void): void {
  const { signal } = useContext(RefreshContext);
  const lastSignal = useRef(0);
  useEffect(() => {
    if (signal > 0 && signal !== lastSignal.current) {
      lastSignal.current = signal;
      onRefresh();
    }
  }, [signal, onRefresh]);
}
