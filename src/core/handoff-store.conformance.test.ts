/**
 * Run HandoffStore conformance suite against InMemoryHandoffStore.
 */

import { runHandoffStoreTests } from "./handoff-store.conformance.js";
import { InMemoryHandoffStore } from "./in-memory-handoff-store.js";

runHandoffStoreTests(async () => {
  const store = new InMemoryHandoffStore();
  return {
    store,
    cleanup: async () => {
      /* in-memory — nothing to clean up */
    },
  };
});
