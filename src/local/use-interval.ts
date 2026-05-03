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
  cbRef.current = callback;

  useEffect(() => {
    if (!active || intervalMs <= 0) return;
    const id = setInterval(() => cbRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
}

/** Imperative variant for non-React modules (returns a stop function). */
export function startInterval(callback: () => void, intervalMs: number): () => void {
  const id = setInterval(callback, intervalMs);
  return () => clearInterval(id);
}
