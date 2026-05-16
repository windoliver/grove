import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../agent-runtime.js";
import type { AgentTaskEntity, AgentTaskView } from "../agent-task.js";
import { AgentTaskPhase } from "../agent-task.js";
import type {
  BindPlugin,
  FilterPlugin,
  PermitPlugin,
  ScorePlugin,
} from "./framework.js";
import type { RuntimeProfile } from "./profile.js";
import { Scheduler } from "./scheduler.js";

const TASK_ID = "task-1";

function taskView(): AgentTaskView {
  return {
    spec: {
      id: TASK_ID,
      worktree: "/tmp/w",
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    },
    status: {
      id: TASK_ID,
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function profile(name: string, overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    name,
    platform: "claude-code",
    runtimeCommand: "claude",
    ...overrides,
  };
}

function emptyStore(): { listAgentTaskEntities: () => Promise<readonly AgentTaskEntity[]> } {
  return { listAgentTaskEntities: async () => [] };
}

function alwaysReject(name: string, reason: string): FilterPlugin {
  return { name, filter: async () => ({ admit: false, reason }) };
}

function alwaysAdmit(name: string): FilterPlugin {
  return { name, filter: async () => ({ admit: true }) };
}

function constantScore(name: string, value: number): ScorePlugin {
  return { name, score: async () => value };
}

function autoPermit(): PermitPlugin {
  return { name: "auto", permit: async () => ({ status: "granted" }) };
}

function staticBind(session: AgentSession): BindPlugin {
  return { name: "static", bind: async () => ({ session }) };
}

describe("Scheduler.schedule — unschedulable", () => {
  test("returns unschedulable when all profiles are rejected", async () => {
    const scheduler = new Scheduler({
      profiles: [profile("a"), profile("b")],
      filters: [alwaysReject("deny-all", "blocked")],
      scores: [],
      permits: [autoPermit()],
      bindPlugin: staticBind({ id: "s", role: "worker", status: "running" }),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("unschedulable");
    if (result.kind === "unschedulable") {
      expect(result.rejections).toHaveLength(2);
      expect(result.rejections[0]?.rejections[0]?.reason).toBe("blocked");
    }
  });
});
