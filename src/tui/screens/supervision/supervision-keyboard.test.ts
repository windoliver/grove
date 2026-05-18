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
    fleetSize: 3,
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
});
