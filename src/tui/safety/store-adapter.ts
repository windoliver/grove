/**
 * EntityStore → ConfirmAndMutateEntityBus adapter (C6 #304, T11).
 *
 * The provider needs a `(kind, id) → entity` lookup plus a per-(kind, id)
 * subscription so it can flip the "state changed externally" banner when
 * the live RV diverges from the snapshot RV.
 *
 * The production EntityStore is per-kind and its `subscribe(fn)` callback
 * is no-arg (fires on every write in the kind). We adapt it by:
 *   - Routing `get(kind, id)` to `factory.storeFor(kind).getById(id)`.
 *   - Wrapping `subscribe(kind, id, cb)` in a fn that re-reads the entity
 *     after each notify and only forwards when the RV moved. This avoids
 *     fanning out unrelated writes (other ids in the same kind) to the
 *     modal — most opens will be a single id, and the modal only cares
 *     about that one.
 *
 * Why an adapter (not a direct hookup): keeping the
 * `ConfirmAndMutateEntityBus` interface narrow lets the provider stay
 * decoupled from the rest of the TUI's data layer, which is critical for
 * the unit-test fake (see `confirm-and-mutate.test.tsx`'s FakeEntityBus).
 */

import type { EntityForKind } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import type { EntityStoreFactory } from "../data/entity-store.js";
import type { ConfirmAndMutateEntityBus } from "./confirm-and-mutate.js";

export function makeEntityBusFromStore(factory: EntityStoreFactory): ConfirmAndMutateEntityBus {
  return {
    get<K extends WatchKind>(kind: K, id: string): EntityForKind<K> | undefined {
      if (!factory.supportsKind(kind)) return undefined;
      return factory.storeFor(kind).getById(id);
    },
    subscribe<K extends WatchKind>(
      kind: K,
      id: string,
      cb: (entity: EntityForKind<K> | undefined) => void,
    ): () => void {
      if (!factory.supportsKind(kind)) {
        // No watch backing for this kind in the current mode (e.g., local
        // vs. remote). Return a no-op unsubscribe so the provider's
        // effect runs cleanly; the banner just stays off for this kind.
        return () => undefined;
      }
      const store = factory.storeFor(kind);
      let lastRv: string | undefined = store.getById(id)?.resourceVersion;
      return store.subscribe(() => {
        const current = store.getById(id);
        const rv = current?.resourceVersion;
        if (rv === lastRv) return;
        lastRv = rv;
        if (current) cb(current);
      });
    },
  };
}
