import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { WelcomeMode } from "./router.js";
import {
  type ModePickerActions,
  type ModePickerState,
  routeModePickerKey,
} from "./mode-picker-keyboard.js";

function keyEvent(name: string, seq?: string, shift = false): KeyEvent {
  return {
    name,
    ctrl: false,
    shift,
    meta: false,
    alt: false,
    option: false,
    sequence: seq ?? name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent;
}

function tracker() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const actions: ModePickerActions = {
    setMode: (m) => calls.push({ name: "setMode", args: [m] }),
    startWithDefaults: () => calls.push({ name: "startWithDefaults", args: [] }),
    goToCustomize: () => calls.push({ name: "goToCustomize", args: [] }),
    openConnect: () => calls.push({ name: "openConnect", args: [] }),
    toggleGlossary: () => calls.push({ name: "toggleGlossary", args: [] }),
    onQuit: () => calls.push({ name: "onQuit", args: [] }),
  };
  return { calls, actions };
}

function state(over: Partial<ModePickerState> = {}): ModePickerState {
  return { mode: "local" as WelcomeMode, glossaryOpen: false, ...over };
}

describe("routeModePickerKey", () => {
  test("l / right selects connected", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("l"), state({ mode: "local" }), actions);
    routeModePickerKey(keyEvent("right"), state({ mode: "local" }), actions);
    expect(calls).toEqual([
      { name: "setMode", args: ["connected"] },
      { name: "setMode", args: ["connected"] },
    ]);
  });

  test("h / left selects local", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("h"), state({ mode: "connected" }), actions);
    routeModePickerKey(keyEvent("left"), state({ mode: "connected" }), actions);
    expect(calls).toEqual([
      { name: "setMode", args: ["local"] },
      { name: "setMode", args: ["local"] },
    ]);
  });

  test("Enter starts with defaults", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("return"), state(), actions);
    expect(calls).toEqual([{ name: "startWithDefaults", args: [] }]);
  });

  test("Tab routes to customize", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("tab"), state(), actions);
    expect(calls).toEqual([{ name: "goToCustomize", args: [] }]);
  });

  test("c opens connect", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("c"), state(), actions);
    expect(calls).toEqual([{ name: "openConnect", args: [] }]);
  });

  test("? toggles glossary", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("?", "?", true), state(), actions);
    expect(calls).toEqual([{ name: "toggleGlossary", args: [] }]);
  });

  test("Esc when glossary open closes it", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("escape"), state({ glossaryOpen: true }), actions);
    expect(calls).toEqual([{ name: "toggleGlossary", args: [] }]);
  });

  test("q quits", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("q"), state(), actions);
    expect(calls).toEqual([{ name: "onQuit", args: [] }]);
  });
});
