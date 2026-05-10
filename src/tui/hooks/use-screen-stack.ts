/**
 * useScreenStack — reactive hook over PagesStore.
 *
 * Subscribes to the store's "top" event channel via useSyncExternalStore;
 * exposes the current top page, stack depth, immutable snapshot, and
 * stable push/pop/replace action callbacks.
 */

import { useCallback, useSyncExternalStore } from "react";
import type { Page, PagesStore } from "../data/pages-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScreenStackValue {
  readonly top: Page | undefined;
  readonly depth: number;
  readonly snapshot: readonly Page[];
  readonly push: (page: Page) => void;
  readonly pop: () => Page | undefined;
  readonly replace: (page: Page) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useScreenStack(store: PagesStore): ScreenStackValue {
  // Subscribe to the "top" event so we re-render whenever the visible top
  // page changes (push, pop, replace all emit "top").
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe("top", () => onChange()),
    [store],
  );

  // getSnapshot returns the cached, version-stable array from the store.
  // The store guarantees identity stability between mutations (same reference
  // while nothing has changed), satisfying useSyncExternalStore requirements.
  const getSnapshot = useCallback(() => store.snapshot(), [store]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  // Derive top from the snapshot instead of calling store.top() separately;
  // this keeps the values consistent within the same render.
  const top = snapshot[snapshot.length - 1];
  const depth = snapshot.length;

  // Stable action callbacks bound to the store instance.
  const push = useCallback((page: Page) => store.push(page), [store]);
  const pop = useCallback(() => store.pop(), [store]);
  const replace = useCallback((page: Page) => store.replace(page), [store]);

  return { top, depth, snapshot, push, pop, replace };
}
