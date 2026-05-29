import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import { buildBuiltInActions } from "./builtin-actions.js";
import type { ActionContext } from "./types.js";

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
    enterTerminalInput: () => undefined,
    artifactPrev: () => undefined,
    artifactNext: () => undefined,
    artifactDiffToggle: () => undefined,
    artifactDiffModeToggle: () => undefined,
    cursorDown: () => undefined,
    cursorUp: () => undefined,
    selectRow: () => undefined,
    pageNext: () => undefined,
    pagePrev: () => undefined,
    vfsNavigate: () => undefined,
    terminalScrollUp: () => undefined,
    terminalScrollDown: () => undefined,
    compareSelect: () => undefined,
    compareAdoptA: () => undefined,
    compareAdoptB: () => undefined,
    frontierAdopt: () => undefined,
    openPalette: () => undefined,
    runPrompt: () => undefined,
    ...overrides,
  };
}

function ids(c: ActionContext): string[] {
  return buildBuiltInActions(c)
    .filter((a) => a.available?.(c) ?? true)
    .map((a) => a.id);
}

describe("buildBuiltInActions", () => {
  test("navigation: open/focus action per core AND operator panel + register/compare", () => {
    const present = ids(ctx());
    // Operator panel
    expect(present).toContain("nav.panel.terminal");
    // Core panels are reachable too (always-visible → focus)
    expect(present).toContain("nav.panel.dag");
    expect(present).toContain("nav.panel.frontier");
    expect(present).toContain("workflow.compare");
    expect(present).toContain("workflow.register-agent");
  });

  test("set goal only available when provider has goals", () => {
    expect(ids(ctx())).not.toContain("workflow.set-goal");
    expect(ids(ctx({ hasGoals: true }))).toContain("workflow.set-goal");
  });

  test("approve/deny only with exactly one pending; multiple routes to Decisions review", () => {
    // None pending → no question actions at all.
    const none = ids(ctx());
    expect(none).not.toContain("workflow.approve-question");
    expect(none).not.toContain("workflow.review-questions");
    // Exactly one → unambiguous approve/deny, no review-routing.
    const one = ids(ctx({ pendingQuestionCount: 1 }));
    expect(one).toContain("workflow.approve-question");
    expect(one).toContain("workflow.deny-question");
    expect(one).not.toContain("workflow.review-questions");
    // Multiple → no blind approve/deny; route to the Decisions panel instead.
    const many = ids(ctx({ pendingQuestionCount: 3 }));
    expect(many).not.toContain("workflow.approve-question");
    expect(many).not.toContain("workflow.deny-question");
    expect(many).toContain("workflow.review-questions");
  });

  test("contribution actions only available when a contribution is selected", () => {
    expect(ids(ctx())).not.toContain("contrib.open");
    const sel = ids(ctx({ selectedCid: "bafy123" }));
    expect(sel).toContain("contrib.open");
    expect(sel).toContain("contrib.compare-add");
    expect(sel).toContain("contrib.adopt");
  });

  test("contrib.adopt runs adoptContribution with the selected cid (summary resolved by app)", () => {
    const calls: string[] = [];
    const c = ctx({ selectedCid: "bafySEL", adoptContribution: (cid) => calls.push(cid) });
    const adopt = buildBuiltInActions(c).find((a) => a.id === "contrib.adopt");
    adopt?.run(c);
    expect(calls).toEqual(["bafySEL"]);
  });

  test("contrib.open is disabled when the highlighted cid is already the open detail", () => {
    const open = buildBuiltInActions(ctx()).find((a) => a.id === "contrib.open");
    // Highlighted row differs from open detail (or no detail) → enabled.
    expect(open?.enabled?.(ctx({ selectedCid: "bafyAAA", detailCid: undefined }))).toBe(true);
    expect(open?.enabled?.(ctx({ selectedCid: "bafyAAA", detailCid: "bafyBBB" }))).toBe(true);
    // Highlighted row IS the open detail → disabled (re-open would duplicate).
    expect(open?.enabled?.(ctx({ selectedCid: "bafyAAA", detailCid: "bafyAAA" }))).toBe(false);
  });

  // NOTE: per-entity action tests (session nav, spawn capacity/detail/de-dupe,
  // kill, delegate) moved to dynamic-sources.test.ts — those actions are now
  // emitted by dynamic sources, not buildBuiltInActions.

  test("messaging actions are always offered in the Agents group", () => {
    const actions = buildBuiltInActions(ctx());
    const broadcast = actions.find((a) => a.id === "agent.broadcast");
    const dm = actions.find((a) => a.id === "agent.direct-message");
    expect(broadcast?.group).toBe("Agents");
    expect(dm?.group).toBe("Agents");
    expect(ids(ctx())).toEqual(expect.arrayContaining(["agent.broadcast", "agent.direct-message"]));
  });

  test("view/system actions are always offered in the View group", () => {
    const actions = buildBuiltInActions(ctx());
    for (const id of [
      "view.refresh",
      "view.search",
      "view.zoom",
      "view.zoom-reset",
      "view.layout",
      "view.view-mode",
      "view.help",
      "view.quit",
    ]) {
      const action = actions.find((a) => a.id === id);
      expect(action, id).toBeDefined();
      expect(action?.group).toBe("View");
    }
  });

  test("frontier-slice actions appear only when Frontier focused with >1 slice", () => {
    expect(ids(ctx())).not.toContain("nav.frontier.next-slice");
    // Focused but only one slice → still hidden.
    expect(ids(ctx({ focusedPanel: Panel.Frontier, frontierSliceCount: 1 }))).not.toContain(
      "nav.frontier.next-slice",
    );
    const focused = ids(ctx({ focusedPanel: Panel.Frontier, frontierSliceCount: 3 }));
    expect(focused).toContain("nav.frontier.next-slice");
    expect(focused).toContain("nav.frontier.prev-slice");
  });

  test("terminal scroll-to-bottom appears only when Terminal focused", () => {
    expect(ids(ctx())).not.toContain("nav.terminal.scroll-bottom");
    expect(ids(ctx({ focusedPanel: Panel.Terminal }))).toContain("nav.terminal.scroll-bottom");
  });

  test("panel-cycle and help actions are offered", () => {
    const present = ids(ctx());
    expect(present).toContain("nav.panel.next");
    expect(present).toContain("nav.panel.prev");
    expect(present).toContain("view.help");
  });

  test("static catalog ids are unique", () => {
    const all = buildBuiltInActions(ctx()).map((a) => a.id);
    expect(new Set(all).size).toBe(all.length);
  });
});
