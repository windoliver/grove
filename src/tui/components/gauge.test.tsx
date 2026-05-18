/**
 * Render correctness tests for <Gauge>: bar scaling, edge cases.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Gauge } from "./gauge.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderFrame(element: React.ReactNode): Promise<string> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element as React.ReactElement);
  });
  const flat = JSON.stringify(renderer.toJSON());
  renderer.unmount();
  return flat;
}

describe("Gauge", () => {
  test("renders icon + label + numeric value", async () => {
    const flat = await renderFrame(
      <Gauge label="running" icon="●" value={7} max={10} barWidth={10} />,
    );
    expect(flat).toContain("●");
    expect(flat).toContain("running");
    expect(flat).toContain("7");
  });

  test("bar width scales with value/max", async () => {
    const flat = await renderFrame(<Gauge label="x" value={5} max={10} barWidth={10} />);
    // 5/10 → 5 filled + 5 empty out of barWidth=10
    expect(flat).toMatch(/█{5}░{5}/);
  });

  test("value=0 renders an all-empty bar with no NaN", async () => {
    const flat = await renderFrame(<Gauge label="x" value={0} max={10} barWidth={8} />);
    expect(flat).toMatch(/░{8}/);
    expect(flat).not.toContain("NaN");
  });

  test("max=0 renders empty bar (no division by zero)", async () => {
    const flat = await renderFrame(<Gauge label="x" value={3} max={0} barWidth={8} />);
    expect(flat).toMatch(/░{8}/);
  });

  test("value > max clamps to a full bar", async () => {
    const flat = await renderFrame(<Gauge label="x" value={20} max={10} barWidth={6} />);
    expect(flat).toMatch(/█{6}/);
  });
});
