/**
 * Tests for BreadcrumbBar stack-mode rendering.
 *
 * Covers the new `stack` prop path added in #303:
 *   1. Single-page stack renders just that label
 *   2. Multi-page stack joins labels with ›
 *   3. Narrow width (<70) shows only the current (last) label
 *   4. Wide width (>=100) prepends "Grove"
 *   5. Legacy screen prop still works when stack is absent
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { Page } from "../data/pages-store.js";
import { BreadcrumbBar } from "./breadcrumb-bar.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(props: Parameters<typeof BreadcrumbBar>[0]): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(BreadcrumbBar, props));
  });
  if (!renderer) throw new Error("renderer not initialized");
  return renderer;
}

describe("BreadcrumbBar – stack mode", () => {
  test("single-page stack renders just that label", () => {
    const stack: readonly Page[] = [{ kind: "preset-select" }];
    const flat = JSON.stringify(render({ stack, width: 120 }).toJSON());
    expect(flat).toContain("Preset Select");
  });

  test("depth chain: labels and › separator all present", () => {
    const stack: readonly Page[] = [
      { kind: "running" },
      { kind: "panel", params: { panel: "agents" } },
      { kind: "panel", params: { panel: "sessions" } },
    ];
    const flat = JSON.stringify(render({ stack, width: 120 }).toJSON());
    expect(flat).toContain("Running");
    expect(flat).toContain("Agents");
    expect(flat).toContain("Sessions");
    expect(flat).toContain("›");
  });

  test("width<70 shows only the current (last) label", () => {
    const stack: readonly Page[] = [
      { kind: "running" },
      { kind: "panel", params: { panel: "agents" } },
      { kind: "panel", params: { panel: "sessions" } },
    ];
    const flat = JSON.stringify(render({ stack, width: 50 }).toJSON());
    expect(flat).toContain("Sessions");
    expect(flat).not.toContain("Running");
  });

  test("width>=100 prepends Grove", () => {
    const stack: readonly Page[] = [{ kind: "running" }];
    const flat = JSON.stringify(render({ stack, width: 120 }).toJSON());
    expect(flat).toContain("Grove");
  });

  test("legacy screen prop still works when stack is absent", () => {
    const flat = JSON.stringify(render({ screen: "goal-input", width: 120 }).toJSON());
    expect(flat).toContain("Goal");
  });
});
