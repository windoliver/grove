import { describe, expect, test } from "bun:test";
import type { AgentTaskEntity } from "../../core/agent-task.js";
import { AgentTaskPhase } from "../../core/agent-task.js";
import { renderTaskPhase, staleSpecBadge } from "./agent-tasks.js";

function taskEntity(overrides: Partial<AgentTaskEntity> = {}): AgentTaskEntity {
  return {
    kind: "AgentTask",
    namespace: "default",
    id: "task-1",
    spec: {
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "Implement",
      dependsOn: [],
    },
    status: {
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 1,
    },
    conditions: [],
    observedGeneration: 1,
    resourceVersion: "1",
    metadata: { generation: 2, creationTimestamp: "2026-05-13T11:00:00.000Z" },
    ...overrides,
  };
}

describe("agent task TUI helpers", () => {
  test("staleSpecBadge renders only when status observedGeneration is behind metadata.generation", () => {
    expect(staleSpecBadge(taskEntity())).toBe("stale spec");
    expect(
      staleSpecBadge(
        taskEntity({
          status: { ...taskEntity().status, observedGeneration: 2 },
          observedGeneration: 2,
        }),
      ),
    ).toBe("");
  });

  test("renderTaskPhase includes stale-spec badge next to phase", () => {
    expect(renderTaskPhase(taskEntity())).toBe("PendingBind stale spec");
    expect(
      renderTaskPhase(
        taskEntity({
          status: { ...taskEntity().status, phase: AgentTaskPhase.Running, observedGeneration: 2 },
          observedGeneration: 2,
        }),
      ),
    ).toBe("Running");
  });
});
