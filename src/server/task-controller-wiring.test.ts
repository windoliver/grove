import { describe, expect, mock, test } from "bun:test";
import type { AcpxTurn } from "../acp/types.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import type { AgentSessionEntity } from "../core/entity.js";
import { createServerAgentRuntime, taskControllerEnabled } from "./task-controller-wiring.js";

function emptyTurn(sessionId: string): AcpxTurn {
  return {
    sessionId,
    turnId: `${sessionId}-turn`,
    messages: (async function* () {
      // no messages
    })(),
    result: Promise.resolve({ turnId: `${sessionId}-turn`, stopReason: "end_turn" }),
    cancel: async () => undefined,
    close: async () => undefined,
  };
}

let selectedRuntimeAvailable = true;
const selectedRuntime: AgentRuntime = {
  spawn: async (role, config) => ({
    id: "selected-session",
    role,
    status: "running",
    platform: config.platform,
    model: config.model,
  }),
  send: async (session) => emptyTurn(session.id),
  close: async () => undefined,
  onIdle: () => undefined,
  listSessions: async () => [],
  listSessionEntities: async () => [],
  isAvailable: mock(async () => selectedRuntimeAvailable),
};

class FakeTmuxRuntime implements AgentRuntime {
  readonly fallbackRuntime = true;

  readonly sendsInitialPromptOnSpawn = true;

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    return {
      id: "fallback-session",
      role,
      status: "running",
      platform: config.platform,
      model: config.model,
    };
  }

  async send(session: AgentSession): Promise<AcpxTurn> {
    return emptyTurn(session.id);
  }

  async close(): Promise<void> {
    return undefined;
  }

  onIdle(): void {
    // no-op
  }

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

describe("task controller server wiring", () => {
  test("uses selected runtime when available", async () => {
    selectedRuntimeAvailable = true;

    await expect(
      createServerAgentRuntime({
        selectRuntime: () => selectedRuntime,
        createFallbackRuntime: () => new FakeTmuxRuntime(),
      }),
    ).resolves.toBe(selectedRuntime);
  });

  test("falls back to tmux runtime when selected runtime is unavailable", async () => {
    selectedRuntimeAvailable = false;

    const runtime = await createServerAgentRuntime({
      selectRuntime: () => selectedRuntime,
      createFallbackRuntime: () => new FakeTmuxRuntime(),
    });

    expect(runtime).toBeInstanceOf(FakeTmuxRuntime);
  });

  test("enables task controller by default", () => {
    expect(taskControllerEnabled({})).toBe(true);
  });

  test("enables task controller when explicitly enabled", () => {
    expect(taskControllerEnabled({ GROVE_TASK_CONTROLLER: "1" })).toBe(true);
  });

  test("disables task controller when explicitly disabled", () => {
    expect(taskControllerEnabled({ GROVE_TASK_CONTROLLER: "0" })).toBe(false);
  });
});
