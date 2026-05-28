// src/tui/components/command-palette.test.tsx
import { describe, expect, test } from "bun:test";
import type { Action, ActionContext } from "../actions/types.js";
import { computeVisibleActions } from "../actions/visibility.js";
import { fuzzyMatch } from "./command-palette.js";

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    sessions: [],
    profiles: [],
    gossipPeers: [],
    claims: [],
    pendingQuestionCount: 0,
    hasGoals: false,
    canSpawn: false,
    canDelegate: false,
    isPanelVisible: () => false,
    focusPanel: () => undefined,
    togglePanel: () => undefined,
    cyclePanelNext: () => undefined,
    cyclePanelPrev: () => undefined,
    openContribution: () => undefined,
    jumpToSession: () => undefined,
    enterGoalMode: () => undefined,
    enterCompareMode: () => undefined,
    addToCompare: () => undefined,
    adoptContribution: () => undefined,
    answerPendingQuestion: () => undefined,
    registerAgentProfile: () => undefined,
    spawn: () => undefined,
    kill: () => undefined,
    delegate: () => undefined,
    focusedPanel: 1,
    frontierSliceCount: 1,
    broadcastMessage: () => undefined,
    directMessage: () => undefined,
    refresh: () => undefined,
    enterSearch: () => undefined,
    cycleZoom: () => undefined,
    resetZoom: () => undefined,
    toggleLayout: () => undefined,
    cycleViewMode: () => undefined,
    showHelp: () => undefined,
    quit: () => undefined,
    nextFrontierSlice: () => undefined,
    prevFrontierSlice: () => undefined,
    scrollTerminalToBottom: () => undefined,
    showMessage: () => undefined,
    ...overrides,
  };
}
function act(o: Partial<Action> & Pick<Action, "id" | "group">): Action {
  return { label: o.id, detail: "", run: () => undefined, ...o };
}

describe("command palette model", () => {
  test("fuzzyMatch still scores word-boundary bonuses", () => {
    expect(fuzzyMatch("ft", "Focus Terminal").match).toBe(true);
    expect(fuzzyMatch("zzz", "Focus Terminal").match).toBe(false);
  });

  test("visible list is the flat selection index space", () => {
    const actions = [
      act({ id: "n1", group: "Navigation", label: "nav" }),
      act({ id: "a1", group: "Agents", label: "agent" }),
    ];
    const visible = computeVisibleActions(actions, ctx(), "");
    expect(visible.map((v) => v.action.id)).toEqual(["n1", "a1"]);
  });
});
