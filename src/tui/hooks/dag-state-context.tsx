/**
 * React context wrapper around DagStateStore (#311).
 *
 * The store is instantiated once in screen-manager and shared across
 * views via this provider — its UI state (collapsed cids, focus, highlight)
 * survives DagView mount/unmount across page switches.
 */

import React, { createContext, useContext, useSyncExternalStore } from "react";
import type { DagStateSnapshot, DagStateStore } from "../data/dag-state-store.js";

export const DagStateContext: React.Context<DagStateStore | null> =
  createContext<DagStateStore | null>(null);

export interface DagStateProviderProps {
  readonly store: DagStateStore;
  readonly children: React.ReactNode;
}

export const DagStateProvider: React.NamedExoticComponent<DagStateProviderProps> = React.memo(
  function DagStateProvider({ store, children }: DagStateProviderProps): React.ReactNode {
    return <DagStateContext.Provider value={store}>{children}</DagStateContext.Provider>;
  },
);

export interface UseDagStateResult {
  readonly store: DagStateStore;
  readonly snapshot: DagStateSnapshot;
}

export function useDagState(): UseDagStateResult {
  const store = useContext(DagStateContext);
  if (!store) {
    throw new Error("useDagState must be called inside a <DagStateProvider>");
  }
  const snapshot = useSyncExternalStore(
    (cb) => store.subscribe("change", () => cb()),
    () => store.snapshot(),
    () => store.snapshot(),
  );
  return { store, snapshot };
}
