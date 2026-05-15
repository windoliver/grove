import { describe, expect, test } from "bun:test";
import {
  AgentTaskPhase,
  type AgentTaskView,
  agentTaskViewToEntity,
  isAgentTaskSpecStale,
} from "./agent-task.js";
import type { Condition } from "./entity.js";

const CONDITION: Condition = {
  type: "Blocked",
  status: "True",
  observedGeneration: 1,
  lastTransitionTime: "2026-05-13T12:00:00.000Z",
  reason: "depends-on",
  message: "Waiting for task-a",
};

function taskView(overrides: Partial<AgentTaskView> = {}): AgentTaskView {
  return {
    spec: {
      id: "task-1",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "Implement the shard",
      dependsOn: ["task-a"],
      maxTurns: 3,
      budget: { usd: 2 },
      generation: 2,
      createdAt: "2026-05-13T11:00:00.000Z",
    },
    status: {
      id: "task-1",
      phase: AgentTaskPhase.PendingBind,
      sessionId: "session-1",
      contributions: ["b3:contrib"],
      conditions: [CONDITION],
      observedGeneration: 1,
      lastTransitionAt: "2026-05-13T12:00:00.000Z",
      revision: 5,
    },
    ...overrides,
  };
}

describe("AgentTask entity projection", () => {
  test("projects split spec/status into an Entity envelope", () => {
    const entity = agentTaskViewToEntity(taskView(), "test/ns");

    expect(entity.kind).toBe("AgentTask");
    expect(entity.namespace).toBe("test/ns");
    expect(entity.id).toBe("task-1");
    expect(entity.spec).toEqual({
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "Implement the shard",
      dependsOn: ["task-a"],
      maxTurns: 3,
      budget: { usd: 2 },
    });
    expect(entity.status).toEqual({
      phase: AgentTaskPhase.PendingBind,
      sessionId: "session-1",
      contributions: ["b3:contrib"],
      conditions: [CONDITION],
      observedGeneration: 1,
    });
    expect(entity.conditions).toEqual([CONDITION]);
    expect(entity.observedGeneration).toBe(1);
    expect(entity.metadata.generation).toBe(2);
    expect(entity.metadata.creationTimestamp).toBe("2026-05-13T11:00:00.000Z");
    expect(entity.resourceVersion).toBe("7:2:5");
  });

  test("resourceVersion changes when spec generation or status revision changes", () => {
    const base = agentTaskViewToEntity(taskView());
    const specUpdated = agentTaskViewToEntity(
      taskView({ spec: { ...taskView().spec, generation: 3 } }),
    );
    const statusUpdated = agentTaskViewToEntity(
      taskView({ status: { ...taskView().status, revision: 6 } }),
    );

    expect(specUpdated.resourceVersion).not.toBe(base.resourceVersion);
    expect(statusUpdated.resourceVersion).not.toBe(base.resourceVersion);
  });

  test("detects stale specs when status has not observed current generation", () => {
    expect(isAgentTaskSpecStale(agentTaskViewToEntity(taskView()))).toBe(true);
    expect(
      isAgentTaskSpecStale(
        agentTaskViewToEntity(
          taskView({
            status: { ...taskView().status, observedGeneration: 2 },
          }),
        ),
      ),
    ).toBe(false);
  });
});
