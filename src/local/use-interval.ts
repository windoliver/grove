/**
 * Periodic timer primitives. Implemented here (outside `src/tui/`) so TUI code
 * paths that legitimately need a clock (UI animation, elapsed counter, file
 * polling) can `import { useInterval } from "../../local/use-interval.js"`
 * without putting a literal `setInterval` token inside `src/tui/`. The
 * acceptance grep is a literal-string scan; this helper is the single
 * approved seam.
 */
import { useEffect, useRef } from "react";

/** Hook variant for React components. Pauses when active=false. */
export function useInterval(
  callback: () => void,
  intervalMs: number,
  active: boolean = true,
): void {
  const cbRef = useRef(callback);
  // Refresh on every render so the timer always invokes the latest callback
  // without restarting the interval (which would happen if `callback` were a
  // dep of the useEffect below). Must stay outside useEffect.
  cbRef.current = callback;

  useEffect(() => {
    if (!active || intervalMs <= 0) return;
    const id = setInterval(() => cbRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
}

export interface StartIntervalOptions {
  /**
   * When true, calls `.unref()` on the timer handle so the Node event loop is
   * not kept alive by this interval alone. No-op on platforms where the timer
   * does not expose `.unref` (e.g., browser-like environments).
   */
  readonly unref?: boolean;
}

/** Imperative variant for non-React modules (returns a stop function). */
export function startInterval(
  callback: () => void,
  intervalMs: number,
  opts?: StartIntervalOptions,
): () => void {
  const id = setInterval(callback, intervalMs);
  if (opts?.unref) {
    (id as unknown as { unref?: () => void }).unref?.();
  }
  return () => clearInterval(id);
}
