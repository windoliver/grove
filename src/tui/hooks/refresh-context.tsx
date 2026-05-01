/**
 * RefreshProvider — wires the global refresh trigger (r-key) to
 * factory.relist(). Replaces use-refresh-context.ts's numeric-signal
 * approach for informer-backed hooks. The old context stays in tree
 * during the migration; PR5 deletes it.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { InformerFactory } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import type { InformerHolder } from "./informer-context.js";

type RefreshFn = (kind?: WatchKind) => void;

const RefreshContext = createContext<RefreshFn | null>(null);
RefreshContext.displayName = "RefreshContext";

export interface RefreshProviderProps {
  readonly factory: InformerFactory;
  readonly children: ReactNode;
}

export function RefreshProvider(props: RefreshProviderProps): ReactNode {
  const { factory, children } = props;
  const refresh = useCallback<RefreshFn>(
    (kind) => {
      void factory.relist(kind);
    },
    [factory],
  );
  return <RefreshContext.Provider value={refresh}>{children}</RefreshContext.Provider>;
}

export function useRelistTrigger(): RefreshFn {
  const fn = useContext(RefreshContext);
  if (!fn) throw new Error("useRelistTrigger: must be inside <RefreshProvider>");
  return fn;
}

export interface RefreshProviderHolderProps {
  readonly holder: InformerHolder;
  readonly children: ReactNode;
}

/**
 * Holder variant for the interactive TUI flow — same async-arrival
 * semantics as `<InformerProviderHolder>` (children render bare until the
 * factory is set; once set, `<RefreshProvider>` mounts).
 */
export function RefreshProviderHolder(props: RefreshProviderHolderProps): ReactNode {
  const { holder, children } = props;
  const [factory, setFactory] = useState<InformerFactory | null>(() => holder.current());
  const lastSeen = useRef(factory);
  lastSeen.current = factory;
  const sync = useCallback(() => {
    const next = holder.current();
    if (next !== lastSeen.current) setFactory(next);
  }, [holder]);
  useEffect(() => {
    const detach = holder.attach(sync);
    sync();
    return detach;
  }, [holder, sync]);
  if (!factory) return <>{children}</>;
  return <RefreshProvider factory={factory}>{children}</RefreshProvider>;
}
