import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskPhase } from "../core/agent-task.js";
import type { Condition } from "../core/entity.js";
import { createSqliteStores } from "./sqlite-store.js";

let tempDir: string;
let closeStores: (() => void) | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sqlite-agent-task-"));
});

afterEach(async () => {
  closeStores?.();
  closeStores = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

const condition: Condition = {
  type: "Blocked",
  status: "True",
  observedGeneration: 1,
  lastTransitionTime: "2026-05-13T12:00:00.000Z",
  reason: "depends-on",
  message: "Waiting for task-a",
};

describe("SqliteAgentTaskStore", () => {
  test("putAgentTaskSpec creates default status", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const view = await stores.agentTaskStore.putAgentTaskSpec({
      id: "task-create",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "Do the work",
      dependsOn: [],
      generation: 0,
      createdAt: "2026-05-13T11:00:00.000Z",
    });

    expect(view.spec.generation).toBe(1);
    expect(view.status.phase).toBe(AgentTaskPhase.Pending);
    expect(view.status.observedGeneration).toBe(0);
    expect(view.status.conditions).toEqual([]);
  });

  test("spec updates increment generation without changing status", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = await stores.agentTaskStore.putAgentTaskSpec({
      id: "task-update",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "Initial",
      dependsOn: [],
      generation: 0,
      createdAt: "2026-05-13T11:00:00.000Z",
    });

    await stores.agentTaskStore.patchAgentTaskStatus("task-update", {
      phase: AgentTaskPhase.Running,
      observedGeneration: created.spec.generation,
      sessionId: "session-1",
      conditions: [condition],
    });

    const updated = await stores.agentTaskStore.putAgentTaskSpec({
      ...created.spec,
      prompt: "Changed",
    });

    expect(updated.spec.generation).toBe(created.spec.generation + 1);
    expect(updated.status.phase).toBe(AgentTaskPhase.Running);
    expect(updated.status.observedGeneration).toBe(created.spec.generation);
    expect(updated.status.conditions).toEqual([condition]);
  });

  test("status patches do not mutate spec generation", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = await stores.agentTaskStore.putAgentTaskSpec({
      id: "task-status",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "Initial",
      dependsOn: ["task-a"],
      generation: 0,
      createdAt: "2026-05-13T11:00:00.000Z",
    });

    const patched = await stores.agentTaskStore.patchAgentTaskStatus("task-status", {
      phase: AgentTaskPhase.Succeeded,
      observedGeneration: created.spec.generation,
      contributions: ["b3:done"],
      conditions: [condition],
    });

    expect(patched.spec.generation).toBe(created.spec.generation);
    expect(patched.spec.dependsOn).toEqual(["task-a"]);
    expect(patched.status.phase).toBe(AgentTaskPhase.Succeeded);
    expect(patched.status.contributions).toEqual(["b3:done"]);
    expect(patched.status.conditions).toEqual([condition]);
  });
});
