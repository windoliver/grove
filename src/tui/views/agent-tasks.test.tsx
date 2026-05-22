import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { AgentTaskEntity } from "../../core/agent-task.js";
import { AgentTaskPhase } from "../../core/agent-task.js";
import type { TuiDataProvider } from "../provider.js";
import { AgentTasksView, renderTaskPhase, staleSpecBadge } from "./agent-tasks.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  test("refreshes the active panel on fallback interval", async () => {
    let fetches = 0;
    const provider = {
      getAgentTasks: async () => {
        fetches += 1;
        return [];
      },
    } as unknown as TuiDataProvider;
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(AgentTasksView, {
          provider,
          active: true,
          cursor: 0,
          intervalMs: 10,
        }),
      );
      await sleep(0);
    });

    const initialFetches = fetches;
    expect(initialFetches).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await sleep(35);
    });

    expect(fetches).toBeGreaterThan(initialFetches);

    await act(async () => {
      renderer?.unmount();
    });
  });
});
