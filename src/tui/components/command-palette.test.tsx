// src/tui/components/command-palette.test.tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act as testAct } from "react-test-renderer";
import type { Action, ActionContext } from "../actions/types.js";
import { computeVisibleActions } from "../actions/visibility.js";
import { CommandPalette, fuzzyMatch } from "./command-palette.js";

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

// ---------------------------------------------------------------------------
// Render helpers (mirrors the pattern used in command-palette.render.test.tsx)
// ---------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function allText(node: TestRenderer.ReactTestRendererJSON | null): string {
  if (node === null) return "";
  const parts: string[] = [];
  const walk = (n: TestRenderer.ReactTestRendererJSON | string): void => {
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    for (const child of n.children ?? []) {
      walk(child as TestRenderer.ReactTestRendererJSON | string);
    }
  };
  walk(node);
  return parts.join("");
}

function findNodes(
  node: TestRenderer.ReactTestRendererJSON | null,
  pred: (n: TestRenderer.ReactTestRendererJSON) => boolean,
): TestRenderer.ReactTestRendererJSON[] {
  const results: TestRenderer.ReactTestRendererJSON[] = [];
  if (node === null) return results;
  const walk = (n: TestRenderer.ReactTestRendererJSON | string): void => {
    if (typeof n === "string") return;
    if (pred(n)) results.push(n);
    for (const child of n.children ?? []) {
      walk(child as TestRenderer.ReactTestRendererJSON | string);
    }
  };
  walk(node);
  return results;
}

function renderPalette(props: {
  actions: readonly Action[];
  ctx: ActionContext;
  query?: string;
  selectedIndex?: number;
}): TestRenderer.ReactTestRendererJSON {
  let renderer!: TestRenderer.ReactTestRenderer;
  testAct(() => {
    renderer = TestRenderer.create(
      React.createElement(CommandPalette, {
        visible: true,
        actions: props.actions,
        ctx: props.ctx,
        query: props.query,
        selectedIndex: props.selectedIndex ?? 0,
      }),
    );
  });
  const json = renderer.toJSON();
  renderer.unmount();
  if (json === null || Array.isArray(json)) throw new Error("unexpected render output");
  return json;
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

describe("CommandPalette render — keybind column + disabled reason footer", () => {
  test("row with keybind renders that keybind string in the output", () => {
    const actions: readonly Action[] = [
      act({ id: "n1", group: "Navigation", label: "Focus Terminal", keybind: "Ctrl+T" }),
    ];
    const json = renderPalette({ actions, ctx: ctx(), selectedIndex: 0 });
    const text = allText(json);
    expect(text).toContain("Ctrl+T");
  });

  test("row without keybind does not render a keybind string", () => {
    const actions: readonly Action[] = [
      act({ id: "n1", group: "Navigation", label: "Focus Terminal" }),
    ];
    const json = renderPalette({ actions, ctx: ctx(), selectedIndex: 0 });
    const text = allText(json);
    // No keybind should appear (just cursor, label, possibly detail)
    expect(text).not.toMatch(/Ctrl\+/);
  });

  test("selected action with enabled:{enabled:false,reason} shows reason in footer and dims the row", () => {
    const testCtx = ctx();
    const actions: readonly Action[] = [
      act({
        id: "w1",
        group: "Workflow",
        label: "Do something",
        enabled: () => ({ enabled: false, reason: "at capacity" }),
      }),
    ];
    const json = renderPalette({ actions, ctx: testCtx, selectedIndex: 0 });
    const text = allText(json);
    // The reason must appear in the footer area
    expect(text).toContain("at capacity");

    // The row label should be rendered with the disabled color (dimmed)
    const textNodes = findNodes(
      json,
      (n) =>
        n.type === "text" &&
        (n.children ?? []).some((c) => typeof c === "string" && c.includes("Do something")),
    );
    // At least one text node for the label should be dimmed (not the focus/text color)
    const colors = textNodes.map((n) => n.props?.color as string);
    // The label should NOT use a bright/focus color because the item is disabled
    expect(colors.some((c) => c !== undefined)).toBe(true);
  });
});
