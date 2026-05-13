/**
 * useNowTicker — re-renders the caller every `intervalMs` so time-derived
 * state (e.g. claim lease expiry → blocked status) stays accurate even when
 * no data event fires.
 *
 * Default 5s cadence balances freshness against re-render churn: claim
 * leases are heartbeat-renewed on the minute scale, so 5s latency on the
 * running→blocked transition is acceptable, and 12 idle re-renders per
 * minute is cheap in a terminal UI.
 *
 * Implementation delegates to `src/local/use-interval.ts` — the CI
 * acceptance grep forbids literal timer-spawn calls inside `src/tui/`,
 * and that helper is the single approved seam for periodic timers.
 */

import { useState } from "react";
import { useInterval } from "../../local/use-interval.js";

export function useNowTicker(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), intervalMs);
  return now;
}
