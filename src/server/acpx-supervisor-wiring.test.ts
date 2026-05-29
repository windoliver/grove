import { describe, expect, test } from "bun:test";
import type { AcpxRespawnEvent } from "../core/acpx-supervisor.js";
import { AgentTaskConditionType } from "../core/agent-task.js";
import type { AgentTaskStatusPatch } from "../core/store.js";
import { wireSupervisorToTasks } from "./acpx-supervisor-wiring.js";

interface CapturedPatch {
  readonly id: string;
  readonly patch: AgentTaskStatusPatch;
}

function fakeDeps() {
  const patches: CapturedPatch[] = [];
  const listeners: ((e: AcpxRespawnEvent) => void)[] = [];
  const taskStore = {
    async patchAgentTaskStatus(id: string, patch: AgentTaskStatusPatch) {
      patches.push({ id, patch });
      return undefined as never; // wiring ignores the return
    },
    async getAgentTask(id: string) {
      return {
        spec: { id, generation: 1 },
        status: { phase: "Running", conditions: [], observedGeneration: 1 },
      } as never;
    },
  };
  const supervisor = {
    onRespawn(cb: (e: AcpxRespawnEvent) => void): void {
      listeners.push(cb);
    },
  };
  const fire = (e: AcpxRespawnEvent): void => {
    for (const l of listeners) l(e);
  };
  return { patches, taskStore, supervisor, fire };
}

const baseKey = { slotId: "task-1", backend: "codex" as const, cwd: "." };

describe("acpx supervisor -> AgentTask wiring", () => {
  test("resuming sets Resuming=True and does not change phase", async () => {
    const { patches, taskStore, supervisor, fire } = fakeDeps();
    wireSupervisorToTasks({ supervisor, taskStore, now: () => 0 });
    fire({ kind: "resuming", key: baseKey, acpxRecordId: "r1", deadSessionId: "s0", respawns: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(patches).toHaveLength(1);
    const { patch } = patches[0]!;
    expect(patch.phase).toBeUndefined();
    expect(
      patch.conditions?.some(
        (c) => c.type === AgentTaskConditionType.Resuming && c.status === "True",
      ),
    ).toBe(true);
  });

  test("resumed sets SessionLost=True, Resuming=False, updates sessionId, keeps phase Running", async () => {
    const { patches, taskStore, supervisor, fire } = fakeDeps();
    wireSupervisorToTasks({ supervisor, taskStore, now: () => 0 });
    fire({ kind: "resumed", key: baseKey, acpxRecordId: "r1", newSessionId: "s1", lastSeq: 7 });
    await new Promise((r) => setTimeout(r, 5));
    expect(patches).toHaveLength(1);
    const { patch } = patches[0]!;
    expect(patch.phase).toBeUndefined();
    expect(patch.sessionId).toBe("s1");
    expect(
      patch.conditions?.some(
        (c) => c.type === AgentTaskConditionType.SessionLost && c.status === "True",
      ),
    ).toBe(true);
    expect(
      patch.conditions?.some(
        (c) => c.type === AgentTaskConditionType.Resuming && c.status === "False",
      ),
    ).toBe(true);
  });

  test("dead sets phase Failed and invokes onDead for lease release", async () => {
    const { patches, taskStore, supervisor, fire } = fakeDeps();
    const released: string[] = [];
    wireSupervisorToTasks({
      supervisor,
      taskStore,
      now: () => 0,
      onDead: async (slotId: string) => {
        released.push(slotId);
      },
    });
    fire({ kind: "dead", key: baseKey, acpxRecordId: "r1", reason: "crash-loop", respawns: 5 });
    await new Promise((r) => setTimeout(r, 5));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.patch.phase).toBe("Failed");
    expect(released).toEqual(["task-1"]);
  });

  test("ignores events whose slot has no matching task", async () => {
    const { patches, taskStore, supervisor, fire } = fakeDeps();
    // override getAgentTask to return undefined
    taskStore.getAgentTask = async () => undefined as never;
    wireSupervisorToTasks({ supervisor, taskStore, now: () => 0 });
    fire({ kind: "resuming", key: baseKey, acpxRecordId: "r1", deadSessionId: "s0", respawns: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(patches).toHaveLength(0);
  });
});
