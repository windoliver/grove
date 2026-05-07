/**
 * useEntityData — collapses the dual-path (informer cache + polled
 * fallback) currently inlined in every list view. Both `useEntities`
 * and `useEventDrivenData` are always called to keep React's hook
 * order stable when `useEntityWatchEnabled` toggles.
 */

import { useCallback, useMemo } from "react";
import type { EntityForKind } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useEntityWatchEnabled } from "./informer-context.js";
import { useEntities } from "./use-entities.js";
import { useEventDrivenData } from "./use-event-driven-data.js";

export interface EntityShapeOpts<E> {
  readonly predicate?: (e: E) => boolean;
  readonly sort?: (a: E, b: E) => number;
  readonly offset?: number;
  readonly limit?: number;
}

/** Pure: predicate → sort → offset/limit. Exported for unit tests. */
export function applyEntityShape<E>(list: readonly E[], opts: EntityShapeOpts<E>): readonly E[] {
  let out: readonly E[] = list;
  if (opts.predicate) out = out.filter(opts.predicate);
  if (opts.sort) out = [...out].sort(opts.sort);
  const offset = opts.offset ?? 0;
  if (offset > 0 || opts.limit !== undefined) {
    const end = opts.limit !== undefined ? offset + opts.limit : undefined;
    out = out.slice(offset, end);
  }
  return out;
}

export interface UseEntityDataOpts<K extends WatchKind> extends EntityShapeOpts<EntityForKind<K>> {
  readonly fallbackFetcher?: () => Promise<readonly EntityForKind<K>[]>;
  readonly active: boolean;
}

export interface UseEntityDataResult<K extends WatchKind> {
  readonly data: readonly EntityForKind<K>[];
  readonly loading: boolean;
  readonly isStale: boolean;
  readonly error: Error | undefined;
}

export function useEntityData<K extends WatchKind>(
  provider: unknown,
  kind: K,
  opts: UseEntityDataOpts<K>,
): UseEntityDataResult<K> {
  const useInformerPath = useEntityWatchEnabled(provider, kind);

  // Both branches always evaluated: stable hook order across path flips.
  const entityResult = useEntities(kind, opts.predicate);

  const fetcher = useCallback(async () => {
    if (!opts.fallbackFetcher) return [] as readonly EntityForKind<K>[];
    return opts.fallbackFetcher();
  }, [opts.fallbackFetcher]);

  const polled = useEventDrivenData<readonly EntityForKind<K>[]>(
    fetcher,
    undefined,
    undefined,
    opts.active && !useInformerPath && !!opts.fallbackFetcher,
  );

  const data = useMemo<readonly EntityForKind<K>[]>(() => {
    if (useInformerPath) {
      // entityResult.data already had `predicate` applied inside useEntities.
      // Apply only sort + offset/limit here to avoid double-filtering.
      type MutableShapeOpts = {
        sort?: (a: EntityForKind<K>, b: EntityForKind<K>) => number;
        offset?: number;
        limit?: number;
      };
      const innerOpts: MutableShapeOpts = {};
      if (opts.sort) innerOpts.sort = opts.sort;
      if (opts.offset !== undefined) innerOpts.offset = opts.offset;
      if (opts.limit !== undefined) innerOpts.limit = opts.limit;
      return applyEntityShape(entityResult.data, innerOpts);
    }
    if (polled.data === null) return [];
    // Polled fallback: predicate was NOT applied by the hook — apply here.
    return applyEntityShape(polled.data, opts);
  }, [
    useInformerPath,
    entityResult.data,
    polled.data,
    opts.sort,
    opts.offset,
    opts.limit,
    opts.predicate,
  ]);

  return {
    data,
    loading: useInformerPath
      ? !entityResult.hasSynced && data.length === 0
      : polled.loading && polled.data === null,
    isStale: useInformerPath ? false : polled.isStale,
    error: useInformerPath ? (entityResult.error ?? undefined) : (polled.error ?? undefined),
  };
}
