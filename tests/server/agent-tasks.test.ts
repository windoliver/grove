import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentTaskPhase } from "../../src/core/agent-task.js";
import { Finalizer } from "../../src/core/lifecycle-metadata.js";
import type { TestContext } from "./helpers.js";
import { createTestContext, TEST_AUTH_HEADERS, TEST_CONTROLLER_HEADERS } from "./helpers.js";

const SPEC_BODY = {
  worktree: "/tmp/worktree",
  runtime: "codex",
  role: "worker",
  prompt: "Implement issue 297",
  dependsOn: ["task-a"],
  maxTurns: 4,
  budget: { usd: 3 },
};

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
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS, "If-Match": "1" },
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

  test("PUT /api/agent-tasks/:id rejects status-owned fields from the TUI path", async () => {
    const res = await ctx.app.request("/api/agent-tasks/task-status-rejected", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS, "If-Match": "1" },
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
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS, "If-Match": "1" },
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
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS, "If-Match": "1" },
      body: JSON.stringify(SPEC_BODY),
    });
    expect(putRes.status).toBe(201);

    // Controller-token check runs BEFORE the dangerous() guard, so absence
    // of If-Match should not affect the 403 outcome here.
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
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS, "If-Match": "1" },
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
        "If-Match": "1",
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
});
