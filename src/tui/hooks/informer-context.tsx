/**
 * InformerProvider — supplies an InformerFactory to React subscribers.
 *
 * Eager startAll() at provider mount, stopAll() on unmount. All hooks
 * (useEntities, useEntity, useDerived) consume the factory through this
 * context. Throws when used outside the provider.
 */

import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { Informer, InformerFactory } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";

const InformerContext = createContext<InformerFactory | null>(null);
InformerContext.displayName = "InformerContext";

export interface InformerProviderProps {
  readonly value: InformerFactory;
  readonly children: ReactNode;
}

export function InformerProvider(props: InformerProviderProps): ReactNode {
  const { value, children } = props;
  useEffect(() => {
    value.startAll();
    return () => {
      void value.stopAll();
    };
  }, [value]);
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
