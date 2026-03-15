import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { claimBody, createTestContext } from "./helpers.js";

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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(201);

    // Same agent, same target → renew
    const res2 = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(201);
    const data = await res2.json();
    expect(data.status).toBe("active");
  });

  test("rejects claim on already-claimed target by different agent", async () => {
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody({ agent: { agentId: "agent-1" } })),
    });

    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody({ agent: { agentId: "agent-2" } })),
    });

    // Should be 409 Conflict
    expect(res.status).toBe(409);
  });

  test("rejects missing required fields", async () => {
    const res = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRef: "foo" }),
    });

    expect(res.status).toBe(400);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("active");
  });

  test("releases an active claim", async () => {
    const createRes = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("released");
  });

  test("completes an active claim", async () => {
    const createRes = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody()),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("completed");
  });

  test("full lifecycle: create → heartbeat → complete", async () => {
    const createRes = await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody()),
    });
    const created = await createRes.json();

    // Heartbeat
    const hbRes = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });
    expect(hbRes.status).toBe(200);

    // Complete
    const completeRes = await ctx.app.request(`/api/claims/${created.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete" }),
    });
    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json();
    expect(completed.status).toBe("completed");
  });

  test("returns error for non-existent claim", async () => {
    const res = await ctx.app.request("/api/claims/nonexistent-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });

    // Store throws "not found" → error handler maps to 404
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("rejects invalid action", async () => {
    const res = await ctx.app.request("/api/claims/some-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
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
    const res = await ctx.app.request("/api/claims");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ claims: [], count: 0 });
  });

  test("lists active claims", async () => {
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody()),
    });

    const res = await ctx.app.request("/api/claims?status=active");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claims).toHaveLength(1);
    expect(data.claims[0].status).toBe("active");
  });

  test("filters by agentId", async () => {
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody({ agent: { agentId: "agent-1" } })),
    });
    await ctx.app.request("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody({ agent: { agentId: "agent-2" }, targetRef: "other-target" })),
    });

    const res = await ctx.app.request("/api/claims?agentId=agent-1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claims).toHaveLength(1);
    expect(data.claims[0].agent.agentId).toBe("agent-1");
  });
});
