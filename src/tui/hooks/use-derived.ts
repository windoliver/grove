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
import { useInformerFactoryOptional } from "./informer-context.js";

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
  // Mirror useEntities: graceful when no <InformerProvider> is mounted (the
  // pre-factory window in interactive mode, or backends that never wire one)
  // so the dual-path callers can `useDerived` unconditionally without
  // breaking Rules of Hooks.
  const factory = useInformerFactoryOptional();
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const equalsRef = useRef(equals);
  equalsRef.current = equals;

  const [state, setState] = useState<DerivedState<T>>(() =>
    stepDerived<T>({ data: undefined, error: null }, () => computeRef.current()),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const informers = factory ? kinds.map((k) => factory.informerFor(k)) : [];
  const [hasSynced, setHasSynced] = useState<boolean>(() =>
    factory ? informers.every((i) => i.hasSynced()) : false,
  );
  const [streamError, setStreamError] = useState<Error | null>(() => {
    if (!factory) return null;
    for (const k of kinds) {
      const e = factory.getLastError(k);
      if (e) return e;
    }
    return null;
  });

  const kindsKey = kinds.join(",");
  // Source-token reset (React pattern: setState during render with tracked
  // refs). Without this, the render that runs IMMEDIATELY after a factory
  // or kinds change still exposes the prior source's `state.data` and
  // `hasSynced` until the effect runs post-commit. Dual-path callers that
  // gate on `hasSynced && !error` would briefly treat factory-A data as
  // ready under factory-B's tenant/namespace — a stale leak.
  //
  // We must compare factory by IDENTITY, not truthiness: a hot swap from
  // factory A → factory B (both non-null, same kinds) leaves a truthiness
  // key unchanged and the reset would be skipped, preserving A's data
  // under B's provider.
  const prevFactoryRef = useRef(factory);
  const prevKindsKeyRef = useRef(kindsKey);
  if (prevFactoryRef.current !== factory || prevKindsKeyRef.current !== kindsKey) {
    prevFactoryRef.current = factory;
    prevKindsKeyRef.current = kindsKey;
    setState({ data: undefined, error: null });
    setHasSynced(factory ? informers.every((i) => i.hasSynced()) : false);
    let firstErr: Error | null = null;
    if (factory) {
      for (const k of kinds) {
        const e = factory.getLastError(k);
        if (e) {
          firstErr = e;
          break;
        }
      }
    }
    setStreamError(firstErr);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: kinds compared by joined string identity; hasSynced read inside tick via setter callback
  useEffect(() => {
    if (!factory) {
      // Provider lost — reset readiness so dual-path callers fall back to
      // polled until a new factory mounts and produces a fresh sync.
      setHasSynced(false);
      setStreamError(null);
      return;
    }
    // Cancellation guard: informer event dispatch snapshots handlers before
    // invoking them, so an old `tick` can still fire after cleanup during a
    // factory/kinds swap. Without this, a stale callback would write
    // hasSynced/state through the shared refs and the new source could
    // appear synced (or unsynced) using the old informer set.
    let cancelled = false;
    const liveInformers = kinds.map((k) => factory.informerFor(k));
    // Reset readiness for the new factory/kinds. If the new source is already
    // synced (e.g. a hot-swapped factory that completed list before we
    // subscribed), reflect that immediately; otherwise wait for the first
    // sync notification on this subscription. Setting via setter is
    // idempotent when the value matches.
    setHasSynced(liveInformers.every((i) => i.hasSynced()));
    const tick = (): void => {
      if (cancelled) return;
      const next = stepDerived<T>(stateRef.current, () => computeRef.current(), equalsRef.current);
      if (next.committed) setState({ data: next.data, error: next.error });
      // Always recheck — setHasSynced is a no-op when the value matches, so
      // we can safely call on every tick. Avoids stale-closure bugs from
      // tracking hasSynced as an effect dep.
      const allSynced = liveInformers.every((i) => i.hasSynced());
      setHasSynced((prev) => (prev === allSynced ? prev : allSynced));
    };
    const unsubs: Array<() => void> = [];
    for (const i of liveInformers) {
      unsubs.push(i.addEventHandler(tick));
      unsubs.push(i.addSyncHandler(tick));
    }
    const watched = new Set<WatchKind>(kinds);
    unsubs.push(
      factory.addErrorListener((kind, err) => {
        if (cancelled || !watched.has(kind)) return;
        if (err) {
          setStreamError(err);
          return;
        }
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
    let firstErr: Error | null = null;
    for (const k of kinds) {
      const e = factory.getLastError(k);
      if (e) {
        firstErr = e;
        break;
      }
    }
    setStreamError(firstErr);
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [factory, kindsKey]);

  // Stream errors take precedence over compute errors — the watch lifecycle
  // is the more actionable signal.
  return { data: state.data, hasSynced, error: streamError ?? state.error };
}
