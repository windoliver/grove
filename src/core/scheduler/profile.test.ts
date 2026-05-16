import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../agent-task.js";
import { AgentTaskPhase } from "../agent-task.js";
import { synthesizeFallbackProfile } from "./profile.js";

function taskWithRuntime(runtime: string, model?: string): AgentTaskView {
  return {
    spec: {
      id: "task-1",
      worktree: "/tmp/w",
      runtime,
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...(model === undefined ? {} : { budget: { model } }),
    },
    status: {
      id: "task-1",
      phase: AgentTaskPhase.Pending,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

describe("synthesizeFallbackProfile", () => {
  test("maps task.spec.runtime 'claude' to claude-code platform", () => {
    const profile = synthesizeFallbackProfile(taskWithRuntime("claude"));
    expect(profile.platform).toBe("claude-code");
    expect(profile.runtimeCommand).toBe("claude");
    expect(profile.name).toBe("fallback-claude");
  });

  test("maps 'codex' and 'gemini' to their platforms", () => {
    expect(synthesizeFallbackProfile(taskWithRuntime("codex")).platform).toBe("codex");
    expect(synthesizeFallbackProfile(taskWithRuntime("gemini")).platform).toBe("gemini");
  });

  test("uses undefined platform for unknown runtime", () => {
    expect(synthesizeFallbackProfile(taskWithRuntime("custom")).platform).toBeUndefined();
  });

  test("carries model from task.spec.budget.model when present", () => {
    expect(synthesizeFallbackProfile(taskWithRuntime("claude", "claude-opus-4-7")).model).toBe(
      "claude-opus-4-7",
    );
  });
});
