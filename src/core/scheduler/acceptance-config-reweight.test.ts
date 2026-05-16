import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentRuntime, AgentSession } from "../agent-runtime.js";
import type { AgentTaskView } from "../agent-task.js";
import { AgentTaskPhase } from "../agent-task.js";
import type { AgentSessionEntity } from "../entity.js";
import { loadSchedulerConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";

class RecordingRuntime implements AgentRuntime {
  spawnCalls: Array<{ role: string; command: string; model: string | undefined }> = [];
  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    this.spawnCalls.push({ role, command: config.command, model: config.model });
    return { id: "s", role, status: "running" };
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

const task: AgentTaskView = {
  spec: {
    id: "t",
    worktree: "/tmp/w",
    runtime: "",
    role: "worker",
    prompt: "p",
    dependsOn: [],
    generation: 1,
    createdAt: "2026-05-16T00:00:00.000Z",
    budget: { affinity: { tier: "premium" } },
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

const profiles = [
  { name: "free-tier", platform: "claude-code", runtimeCommand: "claude", labels: { tier: "free" } },
  {
    name: "premium-tier",
    platform: "claude-code",
    runtimeCommand: "claude",
    labels: { tier: "premium" },
  },
];

describe("acceptance: config-only reweight changes winner", () => {
  test("with TaskAffinity enabled, premium-tier wins on premium affinity", async () => {
    const runtime = new RecordingRuntime();
    const loaded = loadSchedulerConfig(
      {
        profiles,
        pipeline: {
          filters: [],
          scores: [{ name: "TaskAffinity", weight: 1 }],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
      { runtime },
    );
    const scheduler = new Scheduler({
      profiles: loaded.profiles,
      filters: loaded.filters,
      scores: loaded.scores,
      permits: loaded.permits,
      bindPlugin: loaded.bindPlugin,
      store: { listAgentTaskEntities: async () => [] },
      now: () => 0,
    });

    const result = await scheduler.schedule(task);

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("premium-tier");
  });

  test("with TaskAffinity removed, declaration order wins (free-tier first)", async () => {
    const runtime = new RecordingRuntime();
    const loaded = loadSchedulerConfig(
      {
        profiles,
        pipeline: {
          filters: [],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
      { runtime },
    );
    const scheduler = new Scheduler({
      profiles: loaded.profiles,
      filters: loaded.filters,
      scores: loaded.scores,
      permits: loaded.permits,
      bindPlugin: loaded.bindPlugin,
      store: { listAgentTaskEntities: async () => [] },
      now: () => 0,
    });

    const result = await scheduler.schedule(task);

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("free-tier");
  });
});
