import { describe, expect, test } from "bun:test";
import type { Action, ActionContext } from "./types.js";
import { computeVisibleActions } from "./visibility.js";

// Minimal ctx — only fields read by these actions matter.
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

describe("computeVisibleActions", () => {
  test("no query: hides unavailable, orders by group", () => {
    const actions: Action[] = [
      act({ id: "p1", group: "Plugins", label: "plugin one" }),
      act({ id: "n1", group: "Navigation", label: "nav one" }),
      act({ id: "hidden", group: "Agents", label: "hidden", available: () => false }),
    ];
    const visible = computeVisibleActions(actions, ctx(), "");
    expect(visible.map((v) => v.action.id)).toEqual(["n1", "p1"]);
    expect(visible[0]?.matchedIndices).toEqual([]);
  });

  test("query: flat ranked, matches label or keywords", () => {
    const actions: Action[] = [
      act({ id: "terminal", group: "Navigation", label: "Focus Terminal" }),
      act({ id: "vfs", group: "Navigation", label: "Focus VFS", keywords: ["files"] }),
    ];
    const visible = computeVisibleActions(actions, ctx(), "files");
    expect(visible.map((v) => v.action.id)).toEqual(["vfs"]);
  });

  test("query: still respects available()", () => {
    const actions: Action[] = [
      act({ id: "x", group: "Workflow", label: "answer question", available: () => false }),
    ];
    expect(computeVisibleActions(actions, ctx(), "answer")).toHaveLength(0);
  });
});
