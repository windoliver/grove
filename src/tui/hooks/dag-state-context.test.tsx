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
const { DagStateStore } = await import("../data/dag-state-store.js");
const { DagStateProvider, useDagState } = await import("./dag-state-context.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(): React.ReactNode {
  const { snapshot } = useDagState();
  // Interpolate into a single string so react-test-renderer emits one child
  // node — keeps the assertion substring (`foo|0|_`) contiguous inside the
  // JSON.stringify dump rather than split across an array of child tokens.
  const body = `${snapshot.highlight || "_"}|${snapshot.collapsed.size}|${snapshot.focusCid ?? "_"}`;
  return <text>{body}</text>;
}

describe("DagStateProvider + useDagState", () => {
  test("provides initial snapshot", async () => {
    const store = new DagStateStore();
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <Probe />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("_|0|_");
    renderer.unmount();
  });

  test("re-renders on highlight mutation", async () => {
    const store = new DagStateStore();
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <Probe />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      store.setHighlight("foo");
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("foo|0|_");
    renderer.unmount();
  });

  test("re-renders on toggleCollapsed", async () => {
    const store = new DagStateStore();
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <Probe />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      store.toggleCollapsed("blake3:aaa");
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("_|1|_");
    renderer.unmount();
  });

  test("useDagState outside provider throws", async () => {
    // React 19 routes render-time throws through the error-boundary path
    // and surfaces them via console.error rather than re-throwing out of
    // TestRenderer.create. Capture the reported error and assert on it.
    const orig = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]): void => {
      errors.push(args[0]);
    };
    try {
      await act(async () => {
        TestRenderer.create((<Probe />) as React.ReactElement);
      });
    } catch (e) {
      errors.push(e);
    } finally {
      console.error = orig;
    }
    const messages = errors.map((e) => (e instanceof Error ? e.message : String(e))).join("\n");
    expect(messages).toContain("useDagState must be called inside a <DagStateProvider>");
  });
});
