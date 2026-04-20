import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  type FastPathActions,
  type FastPathState,
  routeFastPathKey,
} from "./fast-path-keyboard.js";

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

function defaultState(over: Partial<FastPathState> = {}): FastPathState {
  return {
    cursor: 0,
    visibleSessionIds: ["s1", "s2", "s3"],
    filterMode: false,
    archiveVisible: false,
    ...over,
  };
}

function tracker() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const actions: FastPathActions = {
    setCursor: (n) => calls.push({ name: "setCursor", args: [n] }),
    enterFilter: () => calls.push({ name: "enterFilter", args: [] }),
    exitFilter: () => calls.push({ name: "exitFilter", args: [] }),
    commitFilter: () => calls.push({ name: "commitFilter", args: [] }),
    appendFilterChar: (c) => calls.push({ name: "appendFilterChar", args: [c] }),
    deleteFilterChar: () => calls.push({ name: "deleteFilterChar", args: [] }),
    toggleArchive: () => calls.push({ name: "toggleArchive", args: [] }),
    onResume: (id) => calls.push({ name: "onResume", args: [id] }),
    onNewSession: () => calls.push({ name: "onNewSession", args: [] }),
    onConnect: () => calls.push({ name: "onConnect", args: [] }),
    onQuit: () => calls.push({ name: "onQuit", args: [] }),
  };
  return { calls, actions };
}

describe("routeFastPathKey (navigation)", () => {
  test("j moves cursor down, clamped", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("j"), defaultState({ cursor: 0 }), actions);
    expect(calls).toEqual([{ name: "setCursor", args: [1] }]);

    routeFastPathKey(keyEvent("j"), defaultState({ cursor: 2 }), actions);
    // clamped at last index
    expect(calls[1]).toEqual({ name: "setCursor", args: [2] });
  });

  test("k moves cursor up, clamped at 0", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("k"), defaultState({ cursor: 0 }), actions);
    expect(calls[0]).toEqual({ name: "setCursor", args: [0] });
  });

  test("down/up arrow mirror j/k", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("down"), defaultState({ cursor: 0 }), actions);
    routeFastPathKey(keyEvent("up"), defaultState({ cursor: 1 }), actions);
    expect(calls.map((c) => c.name)).toEqual(["setCursor", "setCursor"]);
  });
});

describe("routeFastPathKey (actions)", () => {
  test("Enter calls onResume with focused id", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("return"),
      defaultState({ cursor: 1 }),
      actions,
    );
    expect(calls).toEqual([{ name: "onResume", args: ["s2"] }]);
  });

  test("Enter on empty list is a no-op", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("return"),
      defaultState({ visibleSessionIds: [] }),
      actions,
    );
    expect(calls).toEqual([]);
  });

  test("n triggers onNewSession (outside filter)", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("n"), defaultState(), actions);
    expect(calls).toEqual([{ name: "onNewSession", args: [] }]);
  });

  test("c triggers onConnect", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("c"), defaultState(), actions);
    expect(calls).toEqual([{ name: "onConnect", args: [] }]);
  });

  test("q triggers onQuit", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("q"), defaultState(), actions);
    expect(calls).toEqual([{ name: "onQuit", args: [] }]);
  });

  test("a toggles archive visibility", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("a"), defaultState(), actions);
    expect(calls).toEqual([{ name: "toggleArchive", args: [] }]);
  });
});

describe("routeFastPathKey (filter mode)", () => {
  test("'/' enters filter mode", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("slash", "/"), defaultState(), actions);
    expect(calls).toEqual([{ name: "enterFilter", args: [] }]);
  });

  test("printable input in filter mode appends to filter text", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("a"),
      defaultState({ filterMode: true }),
      actions,
    );
    expect(calls).toEqual([{ name: "appendFilterChar", args: ["a"] }]);
  });

  test("backspace in filter mode pops one char", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("backspace"),
      defaultState({ filterMode: true }),
      actions,
    );
    expect(calls).toEqual([{ name: "deleteFilterChar", args: [] }]);
  });

  test("Esc in filter mode exits and clears text", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("escape"),
      defaultState({ filterMode: true }),
      actions,
    );
    expect(calls).toEqual([{ name: "exitFilter", args: [] }]);
  });

  test("Enter in filter mode commits (keeps text, exits mode)", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("return"),
      defaultState({ filterMode: true }),
      actions,
    );
    expect(calls).toEqual([{ name: "commitFilter", args: [] }]);
  });

  test("n in filter mode is treated as filter text, not new-session", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("n"),
      defaultState({ filterMode: true }),
      actions,
    );
    expect(calls).toEqual([{ name: "appendFilterChar", args: ["n"] }]);
  });

  test("space in filter mode appends a space char", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("space"),
      defaultState({ filterMode: true }),
      actions,
    );
    expect(calls).toEqual([{ name: "appendFilterChar", args: [" "] }]);
  });
});
