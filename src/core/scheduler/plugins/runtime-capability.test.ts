import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { RuntimeCapabilityFilter } from "./runtime-capability.js";

function makeCtx(task: AgentTaskView, profiles: RuntimeProfile[] = []): SchedulerContext {
  return {
    task,
    profiles,
    store: { listAgentTaskEntities: async () => [] },
    now: () => 0,
  };
}

function task(overrides: Partial<AgentTaskView["spec"]> = {}): AgentTaskView {
  return {
    spec: {
      id: "t",
      worktree: "/tmp/w",
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...overrides,
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

function profile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    name: "p",
    platform: "claude-code",
    runtimeCommand: "claude",
    ...overrides,
  };
}

describe("RuntimeCapabilityFilter", () => {
  const filter = new RuntimeCapabilityFilter();

  test("admits when task.spec.runtime matches profile.runtimeCommand", async () => {
    const verdict = await filter.filter(makeCtx(task()), profile());
    expect(verdict).toEqual({ admit: true });
  });

  test("rejects when task.spec.runtime mismatches profile.runtimeCommand", async () => {
    const verdict = await filter.filter(
      makeCtx(task({ runtime: "codex" })),
      profile({ runtimeCommand: "claude" }),
    );
    expect(verdict).toEqual({
      admit: false,
      reason: "runtime-mismatch",
      message: "task pins runtime 'codex' but profile runs 'claude'",
    });
  });

  test("rejects when profile.supportedRoles excludes task.spec.role", async () => {
    const verdict = await filter.filter(
      makeCtx(task({ role: "reviewer" })),
      profile({ supportedRoles: ["worker"] }),
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("role-unsupported");
  });

  test("admits when profile.supportedRoles is undefined regardless of role", async () => {
    const verdict = await filter.filter(makeCtx(task({ role: "anything" })), profile());
    expect(verdict).toEqual({ admit: true });
  });

  test("rejects when task asks for a model not in profile.budget.allowedModels", async () => {
    const verdict = await filter.filter(
      makeCtx(task({ budget: { model: "claude-haiku-4-5" } })),
      profile({ budget: { allowedModels: ["claude-opus-4-7"] } }),
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("model-not-allowed");
  });

  test("admits when budget.allowedModels is undefined", async () => {
    const verdict = await filter.filter(
      makeCtx(task({ budget: { model: "anything" } })),
      profile(),
    );
    expect(verdict).toEqual({ admit: true });
  });
});
