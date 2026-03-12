/**
 * Run the operations conformance suite against local SQLite + FS backends.
 *
 * This validates that the operations layer returns results matching
 * the shared Zod schemas from schemas.ts.
 */

import { runOperationConformanceTests } from "./operations.conformance.js";
import { createTestOperationDeps } from "./test-helpers.js";

runOperationConformanceTests(async () => {
  const testDeps = await createTestOperationDeps();
  return {
    deps: testDeps.deps,
    cleanup: testDeps.cleanup,
  };
});
