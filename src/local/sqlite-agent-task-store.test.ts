import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskPhase } from "../core/agent-task.js";
import { expectOk } from "../core/cas.js";
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

    const view = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        id: "task-create",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "Do the work",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
    );

    expect(view.spec.generation).toBe(1);
    expect(view.status.phase).toBe(AgentTaskPhase.Pending);
    expect(view.status.observedGeneration).toBe(0);
    expect(view.status.conditions).toEqual([]);
  });

  test("spec updates increment generation without changing status", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        id: "task-update",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "Initial",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
    );

    await stores.agentTaskStore.patchAgentTaskStatus("task-update", {
      phase: AgentTaskPhase.Running,
      observedGeneration: created.spec.generation,
      sessionId: "session-1",
      conditions: [condition],
    });

    const updated = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        ...created.spec,
        prompt: "Changed",
      }),
    );

    expect(updated.spec.generation).toBe(created.spec.generation + 1);
    expect(updated.status.phase).toBe(AgentTaskPhase.Running);
    expect(updated.status.observedGeneration).toBe(created.spec.generation);
    expect(updated.status.conditions).toEqual([condition]);
  });

  test("status patches do not mutate spec generation", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        id: "task-status",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "Initial",
        dependsOn: ["task-a"],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
    );

    const patched = expectOk(
      await stores.agentTaskStore.patchAgentTaskStatus("task-status", {
        phase: AgentTaskPhase.Succeeded,
        observedGeneration: created.spec.generation,
        contributions: ["b3:done"],
        conditions: [condition],
      }),
    );

    expect(patched.spec.generation).toBe(created.spec.generation);
    expect(patched.spec.dependsOn).toEqual(["task-a"]);
    expect(patched.status.phase).toBe(AgentTaskPhase.Succeeded);
    expect(patched.status.contributions).toEqual(["b3:done"]);
    expect(patched.status.conditions).toEqual([condition]);
  });

  // --------------------------------------------------------------------------
  // putAgentTaskSpec CAS (C6, #304)
  // --------------------------------------------------------------------------

  test("putAgentTaskSpec returns rv-mismatch when ifMatch is stale", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        id: "cas-stale",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "first",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
    );
    const staleRv = String(created.spec.resourceVersion ?? 1);

    // External mutation bumps RV without ifMatch.
    const secondPut = await stores.agentTaskStore.putAgentTaskSpec({
      id: "cas-stale",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "second",
      dependsOn: [],
      generation: 0,
      createdAt: "2026-05-13T11:00:00.000Z",
    });
    expect(secondPut.kind).toBe("ok");

    // Retry with captured stale RV — must be rejected.
    const result = await stores.agentTaskStore.putAgentTaskSpec(
      {
        id: "cas-stale",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "third",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      },
      { ifMatch: staleRv },
    );
    expect(result.kind).toBe("rv-mismatch");
    if (result.kind === "rv-mismatch") {
      expect(result.current.resourceVersion).not.toBe(staleRv);
      expect(typeof result.current.generation).toBe("number");
    }
  });

  test("putAgentTaskSpec bumps resource_version when ifMatch matches", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        id: "cas-fresh",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "first",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
    );
    const initialRv = String(created.spec.resourceVersion ?? 1);

    const result = await stores.agentTaskStore.putAgentTaskSpec(
      {
        id: "cas-fresh",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "second",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      },
      { ifMatch: initialRv },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      const nextRv = String(result.view.spec.resourceVersion ?? 1);
      expect(Number(nextRv)).toBeGreaterThan(Number(initialRv));
    }
  });

  test("putAgentTaskSpec without ifMatch still writes (back-compat path)", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const result = await stores.agentTaskStore.putAgentTaskSpec({
      id: "cas-noopts",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "worker",
      prompt: "first",
      dependsOn: [],
      generation: 0,
      createdAt: "2026-05-13T11:00:00.000Z",
    });
    expect(result.kind).toBe("ok");
  });

  test("putAgentTaskSpec with ifMatch against non-existent record creates (matches HTTP semantics)", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const result = await stores.agentTaskStore.putAgentTaskSpec(
      {
        id: "cas-missing",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "first",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      },
      { ifMatch: "999" }, // bogus RV — must create the row regardless
    );
    expect(result.kind).toBe("ok");
  });

  // --------------------------------------------------------------------------
  // patchAgentTaskStatus CAS (C6, #304)
  // --------------------------------------------------------------------------

  test("patchAgentTaskStatus returns rv-mismatch when ifMatch is stale", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        id: "status-cas-stale",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "first",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
    );
    const staleRv = String(created.status.resourceVersion ?? created.status.revision ?? 1);

    // Bump status RV via an unguarded patch.
    const bumped = expectOk(
      await stores.agentTaskStore.patchAgentTaskStatus("status-cas-stale", {
        phase: AgentTaskPhase.Running,
        observedGeneration: created.spec.generation,
      }),
    );
    expect(
      Number(String(bumped.status.resourceVersion ?? bumped.status.revision ?? 1)),
    ).toBeGreaterThan(Number(staleRv));

    // Retry with stale ifMatch → rv-mismatch.
    const result = await stores.agentTaskStore.patchAgentTaskStatus(
      "status-cas-stale",
      { observedGeneration: created.spec.generation },
      { ifMatch: staleRv },
    );
    expect(result.kind).toBe("rv-mismatch");
    if (result.kind === "rv-mismatch") {
      expect(result.current.resourceVersion).not.toBe(staleRv);
      expect(typeof result.current.generation).toBe("number");
    }
  });

  test("patchAgentTaskStatus bumps status resource_version when ifMatch matches", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        id: "status-cas-fresh",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "first",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
    );
    const initialRv = String(created.status.resourceVersion ?? created.status.revision ?? 1);

    const result = await stores.agentTaskStore.patchAgentTaskStatus(
      "status-cas-fresh",
      { phase: AgentTaskPhase.Running, observedGeneration: created.spec.generation },
      { ifMatch: initialRv },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      const nextRv = String(result.view.status.resourceVersion ?? result.view.status.revision ?? 1);
      expect(Number(nextRv)).toBeGreaterThan(Number(initialRv));
    }
  });

  test("patchAgentTaskStatus without ifMatch still writes (back-compat path)", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    const created = expectOk(
      await stores.agentTaskStore.putAgentTaskSpec({
        id: "status-cas-noopts",
        worktree: "/tmp/worktree",
        runtime: "codex",
        role: "worker",
        prompt: "first",
        dependsOn: [],
        generation: 0,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
    );
    const result = await stores.agentTaskStore.patchAgentTaskStatus("status-cas-noopts", {
      observedGeneration: created.spec.generation,
    });
    expect(result.kind).toBe("ok");
  });

  test("patchAgentTaskStatus against non-existent task throws NotFoundError", async () => {
    const stores = createSqliteStores(join(tempDir, "test.db"));
    closeStores = stores.close;

    // PATCH on a missing resource is NotFound, regardless of ifMatch. The
    // route surface treats this as a 404 (T6 wires If-Match enforcement).
    await expect(
      stores.agentTaskStore.patchAgentTaskStatus("status-cas-missing", {}, { ifMatch: "1" }),
    ).rejects.toThrow();
  });
});
