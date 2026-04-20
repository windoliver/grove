import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  type CustomizeActions,
  type CustomizeState,
  type KeymapChoice,
  routeCustomizeKey,
} from "./customize-keyboard.js";

function keyEvent(name: string, seq?: string): KeyEvent {
  return {
    name,
    ctrl: false,
    shift: false,
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
  const actions: CustomizeActions = {
    setField: (f) => calls.push({ name: "setField", args: [f] }),
    setPresetCursor: (n) => calls.push({ name: "setPresetCursor", args: [n] }),
    appendNameChar: (c) => calls.push({ name: "appendNameChar", args: [c] }),
    deleteNameChar: () => calls.push({ name: "deleteNameChar", args: [] }),
    setKeymap: (c) => calls.push({ name: "setKeymap", args: [c] }),
    togglePresetDetail: () => calls.push({ name: "togglePresetDetail", args: [] }),
    goBack: () => calls.push({ name: "goBack", args: [] }),
    launch: () => calls.push({ name: "launch", args: [] }),
  };
  return { calls, actions };
}

function state(over: Partial<CustomizeState> = {}): CustomizeState {
  return {
    field: "preset",
    presetCursor: 0,
    presetCount: 3,
    nameIsEmpty: false,
    keymap: "vim" as KeymapChoice,
    presetDetailOpen: false,
    ...over,
  };
}

describe("routeCustomizeKey (focus cycle)", () => {
  test("Tab cycles preset → name → keymap → preset", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("tab"), state({ field: "preset" }), actions);
    routeCustomizeKey(keyEvent("tab"), state({ field: "name" }), actions);
    routeCustomizeKey(keyEvent("tab"), state({ field: "keymap" }), actions);
    expect(calls.map((c) => c.args[0])).toEqual(["name", "keymap", "preset"]);
  });

  test("Esc goes back from any field", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("escape"), state({ field: "preset" }), actions);
    routeCustomizeKey(keyEvent("escape"), state({ field: "name" }), actions);
    routeCustomizeKey(keyEvent("escape"), state({ field: "keymap" }), actions);
    expect(calls.map((c) => c.name)).toEqual(["goBack", "goBack", "goBack"]);
  });
});

describe("routeCustomizeKey (preset field)", () => {
  test("j / k move preset cursor with clamp", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("j"), state({ presetCursor: 0 }), actions);
    routeCustomizeKey(keyEvent("j"), state({ presetCursor: 2 }), actions); // clamp
    routeCustomizeKey(keyEvent("k"), state({ presetCursor: 0 }), actions); // clamp
    expect(calls.map((c) => c.args[0])).toEqual([1, 2, 0]);
  });

  test("? toggles detail overlay", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("?", "?"), state(), actions);
    expect(calls).toEqual([{ name: "togglePresetDetail", args: [] }]);
  });

  test("Enter launches", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("return"), state(), actions);
    expect(calls).toEqual([{ name: "launch", args: [] }]);
  });
});

describe("routeCustomizeKey (name field)", () => {
  test("printable appends to name", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("a"),
      state({ field: "name", nameIsEmpty: false }),
      actions,
    );
    expect(calls).toEqual([{ name: "appendNameChar", args: ["a"] }]);
  });

  test("space appends a space char", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("space"),
      state({ field: "name", nameIsEmpty: false }),
      actions,
    );
    expect(calls).toEqual([{ name: "appendNameChar", args: [" "] }]);
  });

  test("backspace pops one char", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("backspace"),
      state({ field: "name", nameIsEmpty: false }),
      actions,
    );
    expect(calls).toEqual([{ name: "deleteNameChar", args: [] }]);
  });

  test("Enter launches when name non-empty", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("return"),
      state({ field: "name", nameIsEmpty: false }),
      actions,
    );
    expect(calls).toEqual([{ name: "launch", args: [] }]);
  });

  test("Enter is ignored when name empty", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("return"),
      state({ field: "name", nameIsEmpty: true }),
      actions,
    );
    expect(calls).toEqual([]);
  });
});

describe("routeCustomizeKey (keymap field)", () => {
  test("h/l cycles choice", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("l"),
      state({ field: "keymap", keymap: "vim" }),
      actions,
    );
    routeCustomizeKey(
      keyEvent("l"),
      state({ field: "keymap", keymap: "emacs" }),
      actions,
    );
    routeCustomizeKey(
      keyEvent("h"),
      state({ field: "keymap", keymap: "none" }),
      actions,
    );
    expect(calls.map((c) => c.args[0])).toEqual(["emacs", "none", "emacs"]);
  });

  test("1/2/3 set choice directly", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("1"), state({ field: "keymap" }), actions);
    routeCustomizeKey(keyEvent("2"), state({ field: "keymap" }), actions);
    routeCustomizeKey(keyEvent("3"), state({ field: "keymap" }), actions);
    expect(calls.map((c) => c.args[0])).toEqual(["vim", "emacs", "none"]);
  });

  test("Enter launches", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("return"), state({ field: "keymap" }), actions);
    expect(calls).toEqual([{ name: "launch", args: [] }]);
  });
});
