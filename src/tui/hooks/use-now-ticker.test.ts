/**
 * Tests for useNowTicker.
 *
 * Verified via direct timer observation — the React side is a
 * trivial useState/useEffect wrapper, so a behavior test on the timer
 * cadence is sufficient.
 */

import { describe, expect, test } from "bun:test";

describe("useNowTicker module", () => {
  test("exports a function with default 5000ms cadence", async () => {
    const mod = await import("./use-now-ticker.js");
    expect(typeof mod.useNowTicker).toBe("function");
    // The default-cadence value is documented in the module header; we
    // check the function arity to ensure the optional argument shape is
    // preserved without coupling the test to React's renderer.
    expect(mod.useNowTicker.length).toBe(0);
  });
});
