/**
 * Render-level tests for CommandPalette — mounts the real component via
 * react-test-renderer and inspects emitted <text> nodes. Exercises the
 * builders → computeVisibleActions → grouped/flat render pipeline end to end,
 * covering the #194 acceptance criteria that are observable in the output:
 * grouped sections, query collapsing groups, greyed disabled items, and
 * context-sensitive actions appearing only when relevant.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { buildBuiltInActions } from "../actions/builtin-actions.js";
import { spawnSource } from "../actions/dynamic-sources.js";
import type { ActionContext } from "../actions/types.js";
import { theme } from "../theme.js";
import { CommandPalette } from "./command-palette.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/**
 * Collect every string fragment rendered inside <text> nodes, joined with "".
 * Joining with "" matters: under an active query, a matched label is split into
 * highlighted/unhighlighted <text> runs, so a space separator would break the
 * contiguous label string. "" reconstructs it.
 */
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

/** Find all <text> nodes whose direct text contains `needle`, return their color prop. */
function colorsForLabel(node: TestRenderer.ReactTestRendererJSON, needle: string): string[] {
  const colors: string[] = [];
  const textOf = (n: TestRenderer.ReactTestRendererJSON): string => {
    const parts: string[] = [];
    for (const c of n.children ?? []) {
      if (typeof c === "string") parts.push(c);
    }
    return parts.join("");
  };
  const walk = (n: TestRenderer.ReactTestRendererJSON | string): void => {
    if (typeof n === "string") return;
    if (n.type === "text" && textOf(n).includes(needle)) {
      colors.push(n.props?.color as string);
    }
    for (const c of n.children ?? []) walk(c as TestRenderer.ReactTestRendererJSON | string);
  };
  walk(node);
  return colors;
}

function render(props: {
  actions: ReturnType<typeof buildBuiltInActions>;
  ctx: ActionContext;
  query?: string;
  selectedIndex?: number;
}): TestRenderer.ReactTestRendererJSON {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(CommandPalette, {
        visible: true,
        actions: props.actions,
        ctx: props.ctx,
        query: props.query,
        selectedIndex: props.selectedIndex,
      }),
    );
  });
  const json = renderer.toJSON();
  renderer.unmount();
  if (json === null || Array.isArray(json)) throw new Error("unexpected render output");
  return json;
}

describe("CommandPalette render (#194)", () => {
  test("no query: renders group section headers", () => {
    const c = ctx({ hasGoals: true });
    const text = allText(render({ actions: buildBuiltInActions(c), ctx: c }));
    // Section headers (rendered as their own bold <text>).
    expect(text).toContain("Navigation");
    expect(text).toContain("Workflow");
    // Built-in actions present.
    expect(text).toContain("Set goal");
    expect(text).toContain("Go to Terminal panel");
  });

  test("renders the View group + messaging/system actions", () => {
    const c = ctx();
    const text = allText(render({ actions: buildBuiltInActions(c), ctx: c }));
    expect(text).toContain("View");
    expect(text).toContain("Refresh all data");
    expect(text).toContain("Quit grove");
    expect(text).toContain("Broadcast message to all agents");
  });

  test("query collapses groups to a flat ranked list (no headers)", () => {
    const c = ctx({ hasGoals: true });
    const json = render({ actions: buildBuiltInActions(c), ctx: c, query: "goal" });
    const text = allText(json);
    // The matching action is present...
    expect(text).toContain("Set goal");
    // ...and the "Navigation" section header is gone under an active query.
    expect(text).not.toContain("Navigation");
  });

  test("context-sensitive: contribution actions appear only when a cid is selected", () => {
    const without = allText(render({ actions: buildBuiltInActions(ctx()), ctx: ctx() }));
    expect(without).not.toContain("Open selected contribution");

    const withSel = ctx({ selectedCid: "bafy123" });
    const text = allText(render({ actions: buildBuiltInActions(withSel), ctx: withSel }));
    expect(text).toContain("Open selected contribution");
    expect(text).toContain("Contributions");
  });

  test("disabled action renders greyed (theme.disabled)", () => {
    // canSpawn + a profile + a topology at capacity → spawn present but disabled.
    const topology = {
      roles: [{ name: "reviewer", maxInstances: 0 }],
    } as unknown as ActionContext["topology"];
    const c = ctx({
      canSpawn: true,
      topology,
      claims: [],
      profiles: [{ name: "@rev", role: "reviewer", platform: "claude-code" }],
    });
    // Spawn actions are now dynamic (#275) — include spawnSource alongside statics.
    const actions = [...buildBuiltInActions(c), ...spawnSource(c)];
    const spawn = actions.find((a) => a.id === "agent.spawn.reviewer");
    // Sanity: this action is indeed disabled in this context.
    expect(spawn?.enabled?.(c)).toBe(false);
    const json = render({ actions, ctx: c, selectedIndex: -1 });
    const colors = colorsForLabel(json, "Spawn @rev");
    expect(colors).toContain(theme.disabled);
  });
});
