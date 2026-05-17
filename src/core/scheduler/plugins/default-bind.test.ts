import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentRuntime, AgentSession } from "../../agent-runtime.js";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { AgentSessionEntity } from "../../entity.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { DefaultBindPlugin } from "./default-bind.js";

class FakeRuntime implements AgentRuntime {
  spawnCalls: Array<{ role: string; config: AgentConfig }> = [];
  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    this.spawnCalls.push({ role, config });
    return { id: "s-1", role, status: "running", platform: config.platform, model: config.model };
  }
  async send(): Promise<never> {
    throw new Error("unused");
  }
  async close(): Promise<void> {}
  onIdle(): void {}
  async listSessions(): Promise<readonly AgentSession[]> {
    return [];
  }
  async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
    return [];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function ctx(task: AgentTaskView): SchedulerContext {
  return {
    task,
    profiles: [],
    store: { listAgentTaskEntities: async () => [], getAgentTask: async () => undefined },
    now: () => 0,
  };
}

function taskWith(spec: Partial<AgentTaskView["spec"]>): AgentTaskView {
  return {
    spec: {
      id: "t",
      worktree: "/tmp/w",
      runtime: "codex",
      role: "worker",
      prompt: "do work",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...spec,
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

const profile: RuntimeProfile = {
  name: "claude-opus",
  platform: "claude-code",
  runtimeCommand: "claude",
  model: "claude-opus-4-7",
};

describe("DefaultBindPlugin", () => {
  test("profile fields override task.spec.runtime when spawning", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    await plugin.bind(ctx(taskWith({ runtime: "codex" })), profile);
    const call = runtime.spawnCalls[0];
    expect(call?.config.command).toBe("claude");
    expect(call?.config.platform).toBe("claude-code");
    expect(call?.config.model).toBe("claude-opus-4-7");
  });

  test("falls back to task budget.model when profile.model undefined", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    await plugin.bind(ctx(taskWith({ budget: { model: "claude-haiku" } })), {
      ...profile,
      model: undefined,
    });
    expect(runtime.spawnCalls[0]?.config.model).toBe("claude-haiku");
  });

  test("injects GROVE_AGENT_TASK_* env vars", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    await plugin.bind(ctx(taskWith({ id: "task-42", generation: 7 })), profile);
    const env = runtime.spawnCalls[0]?.config.env ?? {};
    expect(env.GROVE_AGENT_TASK_ID).toBe("task-42");
    expect(env.GROVE_AGENT_TASK_GENERATION).toBe("7");
    expect(env.GROVE_AGENT_TASK_RUNTIME).toBe("claude");
  });

  test("returns session id from runtime.spawn", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    const result = await plugin.bind(ctx(taskWith({})), profile);
    expect(result.session.id).toBe("s-1");
  });
});
