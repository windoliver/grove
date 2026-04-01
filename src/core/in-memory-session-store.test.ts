/**
 * Tests for InMemorySessionStore using the conformance test suite.
 */

import { InMemorySessionStore } from "./in-memory-session-store.js";
import { sessionStoreConformance } from "./session-store.conformance.js";

sessionStoreConformance(() => new InMemorySessionStore());
