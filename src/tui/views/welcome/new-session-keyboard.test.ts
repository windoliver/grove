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
    moveCursor: (d) => calls.push({ name: "moveCursor", args: [d] }),
    toggleDetail: () => calls.push({ name: "toggleDetail", args: [] }),
    onPick: (i) => calls.push({ name: "onPick", args: [i] }),
    onBack: () => calls.push({ name: "onBack", args: [] }),
    onQuit: () => calls.push({ name: "onQuit", args: [] }),
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
  test("j emits moveCursor(+1); k emits moveCursor(-1)", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("j"), state({ cursor: 0 }), actions);
    routeNewSessionKey(keyEvent("k"), state({ cursor: 0 }), actions);
    expect(calls.map((c) => [c.name, c.args[0]])).toEqual([
      ["moveCursor", 1],
      ["moveCursor", -1],
    ]);
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

  test("detail overlay is modal: j/k/Enter are swallowed while open", () => {
    const { calls, actions } = tracker();
    for (const k of ["j", "k", "return"]) {
      routeNewSessionKey(keyEvent(k), state({ detailOpen: true }), actions);
    }
    expect(calls).toEqual([]);
  });

  test("? dismisses detail overlay (not toggle nav)", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("?", "?"), state({ detailOpen: true }), actions);
    expect(calls).toEqual([{ name: "toggleDetail", args: [] }]);
  });

  test("Esc dismisses detail without going back", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("escape"), state({ detailOpen: true }), actions);
    expect(calls).toEqual([{ name: "toggleDetail", args: [] }]);
  });

  test("q still quits while detail is open (escape hatch)", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("q"), state({ detailOpen: true }), actions);
    expect(calls).toEqual([{ name: "onQuit", args: [] }]);
  });
});

// Burst sequences — if the wire-up updates the ref synchronously, the
// subsequent key must be routed under the new (modal-open) state.
describe("routeNewSessionKey (rapid bursts)", () => {
  test("? then j: j is swallowed once the detail modal is open", () => {
    const { calls, actions } = tracker();
    let detailOpen = false;
    const wrapped: NewSessionActions = {
      ...actions,
      toggleDetail: () => {
        detailOpen = !detailOpen;
        actions.toggleDetail();
      },
    };
    routeNewSessionKey(keyEvent("?", "?"), state({ detailOpen }), wrapped);
    routeNewSessionKey(keyEvent("j"), state({ detailOpen }), wrapped);
    expect(calls.map((c) => c.name)).toEqual(["toggleDetail"]);
  });

  test("j then Enter: Enter picks the post-nav cursor", () => {
    const { calls, actions } = tracker();
    let cursor = 0;
    const wrapped: NewSessionActions = {
      ...actions,
      moveCursor: (d) => {
        cursor = Math.max(0, Math.min(cursor + d, 2));
        actions.moveCursor(d);
      },
    };
    routeNewSessionKey(keyEvent("j"), state({ cursor }), wrapped);
    routeNewSessionKey(keyEvent("j"), state({ cursor }), wrapped);
    routeNewSessionKey(keyEvent("return"), state({ cursor }), wrapped);
    expect(calls.map((c) => c.name)).toEqual(["moveCursor", "moveCursor", "onPick"]);
    expect(calls.at(-1)?.args).toEqual([2]);
  });
});
