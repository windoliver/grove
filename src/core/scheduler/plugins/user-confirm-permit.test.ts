import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import { InMemoryPermitDecisionStore, UserConfirmPermit } from "./user-confirm-permit.js";

function ctx(task: AgentTaskView): SchedulerContext {
  return {
    task,
    profiles: [],
    store: { listAgentTaskEntities: async () => [], getAgentTask: async () => undefined },
    now: () => 0,
  };
}

const task: AgentTaskView = {
  spec: {
    id: "t",
    worktree: "/tmp/w",
    runtime: "claude",
    role: "worker",
    prompt: "p",
    dependsOn: [],
    generation: 1,
    createdAt: "2026-05-16T00:00:00.000Z",
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

const profile = { name: "p", platform: "claude-code", runtimeCommand: "claude" } as const;

describe("UserConfirmPermit", () => {
  test("returns wait when no decision present", async () => {
    const store = new InMemoryPermitDecisionStore();
    const permit = new UserConfirmPermit({ store });
    const verdict = await permit.permit(ctx(task), profile);
    expect(verdict).toEqual({
      status: "wait",
      reason: "awaiting-user-confirmation",
      message: "no decision recorded for task 't' / profile 'p' / generation 1",
    });
  });

  test("returns granted when decision approved", async () => {
    const store = new InMemoryPermitDecisionStore();
    await store.record({ taskId: "t", profileName: "p", generation: 1, approved: true });
    const permit = new UserConfirmPermit({ store });
    expect(await permit.permit(ctx(task), profile)).toEqual({ status: "granted" });
  });

  test("returns denied with stored reason when decision rejected", async () => {
    const store = new InMemoryPermitDecisionStore();
    await store.record({
      taskId: "t",
      profileName: "p",
      generation: 1,
      approved: false,
      reason: "too-expensive",
    });
    const permit = new UserConfirmPermit({ store });
    const verdict = await permit.permit(ctx(task), profile);
    expect(verdict).toEqual({ status: "denied", reason: "too-expensive" });
  });

  test("decisions for older generations do not apply to newer task generations", async () => {
    const store = new InMemoryPermitDecisionStore();
    await store.record({ taskId: "t", profileName: "p", generation: 1, approved: true });
    const newer: AgentTaskView = {
      spec: { ...task.spec, generation: 2 },
      status: task.status,
    };
    const permit = new UserConfirmPermit({ store });
    const verdict = await permit.permit(ctx(newer), profile);
    expect(verdict.status).toBe("wait");
  });
});
