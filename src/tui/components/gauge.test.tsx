import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Gauge } from "./gauge.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(props: Parameters<typeof Gauge>[0]): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Gauge, props));
  });
  if (!renderer) throw new Error("renderer not initialized");
  return renderer;
}

describe("Gauge", () => {
  test("renders icon + label + numeric value", () => {
    const result = render({ label: "running", icon: "●", value: 7, max: 10, barWidth: 10 });
    const flat = JSON.stringify(result.toJSON());
    expect(flat).toContain("●");
    expect(flat).toContain("running");
    expect(flat).toContain("7");
  });

  test("bar width scales with value/max", () => {
    const result = render({ label: "x", value: 5, max: 10, barWidth: 10 });
    const flat = JSON.stringify(result.toJSON());
    // 5/10 → 5 filled + 5 empty out of barWidth=10
    expect(flat).toMatch(/█{5}░{5}/);
  });

  test("value=0 renders an all-empty bar with no NaN", () => {
    const result = render({ label: "x", value: 0, max: 10, barWidth: 8 });
    const flat = JSON.stringify(result.toJSON());
    expect(flat).toMatch(/░{8}/);
    expect(flat).not.toContain("NaN");
  });

  test("max=0 renders empty bar (no division by zero)", () => {
    const result = render({ label: "x", value: 3, max: 0, barWidth: 8 });
    const flat = JSON.stringify(result.toJSON());
    expect(flat).toMatch(/░{8}/);
  });

  test("value > max clamps to a full bar", () => {
    const result = render({ label: "x", value: 20, max: 10, barWidth: 6 });
    const flat = JSON.stringify(result.toJSON());
    expect(flat).toMatch(/█{6}/);
  });
});
