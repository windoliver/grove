import { describe, expect, test } from "bun:test";
import type { AgentHealth } from "./agent-health.js";
import {
  routeSupervisionKey,
  type SupervisionKeyboardActions,
  type SupervisionKeyboardState,
} from "./supervision-keyboard.js";

function calls() {
  const log: string[] = [];
  const actions: SupervisionKeyboardActions = {
    moveCursor: (delta) => log.push(`move:${delta}`),
    pinSelection: () => log.push("pin"),
    jumpTop: () => log.push("top"),
    jumpBottom: () => log.push("bottom"),
    approve: () => log.push("approve"),
    deny: () => log.push("deny"),
    always: () => log.push("always"),
    openTail: () => log.push("tail"),
    openDag: () => log.push("dag"),
    reroute: () => log.push("reroute"),
    kill: () => log.push("kill"),
    openMessage: () => log.push("msg"),
  };
  return { actions, log };
}

function state(over: Partial<SupervisionKeyboardState> = {}): SupervisionKeyboardState {
  return {
    selectedHealth: { kind: "running" } as AgentHealth,
    ...over,
  };
}

describe("routeSupervisionKey", () => {
  test("j moves cursor down, k moves up", () => {
    const { actions, log } = calls();
    routeSupervisionKey({ name: "j" }, state(), actions);
    routeSupervisionKey({ name: "k" }, state(), actions);
    expect(log).toEqual(["move:1", "move:-1"]);
  });

  test("y triggers approve only when health is approval", () => {
    const { actions: a1, log: l1 } = calls();
    routeSupervisionKey(
      { name: "y" },
      state({ selectedHealth: { kind: "approval", cmd: "rm" } }),
      a1,
    );
    expect(l1).toEqual(["approve"]);

    const { actions: a2, log: l2 } = calls();
    routeSupervisionKey({ name: "y" }, state(), a2);
    expect(l2).toEqual([]);
  });

  test("r triggers reroute only when blocked", () => {
    const { actions, log } = calls();
    routeSupervisionKey(
      { name: "r" },
      state({ selectedHealth: { kind: "blocked", on: "x", sinceMs: 9e5 } }),
      actions,
    );
    expect(log).toEqual(["reroute"]);
  });

  test("returns true when handled, false otherwise", () => {
    const { actions } = calls();
    expect(routeSupervisionKey({ name: "j" }, state(), actions)).toBe(true);
    expect(routeSupervisionKey({ name: "z" }, state(), actions)).toBe(false);
  });

  test("enter and return both call pinSelection", () => {
    const { actions, log } = calls();
    const r1 = routeSupervisionKey({ name: "enter" }, state(), actions);
    const r2 = routeSupervisionKey({ name: "return" }, state(), actions);
    expect(log).toEqual(["pin", "pin"]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  test("g jumps to top, G jumps to bottom", () => {
    const { actions, log } = calls();
    expect(routeSupervisionKey({ name: "g" }, state(), actions)).toBe(true);
    expect(routeSupervisionKey({ name: "G" }, state(), actions)).toBe(true);
    expect(log).toEqual(["top", "bottom"]);
  });

  test("n triggers deny when approval, returns false with no log otherwise", () => {
    const { actions: a1, log: l1 } = calls();
    const r1 = routeSupervisionKey(
      { name: "n" },
      state({ selectedHealth: { kind: "approval", cmd: "rm" } }),
      a1,
    );
    expect(l1).toEqual(["deny"]);
    expect(r1).toBe(true);

    const { actions: a2, log: l2 } = calls();
    const r2 = routeSupervisionKey({ name: "n" }, state(), a2);
    expect(l2).toEqual([]);
    expect(r2).toBe(false);
  });

  test("a triggers always when approval, returns false with no log otherwise", () => {
    const { actions: a1, log: l1 } = calls();
    const r1 = routeSupervisionKey(
      { name: "a" },
      state({ selectedHealth: { kind: "approval", cmd: "rm" } }),
      a1,
    );
    expect(l1).toEqual(["always"]);
    expect(r1).toBe(true);

    const { actions: a2, log: l2 } = calls();
    const r2 = routeSupervisionKey({ name: "a" }, state(), a2);
    expect(l2).toEqual([]);
    expect(r2).toBe(false);
  });

  test("t triggers openTail for any health, false when no selection", () => {
    const { actions: a1, log: l1 } = calls();
    const r1 = routeSupervisionKey({ name: "t" }, state(), a1);
    expect(l1).toEqual(["tail"]);
    expect(r1).toBe(true);

    const { actions: a2, log: l2 } = calls();
    const r2 = routeSupervisionKey({ name: "t" }, state({ selectedHealth: undefined }), a2);
    expect(l2).toEqual([]);
    expect(r2).toBe(false);
  });

  test("d triggers openDag for any health, false when no selection", () => {
    const { actions: a1, log: l1 } = calls();
    const r1 = routeSupervisionKey({ name: "d" }, state(), a1);
    expect(l1).toEqual(["dag"]);
    expect(r1).toBe(true);

    const { actions: a2, log: l2 } = calls();
    const r2 = routeSupervisionKey({ name: "d" }, state({ selectedHealth: undefined }), a2);
    expect(l2).toEqual([]);
    expect(r2).toBe(false);
  });

  test("m triggers openMessage for any health", () => {
    const { actions, log } = calls();
    const r = routeSupervisionKey({ name: "m" }, state(), actions);
    expect(log).toEqual(["msg"]);
    expect(r).toBe(true);
  });

  test("K triggers kill when not expired, returns false when expired", () => {
    const { actions: a1, log: l1 } = calls();
    const r1 = routeSupervisionKey({ name: "K" }, state(), a1);
    expect(l1).toEqual(["kill"]);
    expect(r1).toBe(true);

    const { actions: a2, log: l2 } = calls();
    const r2 = routeSupervisionKey(
      { name: "K" },
      state({ selectedHealth: { kind: "expired" } }),
      a2,
    );
    expect(l2).toEqual([]);
    expect(r2).toBe(false);
  });

  test("r gated-fail: running health returns false with no log", () => {
    const { actions, log } = calls();
    const r = routeSupervisionKey({ name: "r" }, state(), actions);
    expect(log).toEqual([]);
    expect(r).toBe(false);
  });

  test("gated key with selectedHealth undefined returns false", () => {
    const { actions, log } = calls();
    const r = routeSupervisionKey({ name: "y" }, state({ selectedHealth: undefined }), actions);
    expect(log).toEqual([]);
    expect(r).toBe(false);
  });
});
