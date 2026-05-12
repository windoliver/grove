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
const { DagStatusIcon } = await import("./dag-status-icon.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DagStatusIcon", () => {
  const cases: { status: string; glyph: string }[] = [
    { status: "running", glyph: "◐" },
    { status: "done", glyph: "✓" },
    { status: "failed", glyph: "✗" },
    { status: "blocked", glyph: "⊘" },
    { status: "awaiting-review", glyph: "?" },
    { status: "idle", glyph: "·" },
  ];

  for (const c of cases) {
    test(`${c.status} → ${c.glyph}`, async () => {
      let renderer!: TestRendererTypes.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          (<DagStatusIcon status={c.status as "idle"} />) as React.ReactElement,
        );
      });
      const flat = JSON.stringify(renderer.toJSON());
      expect(flat).toContain(c.glyph);
      renderer.unmount();
    });
  }
});
