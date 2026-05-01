/**
 * RefreshProvider — wires the global refresh trigger (r-key) to
 * factory.relist(). Replaces use-refresh-context.ts's numeric-signal
 * approach for informer-backed hooks. The old context stays in tree
 * during the migration; PR5 deletes it.
 */

import { createContext, type ReactNode, useCallback, useContext } from "react";
import type { InformerFactory } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";

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
