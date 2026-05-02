/**
 * useEntity — reactive single-record subscription over the informer cache.
 *
 * Subscribes to the named kind, but the handler ignores events whose
 * entity id ≠ id, avoiding re-render churn for unrelated changes.
 */

import { useEffect, useState } from "react";
import type { Informer } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useInformerOptional } from "./informer-context.js";

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
  const informer = useInformerOptional(kind);
  const [data, setData] = useState<EntityFor<K> | undefined>(
    () => selectEntityById(informer, id) as EntityFor<K> | undefined,
  );
  const [hasSynced, setHasSynced] = useState<boolean>(informer.hasSynced());

  useEffect(() => {
    if (id === undefined) {
      setData(undefined);
      return;
    }
    setData(selectEntityById(informer, id) as EntityFor<K> | undefined);
    const unsubEvent = informer.addEventHandler((_op, entity) => {
      if (entity.id !== id) return;
      setData(selectEntityById(informer, id) as EntityFor<K> | undefined);
      if (!hasSynced && informer.hasSynced()) setHasSynced(true);
    });
    // Subscribe to RELIST_END so empty/unchanged snapshots still flip
    // hasSynced and refresh data, even when no per-entity event fires.
    const unsubSync = informer.addSyncHandler(() => {
      setData(selectEntityById(informer, id) as EntityFor<K> | undefined);
      if (!hasSynced && informer.hasSynced()) setHasSynced(true);
    });
    return () => {
      unsubEvent();
      unsubSync();
    };
  }, [informer, id, hasSynced]);

  return { data, hasSynced };
}
