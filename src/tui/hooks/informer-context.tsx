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
  /**
   * Optional provider used to suspend the watch streams while a session
   * scope is active. The watch protocol does not forward `sessionId`, so a
   * running factory would keep pulling cross-session data. When the
   * provider exposes `hasSessionScope()` and it returns true, the factory
   * stays stopped (Codex round 2, finding 1). Subscribe-changes are
   * delivered via the optional `onSessionScopeChange` listener.
   */
  readonly scopeAwareProvider?: unknown;
  readonly children?: ReactNode | undefined;
}

function readScopeFlag(provider: unknown): boolean {
  if (typeof provider !== "object" || provider === null) return false;
  if (!("hasSessionScope" in provider)) return false;
  const fn = (provider as { hasSessionScope: unknown }).hasSessionScope;
  if (typeof fn !== "function") return false;
  return fn.call(provider) === true;
}

function attachScopeListener(
  provider: unknown,
  listener: (scoped: boolean) => void,
): (() => void) | undefined {
  if (typeof provider !== "object" || provider === null) return undefined;
  if (!("onSessionScopeChange" in provider)) return undefined;
  const fn = (provider as { onSessionScopeChange: unknown }).onSessionScopeChange;
  if (typeof fn !== "function") return undefined;
  const detach = fn.call(provider, listener);
  return typeof detach === "function" ? (detach as () => void) : undefined;
}

export function InformerProvider(props: InformerProviderProps): ReactNode {
  const { value, eager = false, scopeAwareProvider, children } = props;
  const [scoped, setScoped] = useState<boolean>(() => readScopeFlag(scopeAwareProvider));
  useEffect(() => {
    setScoped(readScopeFlag(scopeAwareProvider));
    const detach = attachScopeListener(scopeAwareProvider, setScoped);
    return detach;
  }, [scopeAwareProvider]);

  useEffect(() => {
    if (!eager) return;
    if (scoped) return;
    value.startAll();
    return () => {
      void value.stopAll();
    };
  }, [value, eager, scoped]);
  return <InformerContext.Provider value={value}>{children}</InformerContext.Provider>;
}

export function useInformerFactory(): InformerFactory {
  const factory = useContext(InformerContext);
  if (!factory) {
    throw new Error("useInformer*: must be called inside <InformerProvider>");
  }
  return factory;
}

/**
 * Non-throwing variant of `useInformerFactory`. Returns `null` when no
 * provider is mounted (e.g. backend mode = "nexus" where the factory
 * wasn't constructed) OR when the factory's mode doesn't support the
 * caller's kind. Migrated views that have a `usePolledData` fallback
 * path can use this to decide which path to take per render.
 */
export function useInformerFactoryOptional(): InformerFactory | null {
  return useContext(InformerContext);
}

export function useInformer<K extends WatchKind>(kind: K): Informer<K> {
  return useInformerFactory().informerFor(kind);
}

/**
 * No-op informer used when no `<InformerProvider>` is mounted (e.g. backend
 * mode = "nexus" where the factory wasn't constructed). Returns empty list,
 * `hasSynced=false`, and no-op event subscribers — so callers reading from
 * the cache get nothing and the dual-path views fall back to `usePolledData`.
 *
 * `useInformerOptional` returns this stub when the context is null, which
 * keeps React hook order stable in views that mount under both wrapped and
 * unwrapped trees (the migrated PR2 views).
 */
function createNullInformer<K extends WatchKind>(): Informer<K> {
  // The stub is mounted only when no provider is in scope; subscribers
  // never fire so the unsubscribe is a no-op.
  const unsubNoop = (): void => undefined;
  const noop = (): (() => void) => unsubNoop;
  return {
    addEventHandler: noop,
    addSyncHandler: noop,
    hasSynced: () => false,
    getById: () => undefined,
    list: () => [],
  } as unknown as Informer<K>;
}

const NULL_INFORMER_CACHE = new Map<WatchKind, Informer<WatchKind>>();
function nullInformerFor<K extends WatchKind>(kind: K): Informer<K> {
  let stub = NULL_INFORMER_CACHE.get(kind);
  if (!stub) {
    stub = createNullInformer<K>() as Informer<WatchKind>;
    NULL_INFORMER_CACHE.set(kind, stub);
  }
  return stub as Informer<K>;
}

/**
 * Non-throwing variant of `useInformer`. Returns a no-op informer when no
 * provider is mounted OR when the factory's mode doesn't support the kind.
 * Use this in views with a `usePolledData` fallback so React hook order
 * stays stable across both code paths.
 */
export function useInformerOptional<K extends WatchKind>(kind: K): Informer<K> {
  const factory = useContext(InformerContext);
  if (!factory || !factory.supportsKind(kind)) {
    return nullInformerFor(kind);
  }
  return factory.informerFor(kind);
}

/**
 * Decide whether a migrated view should pull from the informer cache or
 * fall back to its `usePolledData` path. Returns `true` only when:
 *
 *   1. A provider is mounted that supports the kind.
 *   2. The factory mode is "remote" — the in-process local-mode hub
 *      cannot observe writes from agent or CLI subprocesses, so the
 *      cache would silently miss them. PR3+ may add a server-backed
 *      local watch route to lift this restriction.
 *   3. The TUI provider has no session scope — the watch protocol does
 *      not forward `sessionId`, so a scoped view that read from the
 *      global cache would leak contributions or claims from other
 *      sessions. PR3+ extends `/api/watch` with sessionId filtering.
 *
 * The provider is duck-typed (`hasSessionScope?()`) since not every
 * provider implements it; treat absence as "not scoped".
 */
/**
 * Reactive read of `provider.hasSessionScope?.()`. Returns `true` when a
 * session scope is active. Subscribes to `provider.onSessionScopeChange`
 * if available so views re-render when scope flips. PR2 (#388) Codex
 * round 2: lets claim-backed views suppress polling when scoped (the
 * current `getClaims` API does not filter by sessionId, so unsuppressed
 * polling would leak cross-session claims).
 */
export function useProviderScoped(provider: unknown): boolean {
  const [scoped, setScoped] = useState<boolean>(() => readScopeFlag(provider));
  useEffect(() => {
    setScoped(readScopeFlag(provider));
    const detach = attachScopeListener(provider, setScoped);
    return detach;
  }, [provider]);
  return scoped;
}

export function useEntityWatchEnabled(provider: unknown, kind: WatchKind): boolean {
  const factory = useContext(InformerContext);
  // PR2 (#388) Codex round 3: subscribe to scope transitions so that a
  // view rendered before the user enters a scoped session re-renders to
  // false the moment scope flips. A non-reactive read here would let
  // the view keep reading from the (now-stale) global cache.
  const scoped = useProviderScoped(provider);
  if (!factory) return false;
  if (!factory.supportsKind(kind)) return false;
  if (factory.mode !== "remote") return false;
  if (scoped) return false;
  return true;
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
  /**
   * Bind the scope-aware provider so the holder's wrapping
   * `<InformerProvider>` can suspend its watch streams during scoped
   * sessions. Accepts `unknown` since not every provider implements the
   * duck-typed `hasSessionScope`/`onSessionScopeChange` API; absent
   * methods are treated as "never scoped".
   *
   * Call this from the same async callback that sets the factory.
   * Updates after the holder is wired re-trigger the provider's eager
   * effect so a freshly attached scoped provider stops the streams.
   */
  readonly setProvider: (provider: unknown) => void;
  readonly attach: (listener: () => void) => () => void;
  readonly current: () => InformerFactory | null;
  readonly currentProvider: () => unknown;
}

export function createInformerHolder(): InformerHolder {
  let factory: InformerFactory | null = null;
  let provider: unknown;
  const listeners = new Set<() => void>();
  const fireListeners = (): void => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // listener thrown — already isolated; nothing to recover.
      }
    }
  };
  return {
    set(f) {
      if (factory === f) return;
      factory = f;
      fireListeners();
    },
    setProvider(p) {
      if (provider === p) return;
      provider = p;
      fireListeners();
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
    currentProvider() {
      return provider;
    },
  };
}

export interface InformerProviderHolderProps {
  readonly holder: InformerHolder;
  readonly eager?: boolean | undefined;
  /** See `InformerProviderProps.scopeAwareProvider`. */
  readonly scopeAwareProvider?: unknown;
  readonly children?: ReactNode | undefined;
}

/**
 * Provider variant that listens to an `InformerHolder` for a factory that
 * arrives asynchronously. While `holder.current() === null`, this renders
 * children without an `<InformerContext>` — same semantics as not wrapping
 * at all, so dark-ship views are unaffected. Once the factory is set, the
 * `<InformerProvider>` mounts and any subsequent hook consumer works.
 */
export function InformerProviderHolder(props: InformerProviderHolderProps): ReactNode {
  const { holder, eager, scopeAwareProvider, children } = props;
  const [factory, setFactory] = useState<InformerFactory | null>(() => holder.current());
  const [provider, setProvider] = useState<unknown>(() => holder.currentProvider());
  const resolvedProvider = scopeAwareProvider ?? provider;
  const [scoped, setScoped] = useState<boolean>(() => readScopeFlag(resolvedProvider));
  const lastFactory = useRef(factory);
  const lastProvider = useRef<unknown>(provider);
  lastFactory.current = factory;
  lastProvider.current = provider;

  // Coalesce rapid-fire updates from multiple onInit/onStart callbacks
  // into a single re-render via React's setState semantics.
  const sync = useCallback(() => {
    const nextFactory = holder.current();
    if (nextFactory !== lastFactory.current) setFactory(nextFactory);
    const nextProvider = holder.currentProvider();
    if (nextProvider !== lastProvider.current) setProvider(nextProvider);
  }, [holder]);

  useEffect(() => {
    const detach = holder.attach(sync);
    sync();
    return detach;
  }, [holder, sync]);

  useEffect(() => {
    setScoped(readScopeFlag(resolvedProvider));
    const detach = attachScopeListener(resolvedProvider, setScoped);
    return detach;
  }, [resolvedProvider]);

  useEffect(() => {
    if (!factory || !eager || scoped) return;
    factory.startAll();
    return () => {
      void factory.stopAll();
    };
  }, [factory, eager, scoped]);

  // Keep a stable provider wrapper mounted even before the async factory is
  // available. Switching from a fragment to a provider remounts children,
  // which resets TuiApp during the welcome -> boardroom handoff.
  return <InformerContext.Provider value={factory}>{children}</InformerContext.Provider>;
}
