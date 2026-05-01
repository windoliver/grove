/**
 * InformerProvider — supplies an InformerFactory to React subscribers.
 *
 * PR1 (#387) ships dark: the provider mounts but does NOT call startAll().
 * Eager-start runs the watch loop (HTTP/SSE for remote, hub subscribe for
 * local) which would surface backoff/error noise into the OpenTUI Console
 * panel without any consumer reading the cache. PR2 (#388) flips eager-start
 * on once the first view migrates to a hook — at that point the watch loop
 * is justified by a real subscriber. All hooks (useEntities, useEntity,
 * useDerived) still consume the factory through this context. Throws when
 * used outside the provider.
 */

import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { Informer, InformerFactory } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";

const InformerContext = createContext<InformerFactory | null>(null);
InformerContext.displayName = "InformerContext";

export interface InformerProviderProps {
  readonly value: InformerFactory;
  /**
   * When true, the provider eagerly starts all informers on mount and stops
   * them on unmount. Defaults to false in PR1 (dark ship). Set true once
   * any hook actually subscribes — PR2 will gate this on env or per-call.
   */
  readonly eager?: boolean | undefined;
  readonly children: ReactNode;
}

export function InformerProvider(props: InformerProviderProps): ReactNode {
  const { value, eager = false, children } = props;
  useEffect(() => {
    if (!eager) return;
    value.startAll();
    return () => {
      void value.stopAll();
    };
  }, [value, eager]);
  return <InformerContext.Provider value={value}>{children}</InformerContext.Provider>;
}

export function useInformerFactory(): InformerFactory {
  const factory = useContext(InformerContext);
  if (!factory) {
    throw new Error("useInformer*: must be called inside <InformerProvider>");
  }
  return factory;
}

export function useInformer<K extends WatchKind>(kind: K): Informer<K> {
  return useInformerFactory().informerFor(kind);
}
