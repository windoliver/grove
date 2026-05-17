import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import { AutoPermit } from "./auto-permit.js";

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

describe("AutoPermit", () => {
  test("always grants", async () => {
    const permit = new AutoPermit();
    const ctx = {
      task,
      profiles: [],
      store: { listAgentTaskEntities: async () => [], getAgentTask: async () => undefined },
      now: () => 0,
    };
    const verdict = await permit.permit(ctx, {
      name: "p",
      platform: "claude-code",
      runtimeCommand: "claude",
    });
    expect(verdict).toEqual({ status: "granted" });
  });
});
