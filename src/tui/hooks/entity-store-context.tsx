/**
 * EntityStoreProvider — supplies an EntityStoreFactory to React subscribers (B1 #296).
 *
 * Mirrors `informer-context.tsx`. The provider takes a factory; consumer
 * hooks resolve a per-kind `EntityStore<K>` from it. When no provider is
 * mounted (e.g. in test trees or during early bootstrap), the optional
 * hook returns a frozen no-op store so React hook order stays stable.
 *
 * Lifecycle: this provider does NOT start the underlying watch streams.
 * Stream lifecycle is owned by `InformerProvider` (see informer-context).
 * `EntityStoreProvider` is mounted INSIDE `InformerProvider`.
 */

import { createContext, type ReactNode, useContext } from "react";
import type { WatchKind } from "../../core/watch-events.js";
import type { EntityStore, EntityStoreFactory } from "../data/entity-store.js";

const EntityStoreContext = createContext<EntityStoreFactory | null>(null);
EntityStoreContext.displayName = "EntityStoreContext";

export interface EntityStoreProviderProps {
  readonly value: EntityStoreFactory;
  readonly children: ReactNode;
}

export function EntityStoreProvider(props: EntityStoreProviderProps): ReactNode {
  return (
    <EntityStoreContext.Provider value={props.value}>{props.children}</EntityStoreContext.Provider>
  );
}

export function useEntityStoreFactoryOptional(): EntityStoreFactory | null {
  return useContext(EntityStoreContext);
}

const NULL_SUBSCRIBE =
  (_fn: () => void): (() => void) =>
  () =>
    undefined;
const FROZEN_EMPTY: readonly unknown[] = Object.freeze([]);

const NULL_STORE_CACHE = new Map<WatchKind, EntityStore<WatchKind>>();
function nullStoreFor<K extends WatchKind>(kind: K): EntityStore<K> {
  let stub = NULL_STORE_CACHE.get(kind);
  if (!stub) {
    stub = {
      subscribe: NULL_SUBSCRIBE,
      getVersion: () => 0,
      list: () => FROZEN_EMPTY as never,
      getById: () => undefined,
      hasSynced: () => false,
      getStats: () => ({ writes: 0, version: 0, lagSamples: [] }),
      dispose: () => undefined,
    } as unknown as EntityStore<WatchKind>;
    NULL_STORE_CACHE.set(kind, stub);
  }
  return stub as unknown as EntityStore<K>;
}

/**
 * Returns the kind's EntityStore from the mounted provider, or a frozen
 * no-op store when (a) no provider is mounted or (b) the factory's mode
 * doesn't support the kind. Mirrors `useInformerOptional` so hook order
 * stays stable across migrated and unmigrated trees.
 */
export function useEntityStoreOptional<K extends WatchKind>(kind: K): EntityStore<K> {
  const factory = useContext(EntityStoreContext);
  if (!factory || !factory.supportsKind(kind)) {
    return nullStoreFor(kind);
  }
  return factory.storeFor(kind);
}
