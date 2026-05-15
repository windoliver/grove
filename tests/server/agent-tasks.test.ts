import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AgentTaskPhase,
  type AgentTaskView,
  agentTaskViewToEntity,
} from "../../src/core/agent-task.js";
import { Finalizer } from "../../src/core/lifecycle-metadata.js";
import type { AgentTaskStore } from "../../src/core/store.js";
import type { EntityWriteEvent } from "../../src/core/watch-events.js";
import type { TestContext } from "./helpers.js";
import {
  createTestContext,
  TEST_AUTH_HEADERS,
  TEST_CONTROLLER_HEADERS,
  TEST_NAMESPACE,
} from "./helpers.js";

const SPEC_BODY = {
  worktree: "/tmp/worktree",
  runtime: "codex",
  role: "worker",
  prompt: "Implement issue 297",
  dependsOn: ["task-a"],
  maxTurns: 4,
  budget: { usd: 3 },
};

function captureWatchWrites(ctx: TestContext): EntityWriteEvent[] {
  const events: EntityWriteEvent[] = [];
  const original = ctx.deps.watchHub.recordWrite.bind(ctx.deps.watchHub);
  ctx.deps.watchHub.recordWrite = (event: EntityWriteEvent) => {
    events.push(event);
    return original(event);
  };
  return events;
}

type AgentTaskWriteCallback = (op: "ADDED" | "MODIFIED", view: AgentTaskView) => void;
type ObservableAgentTaskStore = AgentTaskStore & {
  onAgentTaskWrite?: AgentTaskWriteCallback | undefined;
};

function asObservableAgentTaskStore(store: AgentTaskStore): ObservableAgentTaskStore {
  return store as ObservableAgentTaskStore;
}

describe("Agent task routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("PUT /api/agent-tasks/:id writes spec only and returns merged view", async () => {
    const res = await ctx.app.request("/api/agent-tasks/task-put", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(SPEC_BODY),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.spec.id).toBe("task-put");
    expect(data.spec.prompt).toBe("Implement issue 297");
    expect(data.spec.generation).toBe(1);
    expect(data.status.phase).toBe(AgentTaskPhase.Pending);
    expect(data.status.observedGeneration).toBe(0);
  });

  test("PUT /api/agent-tasks/:id emits AgentTask watch writes for create and update", async () => {
    const events = captureWatchWrites(ctx);
    expect(ctx.deps.watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(0n);

    const createRes = await ctx.app.request("/api/agent-tasks/task-watch-put", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(SPEC_BODY),
    });

    expect(createRes.status).toBe(201);
    expect(ctx.deps.watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(1n);

    const updateRes = await ctx.app.request("/api/agent-tasks/task-watch-put", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ ...SPEC_BODY, prompt: "Updated prompt" }),
    });

    expect(updateRes.status).toBe(200);
    expect(ctx.deps.watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(2n);
    expect(events.map((event) => event.op)).toEqual(["ADDED", "MODIFIED"]);
    expect(events.map((event) => event.kind)).toEqual(["AgentTask", "AgentTask"]);
    expect(events.map((event) => event.namespace)).toEqual([TEST_NAMESPACE, TEST_NAMESPACE]);
    expect(events[0]?.entity.id).toBe("task-watch-put");
    expect(events[0]?.entity.metadata.generation).toBe(1);
    expect(events[1]?.entity.id).toBe("task-watch-put");
    expect(events[1]?.entity.metadata.generation).toBe(2);
    expect(events[1]?.entity.spec.prompt).toBe("Updated prompt");
  });

  test("PUT /api/agent-tasks/:id does not double-publish when store write fan-out is wired", async () => {
    const events = captureWatchWrites(ctx);
    asObservableAgentTaskStore(ctx.agentTaskStore).onAgentTaskWrite = (op, view) => {
      ctx.deps.watchHub.recordWrite({
        kind: "AgentTask",
        namespace: TEST_NAMESPACE,
        op,
        entity: agentTaskViewToEntity(view, TEST_NAMESPACE),
      });
    };

    const createRes = await ctx.app.request("/api/agent-tasks/task-watch-store", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(SPEC_BODY),
    });

    expect(createRes.status).toBe(201);
    expect(ctx.deps.watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(1n);
    expect(events.map((event) => event.op)).toEqual(["ADDED"]);
  });

  test("PUT /api/agent-tasks/:id rejects status-owned fields from the TUI path", async () => {
    const res = await ctx.app.request("/api/agent-tasks/task-status-rejected", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        ...SPEC_BODY,
        phase: AgentTaskPhase.Succeeded,
        observedGeneration: 1,
        conditions: [],
      }),
    });

    expect(res.status).toBe(400);
  });

  test("PUT /api/agent-tasks/:id preserves existing lifecycle metadata", async () => {
    await ctx.agentTaskStore.putAgentTaskSpec({
      id: "task-metadata",
      ...SPEC_BODY,
      generation: 0,
      ownerRef: { kind: "session", id: "session-1", uid: "uid-1" },
      finalizers: [Finalizer.ReleaseSlots],
      deletionTimestamp: "2026-05-13T13:00:00.000Z",
      createdAt: "2026-05-13T12:00:00.000Z",
    });

    const res = await ctx.app.request("/api/agent-tasks/task-metadata", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ ...SPEC_BODY, prompt: "Updated prompt" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.spec.prompt).toBe("Updated prompt");
    expect(data.spec.ownerRef).toEqual({ kind: "session", id: "session-1", uid: "uid-1" });
    expect(data.spec.finalizers).toEqual([Finalizer.ReleaseSlots]);
    expect(data.spec.deletionTimestamp).toBe("2026-05-13T13:00:00.000Z");
  });

  test("PATCH /api/agent-tasks/:id/status requires controller token before body validation", async () => {
    const putRes = await ctx.app.request("/api/agent-tasks/task-status-auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(SPEC_BODY),
    });
    expect(putRes.status).toBe(201);

    const res = await ctx.app.request("/api/agent-tasks/task-status-auth/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ phase: AgentTaskPhase.Running }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Controller token required" },
    });
  });

  test("PATCH /api/agent-tasks/:id/status writes status only with controller token", async () => {
    const putRes = await ctx.app.request("/api/agent-tasks/task-status-patch", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(SPEC_BODY),
    });
    expect(putRes.status).toBe(201);
    const created = await putRes.json();

    const res = await ctx.app.request("/api/agent-tasks/task-status-patch/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
      },
      body: JSON.stringify({
        phase: AgentTaskPhase.Running,
        observedGeneration: created.spec.generation,
        sessionId: "session-1",
        conditions: [
          {
            type: "Bound",
            status: "True",
            observedGeneration: created.spec.generation,
            lastTransitionTime: "2026-05-13T12:00:00.000Z",
            reason: "session-bound",
            message: "Started session-1",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status.phase).toBe(AgentTaskPhase.Running);
    expect(data.status.observedGeneration).toBe(created.spec.generation);
    expect(data.status.sessionId).toBe("session-1");
    expect(data.status.conditions[0].message).toBe("Started session-1");
    expect(data.spec.prompt).toBe("Implement issue 297");
    expect(data.spec.generation).toBe(created.spec.generation);
  });

  test("PATCH /api/agent-tasks/:id/status emits AgentTask MODIFIED watch write", async () => {
    const events = captureWatchWrites(ctx);

    const putRes = await ctx.app.request("/api/agent-tasks/task-watch-status-source", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(SPEC_BODY),
    });
    expect(putRes.status).toBe(201);
    const created = await putRes.json();
    expect(ctx.deps.watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(1n);

    const patchRes = await ctx.app.request("/api/agent-tasks/task-watch-status-source/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
      },
      body: JSON.stringify({
        phase: AgentTaskPhase.Running,
        observedGeneration: created.spec.generation,
        sessionId: "session-watch",
      }),
    });

    expect(patchRes.status).toBe(200);
    expect(ctx.deps.watchHub.currentRv(TEST_NAMESPACE, "AgentTask")).toBe(2n);
    expect(events.map((event) => event.op)).toEqual(["ADDED", "MODIFIED"]);
    const statusEvent = events[1];
    expect(statusEvent?.kind).toBe("AgentTask");
    expect(statusEvent?.namespace).toBe(TEST_NAMESPACE);
    expect(statusEvent?.entity.id).toBe("task-watch-status-source");
    expect(statusEvent?.entity.metadata.generation).toBe(created.spec.generation);
    expect(statusEvent?.entity.status.phase).toBe(AgentTaskPhase.Running);
    expect(statusEvent?.entity.status.sessionId).toBe("session-watch");
  });

  test("GET /api/list supports AgentTask snapshots", async () => {
    await ctx.agentTaskStore.putAgentTaskSpec({
      id: "task-watch-list",
      ...SPEC_BODY,
      generation: 0,
      createdAt: "2026-05-14T12:00:00.000Z",
    });

    const res = await ctx.app.request("/api/list?kind=AgentTask", {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items[0].kind).toBe("AgentTask");
    expect(data.items[0].id).toBe("task-watch-list");
    expect(data.items[0].namespace).toBe(TEST_NAMESPACE);
  });
});
