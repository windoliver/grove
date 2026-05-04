/**
 * RefreshProvider — wires the global refresh trigger (r-key + app-level
 * event fan-out) to two consumer types:
 *
 *   1. Informer-backed views read `useRelistTrigger()` and call it (or have
 *      it called by the App-level r-key handler) to drive `factory.relist()`.
 *   2. Non-Entity fetcher hooks (`useEventDrivenData`) subscribe via
 *      `useRefreshSignal(fn)` — a numeric-signal counter increments on every
 *      trigger so each subscriber re-fetches.
 *
 * The provider exists once near the App root. Both useRelistTrigger and
 * useRefreshSignal degrade to no-ops when no provider is mounted (e.g.
 * during the brief async-arrival window before the holder has a factory)
 * so callers don't need to gate on provider presence.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { InformerFactory } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import type { InformerHolder } from "./informer-context.js";

type RefreshFn = (kind?: WatchKind) => void;

const RefreshFnContext = createContext<RefreshFn | null>(null);
RefreshFnContext.displayName = "RefreshFnContext";

interface SignalContextValue {
  readonly signal: number;
}
const SignalContext = createContext<SignalContextValue>({ signal: 0 });
SignalContext.displayName = "RefreshSignalContext";

export interface RefreshProviderProps {
  readonly factory: InformerFactory;
  readonly children: ReactNode;
}

export function RefreshProvider(props: RefreshProviderProps): ReactNode {
  const { factory, children } = props;
  const [signal, setSignal] = useState(0);
  const refresh = useCallback<RefreshFn>(
    (kind) => {
      setSignal((s) => s + 1);
      void factory.relist(kind);
    },
    [factory],
  );
  return (
    <RefreshFnContext.Provider value={refresh}>
      <SignalContext.Provider value={{ signal }}>{children}</SignalContext.Provider>
    </RefreshFnContext.Provider>
  );
}

const NOOP_REFRESH: RefreshFn = () => undefined;

/**
 * Returns the global refresh trigger. When no provider is mounted, returns
 * a no-op so callers (e.g. App-level r-key handlers) can call it
 * unconditionally during the brief factory async-arrival window.
 */
export function useRelistTrigger(): RefreshFn {
  return useContext(RefreshFnContext) ?? NOOP_REFRESH;
}

/** Subscribe a fetcher to the global refresh signal. */
export function useRefreshSignal(onRefresh: () => void): void {
  const { signal } = useContext(SignalContext);
  const last = useRef(signal);
  useEffect(() => {
    if (signal > last.current) {
      last.current = signal;
      onRefresh();
    }
  }, [signal, onRefresh]);
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
