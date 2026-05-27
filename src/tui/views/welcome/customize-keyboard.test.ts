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
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as KeyEvent;
}

function tracker() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const actions: CustomizeActions = {
    setField: (f) => calls.push({ name: "setField", args: [f] }),
    movePresetCursor: (d) => calls.push({ name: "movePresetCursor", args: [d] }),
    appendNameChar: (c) => calls.push({ name: "appendNameChar", args: [c] }),
    deleteNameChar: () => calls.push({ name: "deleteNameChar", args: [] }),
    setKeymap: (c) => calls.push({ name: "setKeymap", args: [c] }),
    togglePresetDetail: () => calls.push({ name: "togglePresetDetail", args: [] }),
    goBack: () => calls.push({ name: "goBack", args: [] }),
    launch: () => calls.push({ name: "launch", args: [] }),
    onQuit: () => calls.push({ name: "onQuit", args: [] }),
  };
  return { calls, actions };
}

function state(over: Partial<CustomizeState> = {}): CustomizeState {
  return {
    field: "preset",
    presetCursor: 0,
    presetCount: 3,
    nameIsEmpty: false,
    keymap: "default" as KeymapChoice,
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
  test("j emits movePresetCursor(+1); k emits (-1)", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("j"), state({ presetCursor: 0 }), actions);
    routeCustomizeKey(keyEvent("k"), state({ presetCursor: 0 }), actions);
    expect(calls.map((c) => [c.name, c.args[0]])).toEqual([
      ["movePresetCursor", 1],
      ["movePresetCursor", -1],
    ]);
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
    routeCustomizeKey(keyEvent("a"), state({ field: "name", nameIsEmpty: false }), actions);
    expect(calls).toEqual([{ name: "appendNameChar", args: ["a"] }]);
  });

  test("space appends a space char", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("space"), state({ field: "name", nameIsEmpty: false }), actions);
    expect(calls).toEqual([{ name: "appendNameChar", args: [" "] }]);
  });

  test("backspace pops one char", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("backspace"), state({ field: "name", nameIsEmpty: false }), actions);
    expect(calls).toEqual([{ name: "deleteNameChar", args: [] }]);
  });

  test("Enter launches when name non-empty", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("return"), state({ field: "name", nameIsEmpty: false }), actions);
    expect(calls).toEqual([{ name: "launch", args: [] }]);
  });

  test("Enter is ignored when name empty", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("return"), state({ field: "name", nameIsEmpty: true }), actions);
    expect(calls).toEqual([]);
  });

  test("Enter is ignored when presets list is empty", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("return"),
      state({ field: "preset", presetCount: 0, nameIsEmpty: false }),
      actions,
    );
    expect(calls).toEqual([]);
  });

  test("? is a no-op when preset list is empty (no invisible modal)", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("?", "?"), state({ field: "preset", presetCount: 0 }), actions);
    expect(calls).toEqual([]);
  });
});

describe("routeCustomizeKey (preset detail overlay)", () => {
  test("detail overlay is modal: j/k/Tab/chars are swallowed", () => {
    const { calls, actions } = tracker();
    for (const k of ["j", "k", "tab", "a"]) {
      routeCustomizeKey(keyEvent(k), state({ presetDetailOpen: true }), actions);
    }
    expect(calls).toEqual([]);
  });

  test("? dismisses the detail overlay", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("?", "?"), state({ presetDetailOpen: true }), actions);
    expect(calls).toEqual([{ name: "togglePresetDetail", args: [] }]);
  });

  test("Esc dismisses the detail overlay without going back", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("escape"), state({ presetDetailOpen: true }), actions);
    expect(calls).toEqual([{ name: "togglePresetDetail", args: [] }]);
  });

  test("q still quits while the detail overlay is open (escape hatch)", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("q"), state({ presetDetailOpen: true }), actions);
    expect(calls).toEqual([{ name: "onQuit", args: [] }]);
  });
});

describe("routeCustomizeKey (keymap field)", () => {
  test("h/l cycles choice", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("l"), state({ field: "keymap", keymap: "default" }), actions);
    routeCustomizeKey(keyEvent("l"), state({ field: "keymap", keymap: "power-user" }), actions);
    routeCustomizeKey(keyEvent("h"), state({ field: "keymap", keymap: "none" }), actions);
    expect(calls.map((c) => c.args[0])).toEqual(["power-user", "none", "power-user"]);
  });

  test("1/2/3 set choice directly", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("1"), state({ field: "keymap" }), actions);
    routeCustomizeKey(keyEvent("2"), state({ field: "keymap" }), actions);
    routeCustomizeKey(keyEvent("3"), state({ field: "keymap" }), actions);
    expect(calls.map((c) => c.args[0])).toEqual(["default", "power-user", "none"]);
  });

  test("Enter launches", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("return"), state({ field: "keymap" }), actions);
    expect(calls).toEqual([{ name: "launch", args: [] }]);
  });
});

// Burst sequences document the pending*Ref contract — the wire-up must
// update the ref synchronously so the NEXT router call sees the new state.
describe("routeCustomizeKey (rapid bursts)", () => {
  test("? then j: j is swallowed once the detail modal is open", () => {
    const { calls, actions } = tracker();
    let presetDetailOpen = false;
    const wrapped: CustomizeActions = {
      ...actions,
      togglePresetDetail: () => {
        presetDetailOpen = !presetDetailOpen;
        actions.togglePresetDetail();
      },
    };
    routeCustomizeKey(keyEvent("?", "?"), state({ presetDetailOpen, field: "preset" }), wrapped);
    routeCustomizeKey(keyEvent("j"), state({ presetDetailOpen, field: "preset" }), wrapped);
    expect(calls.map((c) => c.name)).toEqual(["togglePresetDetail"]);
  });

  test("Tab then l: l moves keymap cursor after field swap", () => {
    const { calls, actions } = tracker();
    const fieldHolder: { value: "preset" | "name" | "keymap" } = { value: "preset" };
    const wrapped: CustomizeActions = {
      ...actions,
      setField: (f) => {
        fieldHolder.value = f;
        actions.setField(f);
      },
    };
    routeCustomizeKey(
      keyEvent("tab"),
      state({ field: fieldHolder.value, keymap: "default" }),
      wrapped,
    );
    // Second Tab from name → keymap
    routeCustomizeKey(
      keyEvent("tab"),
      state({ field: fieldHolder.value, keymap: "default" }),
      wrapped,
    );
    routeCustomizeKey(
      keyEvent("l"),
      state({ field: fieldHolder.value, keymap: "default" }),
      wrapped,
    );
    expect(calls.map((c) => c.name)).toEqual(["setField", "setField", "setKeymap"]);
    expect<"preset" | "name" | "keymap">(fieldHolder.value).toBe("keymap");
    expect(calls.at(-1)?.args).toEqual(["power-user"]);
  });

  test("h then Enter in keymap: Enter reads the flipped keymap ref", () => {
    const { calls, actions } = tracker();
    const keymapHolder: { value: KeymapChoice } = { value: "default" };
    const wrapped: CustomizeActions = {
      ...actions,
      setKeymap: (c) => {
        keymapHolder.value = c;
        actions.setKeymap(c);
      },
    };
    routeCustomizeKey(
      keyEvent("h"),
      state({ field: "keymap", keymap: keymapHolder.value }),
      wrapped,
    );
    routeCustomizeKey(
      keyEvent("return"),
      state({ field: "keymap", keymap: keymapHolder.value }),
      wrapped,
    );
    expect(calls.map((c) => c.name)).toEqual(["setKeymap", "launch"]);
    // default → none (h wraps left).
    expect<KeymapChoice>(keymapHolder.value).toBe("none");
  });

  test("typing 'abc' then Enter in name field: Enter fires once name non-empty", () => {
    const { calls, actions } = tracker();
    let nameIsEmpty = true;
    const wrapped: CustomizeActions = {
      ...actions,
      appendNameChar: (c) => {
        nameIsEmpty = false;
        actions.appendNameChar(c);
      },
    };
    for (const ch of ["a", "b", "c"]) {
      routeCustomizeKey(keyEvent(ch), state({ field: "name", nameIsEmpty }), wrapped);
    }
    routeCustomizeKey(keyEvent("return"), state({ field: "name", nameIsEmpty }), wrapped);
    expect(calls.map((c) => c.name)).toEqual([
      "appendNameChar",
      "appendNameChar",
      "appendNameChar",
      "launch",
    ]);
  });
});
