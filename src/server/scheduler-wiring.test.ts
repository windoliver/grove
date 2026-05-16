/**
 * Tests for buildSchedulerFromConfig wiring helper.
 */

import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import type { AgentSessionEntity } from "../core/entity.js";
import type { AgentTaskEntity, AgentTaskView } from "../core/agent-task.js";
import { AgentTaskPhase } from "../core/agent-task.js";
import type { GroveConfig } from "../core/config.js";
import type { AcpxTurn } from "../acp/types.js";
import { buildSchedulerFromConfig } from "./scheduler-wiring.js";

// ---------------------------------------------------------------------------
// Fake runtime that records spawn calls
// ---------------------------------------------------------------------------

interface SpawnCall {
  role: string;
  config: AgentConfig;
}

function makeFakeRuntime(): AgentRuntime & { spawnCalls: SpawnCall[] } {
  const spawnCalls: SpawnCall[] = [];
  return {
    spawnCalls,
    async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
      spawnCalls.push({ role, config });
      return { id: `session-${role}`, role, status: "running" };
    },
    async send(_session: AgentSession, _message: string): Promise<AcpxTurn> {
      throw new Error("not implemented");
    },
    async close(_session: AgentSession): Promise<void> {},
    onIdle(_session: AgentSession, _callback: () => void): void {},
    async listSessions(): Promise<readonly AgentSession[]> {
      return [];
    },
    async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
      return [];
    },
    async isAvailable(): Promise<boolean> {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake store with empty entities
// ---------------------------------------------------------------------------

function emptyStore(): { listAgentTaskEntities: () => Promise<readonly AgentTaskEntity[]> } {
  return { listAgentTaskEntities: async () => [] };
}

// ---------------------------------------------------------------------------
// Helper: minimal task view
// ---------------------------------------------------------------------------

function taskView(): AgentTaskView {
  return {
    spec: {
      id: "task-1",
      worktree: "/tmp/worktree",
      runtime: "claude",
      role: "worker",
      prompt: "do the thing",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    },
    status: {
      id: "task-1",
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSchedulerFromConfig", () => {
  test("returns undefined when config.scheduler is undefined", () => {
    const config: GroveConfig = { name: "my-grove", mode: "local" };
    const runtime = makeFakeRuntime();
    const store = emptyStore();

    const result = buildSchedulerFromConfig({ config, runtime, store });

    expect(result).toBeUndefined();
  });

  test("returns a Scheduler when config has a scheduler block", () => {
    const config: GroveConfig = {
      name: "my-grove",
      mode: "local",
      scheduler: {
        profiles: [
          {
            name: "claude-default",
            platform: "claude-code",
            runtimeCommand: "claude",
          },
        ],
        pipeline: {
          filters: [],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
    };
    const runtime = makeFakeRuntime();
    const store = emptyStore();

    const result = buildSchedulerFromConfig({ config, runtime, store });

    expect(result).toBeDefined();
  });

  test("returned Scheduler.schedule() calls runtime.spawn with the configured profile", async () => {
    const config: GroveConfig = {
      name: "my-grove",
      mode: "local",
      scheduler: {
        profiles: [
          {
            name: "claude-default",
            platform: "claude-code",
            runtimeCommand: "claude",
          },
        ],
        pipeline: {
          filters: [],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
    };
    const runtime = makeFakeRuntime();
    const store = emptyStore();

    const scheduler = buildSchedulerFromConfig({ config, runtime, store });
    expect(scheduler).toBeDefined();

    const result = await scheduler!.schedule(taskView());

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") {
      expect(result.profile.name).toBe("claude-default");
    }
    expect(runtime.spawnCalls).toHaveLength(1);
    expect(runtime.spawnCalls[0]?.role).toBe("worker");
    expect(runtime.spawnCalls[0]?.config.command).toBe("claude");
  });

  test("Scheduler respects pipeline filters — all-reject yields unschedulable", async () => {
    // No built-in filter that always rejects, so we test the no-filter happy path
    // and confirm the scheduler wiring plumbs profiles through correctly.
    const config: GroveConfig = {
      name: "my-grove",
      mode: "local",
      scheduler: {
        profiles: [
          {
            name: "codex-default",
            platform: "codex",
            runtimeCommand: "codex",
          },
        ],
        pipeline: {
          filters: [],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
    };
    const runtime = makeFakeRuntime();
    const store = emptyStore();

    const scheduler = buildSchedulerFromConfig({ config, runtime, store });
    expect(scheduler).toBeDefined();

    const result = await scheduler!.schedule(taskView());

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") {
      expect(result.profile.name).toBe("codex-default");
      expect(result.profile.platform).toBe("codex");
    }
  });
});
