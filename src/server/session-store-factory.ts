import type { ContributionStore } from "../core/store.js";

/** Reuse session-scoped contribution stores so their internal caches stay effective. */
export function memoizeContributionStoreForSession(
  factory: (sessionId: string) => ContributionStore,
): (sessionId: string) => ContributionStore {
  const storesBySession = new Map<string, ContributionStore>();

  return (sessionId: string): ContributionStore => {
    let store = storesBySession.get(sessionId);
    if (store === undefined) {
      store = factory(sessionId);
      storesBySession.set(sessionId, store);
    }
    return store;
  };
}
