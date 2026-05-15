import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskPhase } from "../core/agent-task.js";
import { WatchHub } from "../core/watch-hub.js";
import { createSqliteStores } from "../local/sqlite-store.js";
import { wireAgentTaskStoreWrites } from "./agent-task-store-wiring.js";

const TEST_NAMESPACE = "test-project/main";

describe("wireAgentTaskStoreWrites", () => {
  let tempDir: string;
  let stores: ReturnType<typeof createSqliteStores>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-task-wiring-test-"));
    stores = createSqliteStores(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    stores.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("publishes and enqueues after AgentTask spec and status writes", async () => {
    const watchHub = new WatchHub();
    const enqueued: string[] = [];

    wireAgentTaskStoreWrites({
      store: stores.agentTaskStore,
      namespace: TEST_NAMESPACE,
      watchHub,
      enqueueTaskId: (taskId) => enqueued.push(taskId),
    });

    await stores.agentTaskStore.putAgentTaskSpec({
      id: "task-wire",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "Implement issue 299",
      dependsOn: [],
      generation: 0,
      createdAt: "2026-05-14T12:00:00.000Z",
    });

    expect(watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(1n);
    expect(enqueued).toEqual(["task-wire"]);

    await stores.agentTaskStore.patchAgentTaskStatus("task-wire", {
      phase: AgentTaskPhase.Running,
      observedGeneration: 1,
      sessionId: "session-1",
    });

    expect(watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(2n);
    expect(enqueued).toEqual(["task-wire", "task-wire"]);
  });

  test("preserves an existing AgentTask write callback", async () => {
    const watchHub = new WatchHub();
    const priorCalls: string[] = [];
    stores.agentTaskStore.onAgentTaskWrite = (op, view) => {
      priorCalls.push(`${op}:${view.spec.id}`);
    };

    wireAgentTaskStoreWrites({
      store: stores.agentTaskStore,
      namespace: TEST_NAMESPACE,
      watchHub,
    });

    await stores.agentTaskStore.putAgentTaskSpec({
      id: "task-prior",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "Keep existing callback",
      dependsOn: [],
      generation: 0,
      createdAt: "2026-05-14T12:00:00.000Z",
    });

    expect(priorCalls).toEqual(["ADDED:task-prior"]);
    expect(watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(1n);
  });
});
