import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  type NewSessionActions,
  type NewSessionState,
  routeNewSessionKey,
} from "./new-session-keyboard.js";

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
  const actions: NewSessionActions = {
    setCursor: (n) => calls.push({ name: "setCursor", args: [n] }),
    toggleDetail: () => calls.push({ name: "toggleDetail", args: [] }),
    onPick: (i) => calls.push({ name: "onPick", args: [i] }),
    onBack: () => calls.push({ name: "onBack", args: [] }),
  };
  return { calls, actions };
}

const state = (over: Partial<NewSessionState> = {}): NewSessionState => ({
  cursor: 0,
  presetCount: 3,
  detailOpen: false,
  ...over,
});

describe("routeNewSessionKey", () => {
  test("j/k move cursor with clamp", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("j"), state({ cursor: 0 }), actions);
    routeNewSessionKey(keyEvent("j"), state({ cursor: 2 }), actions);
    routeNewSessionKey(keyEvent("k"), state({ cursor: 0 }), actions);
    expect(calls.map((c) => c.args[0])).toEqual([1, 2, 0]);
  });

  test("Enter picks focused preset index", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("return"), state({ cursor: 2 }), actions);
    expect(calls).toEqual([{ name: "onPick", args: [2] }]);
  });

  test("? toggles detail", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("?", "?"), state(), actions);
    expect(calls).toEqual([{ name: "toggleDetail", args: [] }]);
  });

  test("Esc goes back", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("escape"), state(), actions);
    expect(calls).toEqual([{ name: "onBack", args: [] }]);
  });
});
