import { describe, expect, mock, test } from "bun:test";
import type { AcpxTurn } from "../acp/types.js";
import { AcpRuntime } from "../core/acp-runtime.js";
import { AcpxSupervisor } from "../core/acpx-supervisor.js";
import { makeInProcessLaunchOverride } from "../core/acpx-test-support.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import { AgentTaskPhase } from "../core/agent-task.js";
import type { AgentSessionEntity } from "../core/entity.js";
import type { JsonValue } from "../core/models.js";
import type { AgentTaskStatusPatch } from "../core/store.js";
import {
  createServerAgentRuntime,
  createTaskControllerWiring,
  taskControllerEnabled,
} from "./task-controller-wiring.js";

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

// ---------------------------------------------------------------------------
// Fake helpers for createTaskControllerWiring tests
// ---------------------------------------------------------------------------

interface CapturedPatch {
  readonly id: string;
  readonly patch: AgentTaskStatusPatch;
}

function fakeTaskStore() {
  const patches: CapturedPatch[] = [];
  return {
    store: {
      async patchAgentTaskStatus(id: string, patch: AgentTaskStatusPatch) {
        patches.push({ id, patch });
        return undefined as never; // wiring ignores the return value
      },
      async getAgentTask(id: string) {
        return {
          spec: { id, generation: 1 },
          status: { phase: AgentTaskPhase.Running, conditions: [], observedGeneration: 1 },
        } as never;
      },
      async listAgentTaskEntities() {
        return [] as never;
      },
      close() {},
    },
    patches,
  };
}

function fakeClaimStore() {
  const released: string[] = [];
  return {
    store: {
      async activeClaims() {
        return [] as never;
      },
      async listClaims() {
        return [] as never;
      },
      async release(claimId: string) {
        released.push(claimId);
        return undefined as never;
      },
      async putClaimSpec() {
        return undefined as never;
      },
      async getClaimView() {
        return undefined;
      },
      async patchClaimStatus() {
        return undefined as never;
      },
      async createClaim() {
        return undefined as never;
      },
      async claimOrRenew() {
        return undefined as never;
      },
      async getClaim() {
        return undefined;
      },
      async heartbeat() {
        return undefined as never;
      },
      async complete() {
        return undefined as never;
      },
      async expireStale() {
        return [] as never;
      },
      async countActiveClaims() {
        return 0;
      },
      async detectStalled() {
        return [] as never;
      },
      async listEntities() {
        return [] as never;
      },
      async releaseOwnedBy() {
        return 0;
      },
      async deleteTerminalOwnedBy() {
        return 0;
      },
      async cleanCompleted() {
        return 0;
      },
      close() {},
    },
    released,
  };
}

describe("createTaskControllerWiring + AcpxSupervisor", () => {
  test("registers respawn wiring when runtime is AcpxSupervisor; dead event fails the task", async () => {
    const { store: taskStore, patches } = fakeTaskStore();
    const { store: claimStore } = fakeClaimStore();

    const supervisor = new AcpxSupervisor({
      runtimeFactory: () => new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() }),
    });

    // Spy on onRespawn to verify wiring is registered
    const onRespawnCalls: Array<(e: Parameters<typeof supervisor.onRespawn>[0]) => void> = [];
    const origOnRespawn = supervisor.onRespawn.bind(supervisor);
    supervisor.onRespawn = (cb) => {
      onRespawnCalls.push(cb);
      origOnRespawn(cb);
    };

    createTaskControllerWiring({ taskStore, claimStore, runtime: supervisor });

    // Verify wiring was registered (onRespawn was called)
    expect(onRespawnCalls.length).toBe(1);

    // Fire a dead event through the captured callback
    const cb = onRespawnCalls[0];
    if (cb === undefined) throw new Error("no respawn callback registered");

    cb({
      kind: "dead",
      key: { slotId: "task-1", backend: "codex" as const, cwd: "." },
      acpxRecordId: "r1",
      reason: "crash-loop",
      respawns: 5,
    });

    // Allow the async fire-and-forget to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(patches.length).toBeGreaterThanOrEqual(1);
    expect(patches[0]?.patch.phase).toBe(AgentTaskPhase.Failed);
  });

  test("does not register respawn wiring for a non-supervisor runtime", () => {
    const { store: taskStore } = fakeTaskStore();
    const { store: claimStore } = fakeClaimStore();

    const plainRuntime = new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() });

    // Should not throw, and no onRespawn on plain AcpRuntime
    expect(() => {
      createTaskControllerWiring({ taskStore, claimStore, runtime: plainRuntime });
    }).not.toThrow();
  });
});

describe("createTaskControllerWiring + AcpxSupervisor — onDead lease release", () => {
  test("releases only active claims whose context.agentTaskId matches the dead slotId", async () => {
    const { store: taskStore } = fakeTaskStore();
    const releasedIds: string[] = [];

    // Two active claims — one with matching agentTaskId, one without.
    const matchingClaim = {
      claimId: "claim-match",
      targetRef: "target-1",
      status: "active" as const,
      agent: { agentId: "agent-1", agentName: "Coder" },
      intentSummary: "Doing work",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      context: { agentTaskId: "slot-dead" } as Record<string, JsonValue>,
    };
    const otherClaim = {
      claimId: "claim-other",
      targetRef: "target-2",
      status: "active" as const,
      agent: { agentId: "agent-2", agentName: "Reviewer" },
      intentSummary: "Other work",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      context: { agentTaskId: "slot-other" } as Record<string, JsonValue>,
    };
    const noContextClaim = {
      claimId: "claim-nocontext",
      targetRef: "target-3",
      status: "active" as const,
      agent: { agentId: "agent-3", agentName: "Bot" },
      intentSummary: "No context",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    };

    const claimStoreWithData = {
      store: {
        async activeClaims() {
          return [] as never;
        },
        async listClaims() {
          return [matchingClaim, otherClaim, noContextClaim] as never;
        },
        async release(claimId: string) {
          releasedIds.push(claimId);
          return undefined as never;
        },
        async putClaimSpec() {
          return undefined as never;
        },
        async getClaimView() {
          return undefined;
        },
        async patchClaimStatus() {
          return undefined as never;
        },
        async createClaim() {
          return undefined as never;
        },
        async claimOrRenew() {
          return undefined as never;
        },
        async getClaim() {
          return undefined;
        },
        async heartbeat() {
          return undefined as never;
        },
        async complete() {
          return undefined as never;
        },
        async expireStale() {
          return [] as never;
        },
        async countActiveClaims() {
          return 0;
        },
        async detectStalled() {
          return [] as never;
        },
        async listEntities() {
          return [] as never;
        },
        async releaseOwnedBy() {
          return 0;
        },
        async deleteTerminalOwnedBy() {
          return 0;
        },
        async cleanCompleted() {
          return 0;
        },
        close() {
          // no-op stub
        },
      },
    };

    const supervisor = new AcpxSupervisor({
      runtimeFactory: () => new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() }),
    });

    const onRespawnCalls: Array<(e: Parameters<typeof supervisor.onRespawn>[0]) => void> = [];
    const origOnRespawn = supervisor.onRespawn.bind(supervisor);
    supervisor.onRespawn = (cb) => {
      onRespawnCalls.push(cb);
      origOnRespawn(cb);
    };

    createTaskControllerWiring({
      taskStore,
      claimStore: claimStoreWithData.store,
      runtime: supervisor,
    });

    const cb = onRespawnCalls[0];
    if (cb === undefined) throw new Error("no respawn callback registered");

    cb({
      kind: "dead",
      key: { slotId: "slot-dead", backend: "codex" as const, cwd: "." },
      acpxRecordId: "r1",
      reason: "crash-loop",
      respawns: 5,
    });

    // Allow the async fire-and-forget to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(releasedIds).toEqual(["claim-match"]);
  });
});

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
