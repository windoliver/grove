import { describe, expect, test } from "bun:test";
import type { AgentTaskEntity, AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase, agentTaskViewToEntity } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { WorktreeExclusivityFilter } from "./worktree-exclusivity.js";

function view(id: string, worktree: string, phase: AgentTaskPhase): AgentTaskView {
  return {
    spec: {
      id,
      worktree,
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    },
    status: {
      id,
      phase,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function ctxWith(task: AgentTaskView, others: readonly AgentTaskView[]): SchedulerContext {
  const entities: AgentTaskEntity[] = [task, ...others].map((v) => agentTaskViewToEntity(v));
  return {
    task,
    profiles: [],
    store: { listAgentTaskEntities: async () => entities, getAgentTask: async () => undefined },
    now: () => 0,
  };
}

const profile: RuntimeProfile = { name: "p", platform: "claude-code", runtimeCommand: "claude" };

describe("WorktreeExclusivityFilter", () => {
  const filter = new WorktreeExclusivityFilter();

  test("admits when no other task shares the worktree", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.PendingBind);
    const verdict = await filter.filter(ctxWith(task, []), profile);
    expect(verdict).toEqual({ admit: true });
  });

  test("rejects when another Running task shares the worktree", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.PendingBind);
    const other = view("other", "/w/a", AgentTaskPhase.Running);
    const verdict = await filter.filter(ctxWith(task, [other]), profile);
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) {
      expect(verdict.reason).toBe("worktree-busy");
      expect(verdict.message).toContain("other");
    }
  });

  test("admits when other task on same worktree is Succeeded", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.PendingBind);
    const other = view("other", "/w/a", AgentTaskPhase.Succeeded);
    const verdict = await filter.filter(ctxWith(task, [other]), profile);
    expect(verdict).toEqual({ admit: true });
  });

  test("admits when other Running task is on a different worktree", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.PendingBind);
    const other = view("other", "/w/b", AgentTaskPhase.Running);
    const verdict = await filter.filter(ctxWith(task, [other]), profile);
    expect(verdict).toEqual({ admit: true });
  });

  test("admits when the only Running task on the worktree is the task itself", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.Running);
    const verdict = await filter.filter(ctxWith(task, []), profile);
    expect(verdict).toEqual({ admit: true });
  });
});
