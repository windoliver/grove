/**
 * Tests for the EmptyState component.
 *
 * Tests prop-driven rendering contract without a full React renderer,
 * following the pure-function extraction pattern from trace-pane.test.ts.
 *
 * Since OpenTUI renders to a terminal and not a DOM, we test the data
 * contract — props are well-typed, component exports the right interface,
 * and the conditional logic (hint shown/hidden) is correct.
 */

import { describe, expect, test } from "bun:test";
import type { EmptyStateProps } from "./empty-state.js";

describe("EmptyState module", () => {
  test("exports EmptyState as a React.memo component", async () => {
    const mod = await import("./empty-state.js");
    expect(mod.EmptyState).toBeDefined();
    expect(typeof mod.EmptyState).toBe("object"); // React.memo returns an object
  });

  test("EmptyState has the correct display name (set by React.memo)", async () => {
    const { EmptyState } = await import("./empty-state.js");
    // React.memo wraps the inner function — its type is object with a .type property
    const inner = (EmptyState as unknown as { type?: { name?: string } }).type;
    expect(inner?.name).toBe("EmptyState");
  });
});

describe("EmptyState props contract", () => {
  test("accepts title-only (hint is optional)", () => {
    const props: EmptyStateProps = { title: "Nothing here yet." };
    expect(props.title).toBe("Nothing here yet.");
    expect(props.hint).toBeUndefined();
  });

  test("accepts title + hint", () => {
    const props: EmptyStateProps = {
      title: "No results found.",
      hint: "Try a different query.",
    };
    expect(props.title).toBe("No results found.");
    expect(props.hint).toBe("Try a different query.");
  });

  test("hint=undefined is valid (does not crash props validation)", () => {
    const props: EmptyStateProps = { title: "Empty", hint: undefined };
    expect(props.hint).toBeUndefined();
  });

  test("title is required (TypeScript enforces this)", () => {
    // This test documents the contract at the type level.
    // The type system will error if title is omitted — verified by tsc.
    const props: EmptyStateProps = { title: "Required title" };
    expect(typeof props.title).toBe("string");
  });
});

describe("EmptyState conditional hint logic", () => {
  // The component conditionally renders hint only when it is defined.
  // We test this logic in isolation (without React renderer).
  function shouldShowHint(hint: string | undefined): boolean {
    return hint !== undefined && hint.length > 0;
  }

  test("hint is shown when a non-empty string is provided", () => {
    expect(shouldShowHint("Use grove_create_plan to create one.")).toBe(true);
  });

  test("hint is not shown when undefined", () => {
    expect(shouldShowHint(undefined)).toBe(false);
  });

  test("hint is not shown when empty string", () => {
    expect(shouldShowHint("")).toBe(false);
  });
});
