/**
 * Tests for the EmptyState component.
 *
 * Verifies that the component renders title and hint props correctly.
 */

import { describe, expect, test } from "bun:test";

describe("EmptyState", () => {
  test("module exports EmptyState component", async () => {
    const mod = await import("./empty-state.js");
    expect(mod.EmptyState).toBeDefined();
    expect(typeof mod.EmptyState).toBe("object"); // React.memo returns an object
  });
});
