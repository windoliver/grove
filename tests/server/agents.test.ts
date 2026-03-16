import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestContext } from "./helpers.js";
import { createTestContext } from "./helpers.js";

// ---------------------------------------------------------------------------
// POST /api/agents/spawn
// ---------------------------------------------------------------------------

describe("POST /api/agents/spawn", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("valid spawn request succeeds", async () => {
    const res = await ctx.app.request("/api/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "researcher" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claimId).toBeString();
    expect(data.agentId).toBeString();
    expect(data.agentId).toStartWith("remote-researcher-");
    expect(data.role).toBe("researcher");
    expect(data.status).toBe("spawned");
  });

  test("missing role field returns 400", async () => {
    const res = await ctx.app.request("/api/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("empty role field returns 400 (Zod min(1) validation)", async () => {
    const res = await ctx.app.request("/api/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "" }),
    });

    expect(res.status).toBe(400);
  });

  test("extra unknown fields are handled gracefully", async () => {
    const res = await ctx.app.request("/api/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "builder", unknownField: "ignored" }),
    });

    // Zod strips unknown fields by default; the request should still succeed
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.role).toBe("builder");
    expect(data.status).toBe("spawned");
  });

  test("optional fields (command, targetRef, context) work when provided", async () => {
    const res = await ctx.app.request("/api/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "deployer",
        command: "deploy --production",
        targetRef: "release-v2.0",
        context: { branch: "main", priority: 1 },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.role).toBe("deployer");
    expect(data.claimId).toBeString();
    expect(data.agentId).toStartWith("remote-deployer-");
    expect(data.status).toBe("spawned");
  });

  test("capacity limit returns 503 when at max claims", async () => {
    // The max slots constant in agents.ts is 8.
    // Fill all 8 slots by spawning 8 agents.
    for (let i = 0; i < 8; i++) {
      const res = await ctx.app.request("/api/agents/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: `worker` }),
      });
      expect(res.status).toBe(200);
    }

    // The 9th request should be rejected with 503
    const res = await ctx.app.request("/api/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "worker" }),
    });

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe("at capacity");
    expect(data.activeAgents).toBe(8);
    expect(data.maxSlots).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents/capacity
// ---------------------------------------------------------------------------

describe("GET /api/agents/capacity", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("returns correct slot counts when no claims exist", async () => {
    const res = await ctx.app.request("/api/agents/capacity");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalSlots).toBe(8);
    expect(data.usedSlots).toBe(0);
    expect(data.freeSlots).toBe(8);
  });

  test("returns correct slot counts when some claims exist", async () => {
    // Spawn 3 agents to create 3 active claims
    for (let i = 0; i < 3; i++) {
      const spawnRes = await ctx.app.request("/api/agents/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "worker" }),
      });
      expect(spawnRes.status).toBe(200);
    }

    const res = await ctx.app.request("/api/agents/capacity");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalSlots).toBe(8);
    expect(data.usedSlots).toBe(3);
    expect(data.freeSlots).toBe(5);
  });
});
