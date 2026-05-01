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

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
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

/**
 * Holder for a factory that's not yet known at provider mount time —
 * needed by the interactive TUI flow (TuiApp) where the factory is
 * created inside async onInit/onStart/onConnect callbacks AFTER the
 * setup screen has already rendered. The TUI obtains the holder's
 * `set()` once and calls it from each callback; the wrapping
 * `<InformerProviderHolder>` re-renders on change so subsequent screens
 * have the provider in scope.
 *
 * Children rendered before `set()` is called see the context value as
 * null; calling any hook (`useInformer*`) in that window throws — so do
 * not migrate any screen to hooks until PR2's view migrations have a
 * code path guaranteed to render after `set()`.
 */
export interface InformerHolder {
  readonly set: (factory: InformerFactory | null) => void;
  readonly attach: (listener: () => void) => () => void;
  readonly current: () => InformerFactory | null;
}

export function createInformerHolder(): InformerHolder {
  let factory: InformerFactory | null = null;
  const listeners = new Set<() => void>();
  return {
    set(f) {
      if (factory === f) return;
      factory = f;
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch {
          // listener thrown — already isolated; nothing to recover.
        }
      }
    },
    attach(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    current() {
      return factory;
    },
  };
}

export interface InformerProviderHolderProps {
  readonly holder: InformerHolder;
  readonly eager?: boolean | undefined;
  readonly children: ReactNode;
}

/**
 * Provider variant that listens to an `InformerHolder` for a factory that
 * arrives asynchronously. While `holder.current() === null`, this renders
 * children without an `<InformerContext>` — same semantics as not wrapping
 * at all, so dark-ship views are unaffected. Once the factory is set, the
 * `<InformerProvider>` mounts and any subsequent hook consumer works.
 */
export function InformerProviderHolder(props: InformerProviderHolderProps): ReactNode {
  const { holder, eager, children } = props;
  const [factory, setFactory] = useState<InformerFactory | null>(() => holder.current());
  const lastSeen = useRef(factory);
  lastSeen.current = factory;

  // Coalesce rapid-fire updates from multiple onInit/onStart callbacks
  // into a single re-render via React's setState semantics.
  const sync = useCallback(() => {
    const next = holder.current();
    if (next !== lastSeen.current) {
      setFactory(next);
    }
  }, [holder]);

  useEffect(() => {
    const detach = holder.attach(sync);
    sync();
    return detach;
  }, [holder, sync]);

  if (!factory) return <>{children}</>;
  return (
    <InformerProvider value={factory} eager={eager}>
      {children}
    </InformerProvider>
  );
}
