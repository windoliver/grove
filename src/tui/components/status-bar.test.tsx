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
const { resolveBuiltinKeymap } = await import("../keymap/keymap.js");
const { InputMode, Panel } = await import("../hooks/use-panel-focus.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function unmountStatusBar(renderer: TestRendererTypes.ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

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
    await unmountStatusBar(renderer);
  });

  test("does not render [INSPECT] without screenContext", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<StatusBar mode={InputMode.Normal} />) as React.ReactElement);
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).not.toContain("INSPECT");
    await unmountStatusBar(renderer);
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
    await unmountStatusBar(renderer);
  });
});

describe("StatusBar keymap-driven hints", () => {
  test("renders compact default-preset hints from the resolved keymap", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <StatusBar mode={InputMode.Normal} resolvedKeymap={resolveBuiltinKeymap("default")} />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());

    expect(flat).toContain("Space:leader");
    expect(flat).toContain("Tab:cycle");
    expect(flat).toContain("j/k:nav");
    expect(flat).toContain("Enter:select");
    expect(flat).not.toContain("5-`:toggle");
    await unmountStatusBar(renderer);
  });

  test("renders focused terminal hints from the default keymap", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <StatusBar
            mode={InputMode.Normal}
            focusedPanel={Panel.Terminal}
            resolvedKeymap={resolveBuiltinKeymap("default")}
          />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());

    expect(flat).toContain("Space p t:panel");
    expect(flat).toContain("i:input");
    expect(flat).toContain("j/k:scroll");
    await unmountStatusBar(renderer);
  });

  test("prefers power-user direct panel aliases when that preset is active", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <StatusBar
            mode={InputMode.Normal}
            focusedPanel={Panel.Terminal}
            resolvedKeymap={resolveBuiltinKeymap("power-user")}
          />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());

    expect(flat).toContain("6:panel");
    expect(flat).not.toContain("Space p t:panel");
    await unmountStatusBar(renderer);
  });

  test("renders pending leader prefix instead of normal hints", async () => {
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <StatusBar
            mode={InputMode.Normal}
            resolvedKeymap={resolveBuiltinKeymap("default")}
            keymapPrefix={["space", "p"]}
          />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());

    expect(flat).toContain("Space p ...");
    expect(flat).toContain("Esc:cancel");
    expect(flat).not.toContain("j/k:nav");
    await unmountStatusBar(renderer);
  });
});
