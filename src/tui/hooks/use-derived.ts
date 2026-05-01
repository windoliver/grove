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

  const kindsKey = kinds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: kinds compared by joined string identity
  useEffect(() => {
    const tick = (): void => {
      const next = stepDerived<T>(stateRef.current, () => computeRef.current(), equalsRef.current);
      if (next.committed) setState({ data: next.data, error: next.error });
      if (!hasSynced && informers.every((i) => i.hasSynced())) setHasSynced(true);
    };
    const unsubs = informers.map((i) => i.addEventHandler(tick));
    return () => {
      for (const u of unsubs) u();
    };
  }, [factory, kindsKey, hasSynced]);

  return { data: state.data, hasSynced, error: state.error };
}
