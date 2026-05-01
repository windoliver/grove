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

import { useEffect, useMemo, useRef, useState } from "react";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useInformer } from "./informer-context.js";

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
  const predicateRef = useRef(predicate);
  predicateRef.current = predicate;

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
  const [error, setError] = useState<Error | null>(null);
  const dataRef = useRef<readonly EntityFor<K>[]>(initial);
  dataRef.current = data;

  useEffect(() => {
    const unsub = informer.addEventHandler(() => {
      try {
        const next = computeFilteredEntities(
          informer.list() as readonly EntityFor<K>[],
          predicateRef.current,
        );
        if (!shallowArraysEqual(dataRef.current, next)) {
          setData(next);
        }
        if (!hasSynced && informer.hasSynced()) setHasSynced(true);
        if (error) setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return unsub;
  }, [informer, hasSynced, error]);

  return { data, hasSynced, error };
}
