/**
 * useHints — React subscription to a PagesStore (#309).
 *
 * Subscribes to the `top` event channel via useSyncExternalStore and
 * returns a frozen KeyAction[] derived from the current top page via
 * hintsForPage(). Returns [] when the stack is empty.
 */

import { useSyncExternalStore } from "react";
import { hintsForPage, type KeyAction } from "../data/hint-map.js";
import type { PagesStore } from "../data/pages-store.js";

export function useHints(store: PagesStore): readonly KeyAction[] {
  const snapshot = useSyncExternalStore(
    (cb) => store.subscribe("top", () => cb()),
    () => store.snapshot(),
  );
  const top = snapshot[snapshot.length - 1];
  return top ? hintsForPage(top) : [];
}
