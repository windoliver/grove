import { describe, expect, mock, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type React from "react";
import type * as TestRendererTypes from "react-test-renderer";
import type { TuiPresetEntry } from "../../tui-app.js";
import type { KeymapChoice } from "./customize-keyboard.js";
import type { WelcomeMode } from "./router.js";

let keyboardHandler: ((key: KeyEvent) => void) | undefined;

mock.module("@opentui/react", () => ({
  useKeyboard: (handler: (key: KeyEvent) => void): void => {
    keyboardHandler = handler;
  },
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
}));

const TestRendererModule = await import("react-test-renderer");
const TestRenderer = (TestRendererModule as unknown as { default: typeof TestRendererTypes })
  .default;
const { act } = TestRendererModule;
const { FirstRun } = await import("./first-run.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function keyEvent(name: string): KeyEvent {
  return {
    name,
    ctrl: false,
    shift: false,
    meta: false,
    alt: false,
    option: false,
    sequence: name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as KeyEvent;
}

describe("FirstRun keymap defaults", () => {
  test("fast path launches with the default keymap preset", async () => {
    const presets: readonly TuiPresetEntry[] = [{ name: "coder", description: "Code" }];
    let selected:
      | {
          readonly preset: string;
          readonly name: string;
          readonly mode: WelcomeMode;
          readonly keymap: KeymapChoice;
        }
      | undefined;
    let renderer!: TestRendererTypes.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        (
          <FirstRun
            presets={presets}
            cwd="/tmp/demo-grove"
            onSelect={(args) => {
              selected = args;
            }}
            onConnect={() => undefined}
            onQuit={() => undefined}
          />
        ) as React.ReactElement,
      );
    });

    await act(async () => {
      keyboardHandler?.(keyEvent("return"));
    });

    expect(selected).toMatchObject({
      preset: "coder",
      name: "demo-grove",
      mode: "local",
      keymap: "default",
    });

    await act(async () => {
      renderer.unmount();
    });
  });
});
