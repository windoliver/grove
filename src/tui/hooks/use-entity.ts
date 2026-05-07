/**
 * useEntity — reactive single-record subscription over the EntityStore (B1 #296).
 *
 * Subscribes to the named kind via useSyncExternalStore so React re-renders
 * on every store version bump; reads the entity via store.getById(id) and
 * suppresses no-op updates with Object.is. The store's microtask coalescer
 * means N writes within one microtask trigger one notify.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useEntityStoreOptional } from "./entity-store-context.js";

export function selectEntityById<I extends Informer>(
  informer: I,
  id: string | undefined,
): ReturnType<I["getById"]> | undefined {
  if (id === undefined) return undefined;
  return informer.getById(id) as ReturnType<I["getById"]>;
}

export interface UseEntityResult<E> {
  readonly data: E | undefined;
  readonly hasSynced: boolean;
}

type EntityFor<K extends WatchKind> = NonNullable<ReturnType<Informer<K>["getById"]>>;

export function useEntity<K extends WatchKind>(
  kind: K,
  id: string | undefined,
): UseEntityResult<EntityFor<K>> {
  const store = useEntityStoreOptional(kind);
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  const getVersion = useCallback(() => store.getVersion(), [store]);
  // Version return is unused — the call exists only to register a
  // subscription and trigger re-render on each bump.
  useSyncExternalStore(subscribe, getVersion);

  // Stable ref so an unchanged entity (same identity per Informer's frozen
  // refs) doesn't churn the returned object.
  const dataRef = useRef<EntityFor<K> | undefined>(undefined);
  const next = id === undefined ? undefined : (store.getById(id) as EntityFor<K> | undefined);
  if (!Object.is(dataRef.current, next)) {
    dataRef.current = next;
  }

  return { data: dataRef.current, hasSynced: store.hasSynced() };
}
