/**
 * Run HandoffStore conformance tests against InMemoryHandoffStore.
 */

import { runHandoffStoreConformanceTests } from "./handoff-store.conformance.js";
import { InMemoryHandoffStore } from "./in-memory-handoff-store.js";

runHandoffStoreConformanceTests("InMemoryHandoffStore", () => new InMemoryHandoffStore());
