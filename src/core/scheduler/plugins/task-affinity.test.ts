import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { TaskAffinityScore } from "./task-affinity.js";

function ctxWith(task: AgentTaskView): SchedulerContext {
  return { task, profiles: [], store: { listAgentTaskEntities: async () => [] }, now: () => 0 };
}

function task(
  overrides: { runtime?: string; affinity?: Readonly<Record<string, string>> } = {},
): AgentTaskView {
  return {
    spec: {
      id: "t",
      worktree: "/tmp/w",
      runtime: overrides.runtime ?? "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...(overrides.affinity === undefined ? {} : { budget: { affinity: overrides.affinity } }),
    },
    status: {
      id: "t",
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function profile(labels?: Record<string, string>): RuntimeProfile {
  return {
    name: "p",
    platform: "claude-code",
    runtimeCommand: "claude",
    ...(labels === undefined ? {} : { labels }),
  };
}

describe("TaskAffinityScore", () => {
  const score = new TaskAffinityScore();

  test("returns 100 when every requested label matches", async () => {
    const value = await score.score(
      ctxWith(task({ affinity: { tier: "premium", region: "us" } })),
      profile({ tier: "premium", region: "us" }),
    );
    expect(value).toBe(100);
  });

  test("returns 50 when half the requested labels match", async () => {
    const value = await score.score(
      ctxWith(task({ affinity: { tier: "premium", region: "us" } })),
      profile({ tier: "premium", region: "eu" }),
    );
    expect(value).toBe(50);
  });

  test("returns 0 when no requested labels match", async () => {
    const value = await score.score(
      ctxWith(task({ affinity: { tier: "premium" } })),
      profile({ tier: "free" }),
    );
    expect(value).toBe(0);
  });

  test("returns neutral 50 when no affinity requested and no runtime hint", async () => {
    const value = await score.score(ctxWith(task({ runtime: "" })), profile());
    expect(value).toBe(50);
  });

  test("derives default affinity from task.spec.runtime when budget.affinity absent", async () => {
    const match = await score.score(ctxWith(task({ runtime: "claude" })), profile({ runtime: "claude" }));
    const miss = await score.score(ctxWith(task({ runtime: "claude" })), profile({ runtime: "codex" }));
    expect(match).toBe(100);
    expect(miss).toBe(0);
  });
});
