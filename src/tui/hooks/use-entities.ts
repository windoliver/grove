/**
 * useEntities — reactive filtered list view over the EntityStore (B1 #296).
 *
 * Subscribes to the named kind's EntityStore once per consumer via
 * useSyncExternalStore; recomputes the filtered list on every version
 * bump; commits a new array reference only when the filtered slice
 * actually changed (shallow equality).
 *
 * Pure helpers (`shallowArraysEqual`, `computeFilteredEntities`) are
 * exported for unit tests and selector tests.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useEntityStoreOptional } from "./entity-store-context.js";
import { useInformerFactoryOptional } from "./informer-context.js";

export function shallowArraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

export function computeFilteredEntities<E>(
  list: readonly E[],
  predicate: ((e: E) => boolean) | undefined,
): readonly E[] {
  if (!predicate) return list;
  return list.filter(predicate);
}

export interface UseEntitiesResult<E> {
  readonly data: readonly E[];
  readonly hasSynced: boolean;
  readonly error: Error | null;
}

type EntityFor<K extends WatchKind> = ReturnType<Informer<K>["list"]>[number];

export function useEntities<K extends WatchKind>(
  kind: K,
  predicate?: (e: EntityFor<K>) => boolean,
): UseEntitiesResult<EntityFor<K>> {
  const store = useEntityStoreOptional(kind);
  const factory = useInformerFactoryOptional();
  const predicateRef = useRef(predicate);

  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  const getVersion = useCallback(() => store.getVersion(), [store]);
  // The version return value is unused — uSES exists only to register the
  // subscription and re-render on each store version bump.
  useSyncExternalStore(subscribe, getVersion);

  const dataRef = useRef<readonly EntityFor<K>[] | null>(null);
  const [computeError, setComputeError] = useState<Error | null>(null);

  // Compute the current filtered slice from the version-stable snapshot.
  let nextData: readonly EntityFor<K>[] | null;
  try {
    nextData = computeFilteredEntities(
      store.list() as readonly EntityFor<K>[],
      predicateRef.current,
    );
    if (computeError !== null) {
      setComputeError(null);
    }
  } catch (err) {
    nextData = null;
    const e = err instanceof Error ? err : new Error(String(err));
    if (computeError === null || computeError.message !== e.message) {
      setComputeError(e);
    }
  }

  let data: readonly EntityFor<K>[];
  if (nextData === null) {
    data = dataRef.current ?? ([] as readonly EntityFor<K>[]);
  } else if (dataRef.current && shallowArraysEqual(dataRef.current, nextData)) {
    data = dataRef.current;
  } else {
    dataRef.current = nextData;
    data = nextData;
  }

  // Predicate-identity change → recompute synchronously without waiting
  // for the next watch event. Keep the same shallow-equal short-circuit
  // so a no-op predicate change doesn't churn the data ref.
  if (predicateRef.current !== predicate) {
    predicateRef.current = predicate;
    try {
      const fresh = computeFilteredEntities(store.list() as readonly EntityFor<K>[], predicate);
      if (!dataRef.current || !shallowArraysEqual(dataRef.current, fresh)) {
        dataRef.current = fresh;
        data = fresh;
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (computeError === null || computeError.message !== e.message) {
        setComputeError(e);
      }
    }
  }

  // Stream errors come from the InformerFactory's error listener — owned
  // by the watch lifecycle, kept separate from compute errors.
  const [streamError, setStreamError] = useState<Error | null>(() =>
    factory ? factory.getLastError(kind) : null,
  );
  useEffect(() => {
    if (!factory) return;
    const unsub = factory.addErrorListener((errKind, err) => {
      if (errKind !== kind) return;
      setStreamError(err);
    });
    setStreamError(factory.getLastError(kind));
    return unsub;
  }, [factory, kind]);

  return {
    data,
    hasSynced: store.hasSynced(),
    error: streamError ?? computeError,
  };
}
