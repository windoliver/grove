/**
 * Tests for DefaultFrontierCalculator using an in-memory ContributionStore.
 */

import { describe } from "bun:test";
import { runFrontierCalculatorTests } from "./frontier.conformance.js";
import { DefaultFrontierCalculator } from "./frontier.js";
import { InMemoryContributionStore } from "./testing.js";

// ---------------------------------------------------------------------------
// Run conformance suite
// ---------------------------------------------------------------------------

describe("DefaultFrontierCalculator", () => {
  runFrontierCalculatorTests(async () => {
    const store = new InMemoryContributionStore();
    const calculator = new DefaultFrontierCalculator(store);
    return {
      store,
      calculator,
      cleanup: async () => {
        store.close();
      },
    };
  });
});
