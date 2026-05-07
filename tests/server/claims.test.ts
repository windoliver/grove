import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import {
  claimBody,
  createTestContext,
  TEST_AUTH_HEADERS,
  TEST_CONTROLLER_HEADERS,
} from "./helpers.js";

describe("POST /api/claims", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("creates a claim with default lease", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.targetRef).toBe("optimize-parser");
    expect(data.status).toBe("active");
    expect(data.claimId).toBeTruthy();
  });

  test("creates a claim with custom lease duration", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ leaseDurationMs: 600_000 })),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    const leaseExpiry = new Date(data.leaseExpiresAt).getTime();
    const created = new Date(data.createdAt).getTime();
    // 10 minutes (600s) lease
    expect(leaseExpiry - created).toBeGreaterThanOrEqual(599_000);
  });

  test("renews existing claim for same agent+target", async () => {
    const body = claimBody();

    const res1 = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(201);

    // Same agent, same target → renew
    const res2 = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(201);
    const data = await res2.json();
    expect(data.status).toBe("active");
  });

  test("rejects claim on already-claimed target by different agent", async () => {
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ agent: { agentId: "agent-1" } })),
    });

    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ agent: { agentId: "agent-2" } })),
    });

    // Should be 409 Conflict
    expect(res.status).toBe(409);
  });

  test("rejects missing required fields", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ targetRef: "foo" }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects missing targetRef", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ targetRef: undefined })),
    });

    expect(res.status).toBe(400);
  });

  test("rejects empty string agentId", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ agent: { agentId: "" } })),
    });

    expect(res.status).toBe(400);
  });

  test("rejects empty string targetRef", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ targetRef: "" })),
    });

    expect(res.status).toBe(400);
  });

  test("rejects empty string intentSummary", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ intentSummary: "" })),
    });

    expect(res.status).toBe(400);
  });

  test("rejects non-positive leaseDurationMs", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ leaseDurationMs: -1 })),
    });

    expect(res.status).toBe(400);
  });
});

describe("split claim routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("PUT /api/claims/:id writes spec only and returns merged view", async () => {
    const res = await ctx.app.request("/api/claims/split-put", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.spec.id).toBe("split-put");
    expect(data.status.phase).toBe("active");
    expect(data.status.observedGeneration).toBe(0);
  });

  test("PUT /api/claims/:id rejects status-owned fields", async () => {
    const res = await ctx.app.request("/api/claims/split-put-reject", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ phase: "completed" })),
    });

    expect(res.status).toBe(400);

    const attemptCountRes = await ctx.app.request("/api/claims/split-put-reject-attempt", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ attemptCount: 2 })),
    });

    expect(attemptCountRes.status).toBe(400);
  });

  test("GET /api/claims/:id returns merged view", async () => {
    const putRes = await ctx.app.request("/api/claims/split-get", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ targetRef: "split-target" })),
    });
    expect(putRes.status).toBe(201);

    const res = await ctx.app.request("/api/claims/split-get", {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.spec.id).toBe("split-get");
    expect(data.spec.targetRef).toBe("split-target");
    expect(data.status.phase).toBe("active");
  });

  test("PATCH /api/claims/:id/status requires controller token before body validation", async () => {
    const putRes = await ctx.app.request("/api/claims/split-status-auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });
    expect(putRes.status).toBe(201);

    const res = await ctx.app.request("/api/claims/split-status-auth/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ phase: "completed" }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data).toEqual({
      error: { code: "FORBIDDEN", message: "Controller token required" },
    });

    const mismatchedRes = await ctx.app.request("/api/claims/split-status-auth/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        "X-Grove-Controller-Token": "wrong-token",
      },
      body: JSON.stringify({ phase: "completed" }),
    });

    expect(mismatchedRes.status).toBe(403);
    expect(await mismatchedRes.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Controller token required" },
    });

    const missingInvalidRes = await ctx.app.request("/api/claims/split-status-auth/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ targetRef: "different" }),
    });

    expect(missingInvalidRes.status).toBe(403);
    expect(await missingInvalidRes.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Controller token required" },
    });

    const mismatchedInvalidRes = await ctx.app.request("/api/claims/split-status-auth/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        "X-Grove-Controller-Token": "wrong-token",
      },
      body: JSON.stringify({ targetRef: "different" }),
    });

    expect(mismatchedInvalidRes.status).toBe(403);
    expect(await mismatchedInvalidRes.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Controller token required" },
    });
  });

  test("PATCH /api/claims/:id/status writes status only with controller token", async () => {
    const putRes = await ctx.app.request("/api/claims/split-status-patch", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(
        claimBody({
          targetRef: "split-preserve-target",
          intentSummary: "Preserve this spec",
          priority: 3,
        }),
      ),
    });
    expect(putRes.status).toBe(201);
    const created = await putRes.json();

    const res = await ctx.app.request("/api/claims/split-status-patch/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
      },
      body: JSON.stringify({
        phase: "completed",
        observedGeneration: created.spec.generation,
        agentSessionId: "session-1",
        currentContributionCid: "b3:work",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status.phase).toBe("completed");
    expect(data.status.observedGeneration).toBe(created.spec.generation);
    expect(data.status.agentSessionId).toBe("session-1");
    expect(data.status.currentContributionCid).toBe("b3:work");
    expect(data.spec.targetRef).toBe("split-preserve-target");
    expect(data.spec.intentSummary).toBe("Preserve this spec");
    expect(data.spec.priority).toBe(3);
    expect(data.spec.generation).toBe(created.spec.generation);
  });

  test("PATCH /api/claims/:id/status rejects spec-owned fields", async () => {
    const putRes = await ctx.app.request("/api/claims/split-status-reject", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });
    expect(putRes.status).toBe(201);

    const res = await ctx.app.request("/api/claims/split-status-reject/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
      },
      body: JSON.stringify({ phase: "completed", targetRef: "different-target" }),
    });

    expect(res.status).toBe(400);

    const createdAtRes = await ctx.app.request("/api/claims/split-status-reject/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
      },
      body: JSON.stringify({
        phase: "completed",
        createdAt: "2026-05-06T12:00:00.000Z",
      }),
    });

    expect(createdAtRes.status).toBe(400);
  });
});

describe("PATCH /api/claims/:id", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("heartbeats an active claim", async () => {
    const createRes = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "heartbeat" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("active");
  });

  test("releases an active claim", async () => {
    const createRes = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "release" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("released");
  });

  test("completes an active claim", async () => {
    const createRes = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "complete" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("completed");
  });

  test("full lifecycle: create → heartbeat → complete", async () => {
    const createRes = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });
    const created = await createRes.json();

    // Heartbeat
    const hbRes = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "heartbeat" }),
    });
    expect(hbRes.status).toBe(200);

    // Complete
    const completeRes = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "complete" }),
    });
    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json();
    expect(completed.status).toBe("completed");
  });

  test("returns 404 for non-existent claim heartbeat", async () => {
    const res = await ctx.app.request("/api/claims/nonexistent-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "heartbeat" }),
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  test("returns 404 for non-existent claim release", async () => {
    const res = await ctx.app.request("/api/claims/nonexistent-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "release" }),
    });

    expect(res.status).toBe(404);
  });

  test("returns 404 for non-existent claim complete", async () => {
    const res = await ctx.app.request("/api/claims/nonexistent-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "complete" }),
    });

    expect(res.status).toBe(404);
  });

  test("rejects invalid action value", async () => {
    const res = await ctx.app.request("/api/claims/some-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ action: "invalid" }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
  });

  test("rejects PATCH with missing action field", async () => {
    const res = await ctx.app.request("/api/claims/some-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/claims", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns empty array when no claims exist", async () => {
    const res = await ctx.app.request("/api/claims", { headers: TEST_AUTH_HEADERS });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ claims: [], count: 0 });
  });

  test("lists active claims", async () => {
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody()),
    });

    const res = await ctx.app.request("/api/claims?status=active", { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claims).toHaveLength(1);
    expect(data.claims[0].status).toBe("active");
  });

  test("filters by agentId", async () => {
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ agent: { agentId: "agent-1" } })),
    });
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify(claimBody({ agent: { agentId: "agent-2" }, targetRef: "other-target" })),
    });

    const res = await ctx.app.request("/api/claims?agentId=agent-1", {
      headers: TEST_AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claims).toHaveLength(1);
    expect(data.claims[0].agent.agentId).toBe("agent-1");
  });
});
