/**
 * useEntities — reactive filtered list view over the informer cache.
 *
 * Subscribes to the named kind's informer once per consumer; recomputes
 * the filtered list on every event; commits a new array reference only
 * when the filtered slice actually changed (shallow equality).
 *
 * Pure helpers below are exported for unit tests; the React hook is a
 * thin wrapper around them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useInformer, useInformerFactory } from "./informer-context.js";

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
  const informer = useInformer(kind);
  const factory = useInformerFactory();
  const predicateRef = useRef(predicate);

  const initial = useMemo<readonly EntityFor<K>[]>(() => {
    try {
      return computeFilteredEntities(
        informer.list() as readonly EntityFor<K>[],
        predicateRef.current,
      );
    } catch {
      return [];
    }
  }, [informer]);

  const [data, setData] = useState<readonly EntityFor<K>[]>(initial);
  const [hasSynced, setHasSynced] = useState<boolean>(informer.hasSynced());
  // Stream errors come from the factory's error listener — owned by the
  // watch lifecycle (4xx, listFn throw, etc). Cleared only when the factory
  // fires `null` (proven recovery: first RELIST_END after restart).
  const [streamError, setStreamError] = useState<Error | null>(() => factory.getLastError(kind));
  // Compute errors come from the predicate function throwing during a
  // recompute. Cleared on the next successful recompute. Kept separate so
  // recompute-after-stale-sync can't erase a stream error owned by the
  // watch lifecycle.
  const [computeError, setComputeError] = useState<Error | null>(null);
  const dataRef = useRef<readonly EntityFor<K>[]>(initial);
  dataRef.current = data;

  // Stable recompute via ref so the effect's dependency list stays tight —
  // closure captures latest informer + predicate via ref, so the effect
  // doesn't need to re-subscribe on every render to see fresh values.
  const recomputeRef = useRef<() => void>(() => {});
  recomputeRef.current = (): void => {
    try {
      const next = computeFilteredEntities(
        informer.list() as readonly EntityFor<K>[],
        predicateRef.current,
      );
      if (!shallowArraysEqual(dataRef.current, next)) {
        setData(next);
      }
      if (!hasSynced && informer.hasSynced()) setHasSynced(true);
      setComputeError((prev) => (prev === null ? prev : null));
    } catch (err) {
      setComputeError(err instanceof Error ? err : new Error(String(err)));
    }
  };
  const recompute = useCallback((): void => recomputeRef.current(), []);

  // Recompute synchronously when the predicate identity changes — without
  // this, callers who pass a fresh closure every render would see stale
  // filtered output until the next watch event arrived.
  if (predicateRef.current !== predicate) {
    predicateRef.current = predicate;
    try {
      const next = computeFilteredEntities(informer.list() as readonly EntityFor<K>[], predicate);
      if (!shallowArraysEqual(dataRef.current, next)) {
        // Defer to a microtask so the setState happens after this render
        // completes — React forbids setState during render of the same
        // component but allows it before commit.
        queueMicrotask(() => setData(next));
      }
    } catch (err) {
      queueMicrotask(() => setComputeError(err instanceof Error ? err : new Error(String(err))));
    }
  }

  useEffect(() => {
    const unsubEvent = informer.addEventHandler(recompute);
    // Subscribe to RELIST_END so empty/unchanged snapshots still flip
    // hasSynced and trigger a recompute. Without this, a consumer mounted
    // before the first sync of an empty store stays hasSynced=false.
    const unsubSync = informer.addSyncHandler(recompute);
    // Surface terminal informer.run() failures (remote 4xx, listFn throw)
    // so consumers don't sit at hasSynced=false with no diagnostic.
    const unsubError = factory.addErrorListener((errKind, err) => {
      if (errKind !== kind) return;
      setStreamError(err);
    });
    // Re-read after subscribing to close BOTH directions of the gap between
    // render-time initialization and effect-time subscription: an error
    // appearing OR being cleared in that window would otherwise be lost,
    // since addErrorListener only delivers future events. Set
    // unconditionally to reconcile both error-appears and error-clears.
    setStreamError(factory.getLastError(kind));
    return () => {
      unsubEvent();
      unsubSync();
      unsubError();
    };
  }, [informer, factory, kind, recompute]);

  // Stream errors take precedence — they signal the watch lifecycle is
  // unhealthy, which is more actionable than a transient predicate failure.
  return { data, hasSynced, error: streamError ?? computeError };
}
