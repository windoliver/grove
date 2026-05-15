/**
 * Tests for status-bar screen-context chip rendering (Task 11).
 *
 * Verifies the `[INSPECT]` chip renders when `screenContext === "inspect"`
 * and is absent when `screenContext` is undefined.
 */

import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import type * as TestRendererTypes from "react-test-renderer";

mock.module("@opentui/react", () => ({
  useKeyboard: (): void => undefined,
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 80, height: 24 }),
  useTimeline: (): unknown => ({}),
  useOnResize: (): void => undefined,
  useAppContext: (): unknown => ({}),
  createPortal: (children: unknown): unknown => children,
  createRoot: (): unknown => ({}),
  createElement: (): unknown => null,
  flushSync: (fn: () => void): void => fn(),
  extend: (): void => undefined,
  getComponentCatalogue: (): unknown => ({}),
  componentCatalogue: {},
  baseComponents: {},
  TimeToFirstDraw: (): null => null,
  AppContext: {},
}));

const TestRendererModule = await import("react-test-renderer");
const TestRenderer = (TestRendererModule as unknown as { default: typeof TestRendererTypes })
  .default;
const { act } = TestRendererModule;
const { StatusBar } = await import("./status-bar.js");
const { InputMode } = await import("../hooks/use-panel-focus.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StatusBar screen-context chip", () => {
  test("renders [INSPECT] when screenContext is 'inspect'", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<StatusBar mode={InputMode.Normal} screenContext="inspect" />) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    // OpenTUI splits the chip into ["[", "INSPECT", "]"] across text children,
    // so we assert on the unique label token (the "[INSPECT]" wrapping is
    // produced by adjacent text nodes in the same <text> element).
    expect(flat).toContain("INSPECT");
    renderer.unmount();
  });

  test("does not render [INSPECT] without screenContext", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<StatusBar mode={InputMode.Normal} />) as React.ReactElement);
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).not.toContain("INSPECT");
    renderer.unmount();
  });

  test("renders [RUNNING] when screenContext is 'running'", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<StatusBar mode={InputMode.Normal} screenContext="running" />) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("RUNNING");
    renderer.unmount();
  });
});
