/**
 * Tests for HintBar component and truncateForWidth pure function.
 *
 * 9 test cases:
 *   Component (5):
 *     1. All labels at width=120
 *     2. Brackets rendered
 *     3. Null at width=30
 *     4. Null on empty hints
 *     5. Ellipsis on truncation at width=40
 *   Pure function (4):
 *     6. Generous width returns all, truncated=false
 *     7. Greedy at width=40 stops at 2 actions
 *     8. Tight at width=10 returns empty, truncated=true
 *     9. Empty input returns empty, truncated=false
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { KeyAction } from "../data/hint-map.js";
import { HintBar, truncateForWidth } from "./hint-bar.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAMPLE: readonly KeyAction[] = [
  { key: "Enter", label: "Focus" },
  { key: "Space", label: "Expand" },
  { key: "R", label: "Review" },
  { key: "M", label: "Merge" },
  { key: "L", label: "Logs" },
];

function render(props: {
  hints: readonly KeyAction[];
  width: number;
}): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create((<HintBar {...props} />) as React.ReactElement);
  });
  if (!renderer) throw new Error("renderer not initialized");
  return renderer;
}

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

describe("HintBar – component", () => {
  test("1. all labels present at width=120", () => {
    const flat = JSON.stringify(render({ hints: SAMPLE, width: 120 }).toJSON());
    expect(flat).toContain("Focus");
    expect(flat).toContain("Expand");
    expect(flat).toContain("Review");
    expect(flat).toContain("Merge");
    expect(flat).toContain("Logs");
  });

  test("2. brackets rendered for first two actions", () => {
    const flat = JSON.stringify(render({ hints: SAMPLE, width: 120 }).toJSON());
    expect(flat).toContain("[Enter]");
    expect(flat).toContain("[Space]");
  });

  test("3. returns null at width=30", () => {
    const result = render({ hints: SAMPLE, width: 30 }).toJSON();
    expect(result).toBeNull();
  });

  test("4. returns null on empty hints", () => {
    const result = render({ hints: [], width: 120 }).toJSON();
    expect(result).toBeNull();
  });

  test("5. ellipsis on truncation at width=40", () => {
    const flat = JSON.stringify(render({ hints: SAMPLE, width: 40 }).toJSON());
    expect(flat).toContain("…");
    expect(flat).toContain("Focus");
    expect(flat).not.toContain("Logs");
  });
});

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("truncateForWidth – pure function", () => {
  test("6. generous width returns all actions, truncated=false", () => {
    const result = truncateForWidth(SAMPLE, 120);
    expect(result.actions).toEqual(SAMPLE);
    expect(result.truncated).toBe(false);
  });

  test("7. greedy at width=40 returns first 2 actions, truncated=true", () => {
    // budget = 40 - 2 (PADDING_X) - 2 (ELLIPSIS_BUDGET) = 36
    // "[Enter]Focus"         = 12 chars, cumulative 12  (≤36 ✓)
    // "  [Space]Expand"      = 15 chars, cumulative 27  (≤36 ✓)
    // "  [R]Review"          = 11 chars, cumulative 38  (>36 ✗) → stops
    const result = truncateForWidth(SAMPLE, 40);
    expect(result.actions).toEqual(SAMPLE.slice(0, 2));
    expect(result.truncated).toBe(true);
  });

  test("8. tight at width=10 returns empty, truncated=true", () => {
    // budget = 10 - 2 - 2 = 6; "[Enter]Focus" = 12 > 6 → no fit
    const result = truncateForWidth(SAMPLE, 10);
    expect(result.actions).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  test("9. empty input returns empty, truncated=false", () => {
    const result = truncateForWidth([], 120);
    expect(result.actions).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
