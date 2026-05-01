/**
 * useDerived — reactive projection over one or more informers.
 *
 * Subscribes to every listed kind; recomputes `compute()` on any event
 * from any of them; commits a new state only when the output changed
 * (Object.is by default, caller-provided `equals` for non-trivial
 * shapes). Exceptions in `compute` set `error`; last-good `data`
 * is preserved.
 */

import { useEffect, useRef, useState } from "react";
import type { WatchKind } from "../../core/watch-events.js";
import { useInformerFactory } from "./informer-context.js";

export interface DerivedState<T> {
  readonly data: T | undefined;
  readonly error: Error | null;
}

export interface DerivedStep<T> extends DerivedState<T> {
  readonly committed: boolean;
}

export function stepDerived<T>(
  prev: DerivedState<T>,
  compute: () => T,
  equals: (a: T, b: T) => boolean = Object.is,
): DerivedStep<T> {
  try {
    const next = compute();
    if (prev.data !== undefined && equals(prev.data, next)) {
      if (prev.error === null) {
        return { data: prev.data, error: null, committed: false };
      }
      return { data: prev.data, error: null, committed: true };
    }
    return { data: next, error: null, committed: true };
  } catch (err) {
    return {
      data: prev.data,
      error: err instanceof Error ? err : new Error(String(err)),
      committed: true,
    };
  }
}

export interface UseDerivedResult<T> {
  readonly data: T | undefined;
  readonly hasSynced: boolean;
  readonly error: Error | null;
}

export function useDerived<T>(
  compute: () => T,
  kinds: readonly WatchKind[],
  equals: (a: T, b: T) => boolean = Object.is,
): UseDerivedResult<T> {
  const factory = useInformerFactory();
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const equalsRef = useRef(equals);
  equalsRef.current = equals;

  const [state, setState] = useState<DerivedState<T>>(() =>
    stepDerived<T>({ data: undefined, error: null }, () => computeRef.current()),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const informers = kinds.map((k) => factory.informerFor(k));
  const [hasSynced, setHasSynced] = useState<boolean>(() => informers.every((i) => i.hasSynced()));
  // First non-null factory error across all watched kinds; mirrors useEntities'
  // separation so a recompute can't mask a terminal stream failure.
  const [streamError, setStreamError] = useState<Error | null>(() => {
    for (const k of kinds) {
      const e = factory.getLastError(k);
      if (e) return e;
    }
    return null;
  });

  const kindsKey = kinds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: kinds compared by joined string identity
  useEffect(() => {
    const tick = (): void => {
      const next = stepDerived<T>(stateRef.current, () => computeRef.current(), equalsRef.current);
      if (next.committed) setState({ data: next.data, error: next.error });
      if (!hasSynced && informers.every((i) => i.hasSynced())) setHasSynced(true);
    };
    // Subscribe to per-entity events AND RELIST_END so empty/unchanged
    // snapshots still flip hasSynced when every kind has synced.
    const unsubs: Array<() => void> = [];
    for (const i of informers) {
      unsubs.push(i.addEventHandler(tick));
      unsubs.push(i.addSyncHandler(tick));
    }
    // Stream error subscription: surface terminal informer.run() failures
    // for any of the watched kinds. Resolved (null) when the kind hits its
    // first RELIST_END after restart — see InformerFactory.startOne.
    const watched = new Set<WatchKind>(kinds);
    unsubs.push(
      factory.addErrorListener((kind, err) => {
        if (!watched.has(kind)) return;
        if (err) {
          setStreamError(err);
          return;
        }
        // Recovery for one kind — only clear if no other watched kind is
        // still in error; otherwise show whichever one is still failing.
        for (const k of kinds) {
          const remaining = factory.getLastError(k);
          if (remaining) {
            setStreamError(remaining);
            return;
          }
        }
        setStreamError(null);
      }),
    );
    // Re-read after subscribing to close the gap between render-time
    // initialization and effect-time subscription: an error fired in that
    // window would otherwise be lost since addErrorListener only delivers
    // future events. This reconciliation is safe — getLastError reflects
    // the durable state, and setStreamError dedups identical values.
    for (const k of kinds) {
      const e = factory.getLastError(k);
      if (e) {
        setStreamError(e);
        break;
      }
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [factory, kindsKey, hasSynced]);

  // Stream errors take precedence over compute errors — the watch lifecycle
  // is the more actionable signal.
  return { data: state.data, hasSynced, error: streamError ?? state.error };
}
