import { describe, expect, test } from "bun:test";

import type {
  AgentTaskEntity,
  AgentTaskSpecRecord,
  AgentTaskStatusRecord,
  AgentTaskView,
} from "../../core/agent-task.js";
import { AgentTaskPhase, agentTaskViewToEntity } from "../../core/agent-task.js";
import { type CasMutationResult, type CasOpts, casOk, checkIfMatch } from "../../core/cas.js";
import type { AgentTaskQuery, AgentTaskStatusPatch, AgentTaskStore } from "../../core/store.js";
import { createTestApp, TEST_AUTH_HEADERS } from "../test-helpers.js";

const TEST_CONTROLLER_TOKEN = "test-controller-token";
const TEST_CONTROLLER_HEADERS: Record<string, string> = {
  "X-Grove-Controller-Token": TEST_CONTROLLER_TOKEN,
};

/**
 * Minimal in-memory AgentTaskStore for route tests. Mirrors the CAS
 * semantics of the SQLite store but skips watch fan-out / finalizers /
 * GC concerns that aren't relevant to the HTTP surface.
 */
class TestAgentTaskStore implements AgentTaskStore {
  private readonly specs = new Map<string, AgentTaskSpecRecord>();
  private readonly statuses = new Map<string, AgentTaskStatusRecord>();
  readonly putSpecCalls: { id: string; ifMatch: string | undefined }[] = [];
  readonly patchStatusCalls: { id: string; ifMatch: string | undefined }[] = [];

  private viewFor(id: string): AgentTaskView | undefined {
    const spec = this.specs.get(id);
    const status = this.statuses.get(id);
    if (spec === undefined || status === undefined) return undefined;
    return { spec, status };
  }

  async putAgentTaskSpec(
    spec: AgentTaskSpecRecord,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>> {
    this.putSpecCalls.push({ id: spec.id, ifMatch: opts?.ifMatch });
    const existing = this.viewFor(spec.id);
    if (existing !== undefined) {
      const mismatch = checkIfMatch(
        existing.spec.resourceVersion,
        opts?.ifMatch,
        existing.spec.generation,
      );
      if (mismatch) return mismatch;
      const updated: AgentTaskView = {
        spec: {
          ...spec,
          createdAt: existing.spec.createdAt,
          generation: existing.spec.generation + 1,
          resourceVersion: (existing.spec.resourceVersion ?? 1) + 1,
        },
        status: existing.status,
      };
      this.specs.set(spec.id, updated.spec);
      this.statuses.set(spec.id, updated.status);
      return casOk(updated);
    }
    // Initial insert.
    const now = new Date().toISOString();
    const view: AgentTaskView = {
      spec: { ...spec, generation: 1, resourceVersion: 1 },
      status: {
        id: spec.id,
        phase: AgentTaskPhase.Pending,
        contributions: [],
        conditions: [],
        observedGeneration: 0,
        lastTransitionAt: now,
        revision: 1,
        resourceVersion: 1,
      },
    };
    this.specs.set(spec.id, view.spec);
    this.statuses.set(spec.id, view.status);
    return casOk(view);
  }

  async getAgentTask(id: string): Promise<AgentTaskView | undefined> {
    return this.viewFor(id);
  }

  async listAgentTasks(_query?: AgentTaskQuery): Promise<readonly AgentTaskView[]> {
    const views: AgentTaskView[] = [];
    for (const id of this.specs.keys()) {
      const view = this.viewFor(id);
      if (view !== undefined) views.push(view);
    }
    return views;
  }

  async patchAgentTaskStatus(
    id: string,
    patch: AgentTaskStatusPatch,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>> {
    this.patchStatusCalls.push({ id, ifMatch: opts?.ifMatch });
    const view = this.viewFor(id);
    if (view === undefined) {
      throw new Error(`AgentTask ${id} not found`);
    }
    const mismatch = checkIfMatch(view.status.resourceVersion, opts?.ifMatch, view.spec.generation);
    if (mismatch) return mismatch;
    const updated: AgentTaskView = {
      spec: view.spec,
      status: {
        ...view.status,
        phase: patch.phase ?? view.status.phase,
        sessionId: patch.sessionId ?? view.status.sessionId,
        contributions: patch.contributions ?? view.status.contributions,
        conditions: patch.conditions ?? view.status.conditions,
        observedGeneration: patch.observedGeneration ?? view.status.observedGeneration,
        lastTransitionAt: patch.lastTransitionAt ?? view.status.lastTransitionAt,
        revision: view.status.revision + 1,
        resourceVersion: (view.status.resourceVersion ?? 1) + 1,
      },
    };
    this.specs.set(id, updated.spec);
    this.statuses.set(id, updated.status);
    return casOk(updated);
  }

  async listAgentTaskEntities(query?: AgentTaskQuery): Promise<readonly AgentTaskEntity[]> {
    const views = await this.listAgentTasks(query);
    return views.map((v) => agentTaskViewToEntity(v));
  }

  close(): void {
    /* test store */
  }
}

function makeSpecBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    worktree: "wt-test",
    runtime: "claude",
    role: "reviewer",
    prompt: "do work",
    dependsOn: [],
    ...overrides,
  };
}

describe("PUT /api/agent-tasks/:id — @Dangerous + If-Match plumbing (C6 #304)", () => {
  test("missing If-Match → 428 and store.putAgentTaskSpec not called", async () => {
    const agentTaskStore = new TestAgentTaskStore();
    // Seed an existing task so update path goes through CAS.
    await agentTaskStore.putAgentTaskSpec({
      id: "task-no-ifmatch",
      worktree: "wt",
      runtime: "claude",
      role: "reviewer",
      prompt: "seeded",
      dependsOn: [],
      generation: 0,
      createdAt: new Date().toISOString(),
    });
    const beforeCalls = agentTaskStore.putSpecCalls.length;

    const { app } = createTestApp({ agentTaskStore });
    const res = await app.request("/api/agent-tasks/task-no-ifmatch", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(makeSpecBody({ prompt: "updated" })),
    });

    expect(res.status).toBe(428);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
    // Handler must not have invoked the store.
    expect(agentTaskStore.putSpecCalls.length).toBe(beforeCalls);
    // Spec must be unchanged.
    const view = await agentTaskStore.getAgentTask("task-no-ifmatch");
    expect(view?.spec.prompt).toBe("seeded");
  });

  test("stale If-Match → 409 with current snapshot", async () => {
    const agentTaskStore = new TestAgentTaskStore();
    await agentTaskStore.putAgentTaskSpec({
      id: "task-stale",
      worktree: "wt",
      runtime: "claude",
      role: "reviewer",
      prompt: "seeded",
      dependsOn: [],
      generation: 0,
      createdAt: new Date().toISOString(),
    });
    // External mutation bumps RV from 1 → 2.
    await agentTaskStore.putAgentTaskSpec(
      {
        id: "task-stale",
        worktree: "wt",
        runtime: "claude",
        role: "reviewer",
        prompt: "rev2",
        dependsOn: [],
        generation: 0,
        createdAt: new Date().toISOString(),
      },
      { ifMatch: "1" },
    );
    expect((await agentTaskStore.getAgentTask("task-stale"))?.spec.resourceVersion).toBe(2);

    const { app } = createTestApp({ agentTaskStore });
    const res = await app.request("/api/agent-tasks/task-stale", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json", "if-match": "1" },
      body: JSON.stringify(makeSpecBody({ prompt: "rev3" })),
    });

    expect(res.status).toBe(409);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.current.resourceVersion).toBe("2");
    expect((await agentTaskStore.getAgentTask("task-stale"))?.spec.prompt).toBe("rev2");
  });

  test("fresh If-Match → 200 and store called with ifMatch", async () => {
    const agentTaskStore = new TestAgentTaskStore();
    await agentTaskStore.putAgentTaskSpec({
      id: "task-fresh",
      worktree: "wt",
      runtime: "claude",
      role: "reviewer",
      prompt: "seeded",
      dependsOn: [],
      generation: 0,
      createdAt: new Date().toISOString(),
    });

    const { app } = createTestApp({ agentTaskStore });
    const res = await app.request("/api/agent-tasks/task-fresh", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json", "if-match": "1" },
      body: JSON.stringify(makeSpecBody({ prompt: "rev2" })),
    });

    expect(res.status).toBe(200);
    expect(agentTaskStore.putSpecCalls.at(-1)).toEqual({ id: "task-fresh", ifMatch: "1" });
    const view = await agentTaskStore.getAgentTask("task-fresh");
    expect(view?.spec.resourceVersion).toBe(2);
    expect(view?.spec.prompt).toBe("rev2");
  });
});

describe("PATCH /api/agent-tasks/:id/status — @Dangerous + If-Match plumbing (C6 #304)", () => {
  test("missing If-Match → 428 and store.patchAgentTaskStatus not called", async () => {
    const agentTaskStore = new TestAgentTaskStore();
    await agentTaskStore.putAgentTaskSpec({
      id: "task-status-no-ifmatch",
      worktree: "wt",
      runtime: "claude",
      role: "reviewer",
      prompt: "seeded",
      dependsOn: [],
      generation: 0,
      createdAt: new Date().toISOString(),
    });
    const beforeCalls = agentTaskStore.patchStatusCalls.length;

    const { app } = createTestApp({ agentTaskStore, controllerToken: TEST_CONTROLLER_TOKEN });
    const res = await app.request("/api/agent-tasks/task-status-no-ifmatch/status", {
      method: "PATCH",
      headers: {
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phase: AgentTaskPhase.Running }),
    });

    expect(res.status).toBe(428);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
    expect(agentTaskStore.patchStatusCalls.length).toBe(beforeCalls);
    expect((await agentTaskStore.getAgentTask("task-status-no-ifmatch"))?.status.phase).toBe(
      AgentTaskPhase.Pending,
    );
  });

  test("stale If-Match → 409 with current snapshot", async () => {
    const agentTaskStore = new TestAgentTaskStore();
    await agentTaskStore.putAgentTaskSpec({
      id: "task-status-stale",
      worktree: "wt",
      runtime: "claude",
      role: "reviewer",
      prompt: "seeded",
      dependsOn: [],
      generation: 0,
      createdAt: new Date().toISOString(),
    });
    // External mutation bumps status RV from 1 → 2.
    await agentTaskStore.patchAgentTaskStatus(
      "task-status-stale",
      { sessionId: "session-x" },
      { ifMatch: "1" },
    );
    expect((await agentTaskStore.getAgentTask("task-status-stale"))?.status.resourceVersion).toBe(
      2,
    );

    const { app } = createTestApp({ agentTaskStore, controllerToken: TEST_CONTROLLER_TOKEN });
    const res = await app.request("/api/agent-tasks/task-status-stale/status", {
      method: "PATCH",
      headers: {
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
        "Content-Type": "application/json",
        "if-match": "1",
      },
      body: JSON.stringify({ phase: AgentTaskPhase.Running }),
    });

    expect(res.status).toBe(409);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.current.resourceVersion).toBe("2");
    expect((await agentTaskStore.getAgentTask("task-status-stale"))?.status.phase).toBe(
      AgentTaskPhase.Pending,
    );
  });

  test("fresh If-Match → 200 and store called with ifMatch", async () => {
    const agentTaskStore = new TestAgentTaskStore();
    await agentTaskStore.putAgentTaskSpec({
      id: "task-status-fresh",
      worktree: "wt",
      runtime: "claude",
      role: "reviewer",
      prompt: "seeded",
      dependsOn: [],
      generation: 0,
      createdAt: new Date().toISOString(),
    });

    const { app } = createTestApp({ agentTaskStore, controllerToken: TEST_CONTROLLER_TOKEN });
    const res = await app.request("/api/agent-tasks/task-status-fresh/status", {
      method: "PATCH",
      headers: {
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
        "Content-Type": "application/json",
        "if-match": "1",
      },
      body: JSON.stringify({ phase: AgentTaskPhase.Running }),
    });

    expect(res.status).toBe(200);
    expect(agentTaskStore.patchStatusCalls.at(-1)).toEqual({
      id: "task-status-fresh",
      ifMatch: "1",
    });
    const view = await agentTaskStore.getAgentTask("task-status-fresh");
    expect(view?.status.resourceVersion).toBe(2);
    expect(view?.status.phase).toBe(AgentTaskPhase.Running);
  });
});
