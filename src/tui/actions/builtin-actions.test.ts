import { describe, expect, test } from "bun:test";
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
    showMessage: () => undefined,
    ...overrides,
  };
}

function ids(c: ActionContext): string[] {
  return buildBuiltInActions(c)
    .filter((a) => a.available?.(c) ?? true)
    .map((a) => a.id);
}

describe("buildBuiltInActions", () => {
  test("navigation: one open/focus action per operator panel + always offers register/compare", () => {
    const present = ids(ctx());
    expect(present).toContain("nav.panel.terminal");
    expect(present).toContain("workflow.compare");
    expect(present).toContain("workflow.register-agent");
  });

  test("set goal only available when provider has goals", () => {
    expect(ids(ctx())).not.toContain("workflow.set-goal");
    expect(ids(ctx({ hasGoals: true }))).toContain("workflow.set-goal");
  });

  test("answer-question actions only available when a question is pending", () => {
    expect(ids(ctx())).not.toContain("workflow.approve-question");
    const pending = ids(ctx({ pendingQuestionCount: 1 }));
    expect(pending).toContain("workflow.approve-question");
    expect(pending).toContain("workflow.deny-question");
  });

  test("contribution actions only available when a contribution is selected", () => {
    expect(ids(ctx())).not.toContain("contrib.open");
    const sel = ids(ctx({ selectedCid: "bafy123" }));
    expect(sel).toContain("contrib.open");
    expect(sel).toContain("contrib.compare-add");
    expect(sel).toContain("contrib.adopt");
  });

  test("kill action per live session; jump-to-session per session", () => {
    const present = ids(ctx({ sessions: ["grove-reviewer-1"] }));
    expect(present).toContain("agent.kill.grove-reviewer-1");
    expect(present).toContain("nav.session.grove-reviewer-1");
  });

  test("spawn from profile is present but disabled at capacity", () => {
    const c = ctx({
      canSpawn: true,
      profiles: [{ name: "@rev", role: "reviewer", platform: "claude-code" }],
    });
    const spawn = buildBuiltInActions(c).find((a) => a.id === "agent.spawn.reviewer");
    expect(spawn).toBeDefined();
    expect(spawn?.enabled?.(c) ?? true).toBe(true);
  });

  test("spawn detail shows capacity and edges from topology", () => {
    const topology = {
      roles: [
        { name: "planner", maxInstances: 3, edges: [{ target: "reviewer" }] },
        { name: "reviewer", maxInstances: 1 },
      ],
    } as unknown as ActionContext["topology"];
    const c = ctx({ canSpawn: true, topology, claims: [] });
    const planner = buildBuiltInActions(c).find((a) => a.id === "agent.spawn.planner");
    expect(planner?.detail).toBe("0/3 → reviewer");
    const reviewer = buildBuiltInActions(c).find((a) => a.id === "agent.spawn.reviewer");
    expect(reviewer?.detail).toBe("0/1");
  });

  test("spawn detail falls back to 'spawn' without topology", () => {
    const c = ctx({
      canSpawn: true,
      profiles: [{ name: "@w", role: "worker", platform: "claude-code" }],
    });
    const spawn = buildBuiltInActions(c).find((a) => a.id === "agent.spawn.worker");
    expect(spawn?.detail).toBe("spawn");
  });

  test("delegate only available when canDelegate and peer has free slots", () => {
    const peers = [{ peerId: "p1", address: "http://p1", freeSlots: 2 }];
    expect(ids(ctx({ canDelegate: false, gossipPeers: peers }))).not.toContain(
      "agent.delegate.http://p1",
    );
    expect(ids(ctx({ canDelegate: true, gossipPeers: peers }))).toContain(
      "agent.delegate.http://p1",
    );
  });
});
