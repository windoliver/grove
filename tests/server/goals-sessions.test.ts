/**
 * Tests for goal and session API routes.
 *
 * Spins up an in-process Hono server with goalSessionStore wired in,
 * then exercises the REST endpoints.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { DefaultFrontierCalculator } from "../../src/core/frontier.js";
import { FsCas } from "../../src/local/fs-cas.js";
import { createSqliteStores } from "../../src/local/sqlite-store.js";
import { createApp } from "../../src/server/app.js";
import type { ServerDeps, ServerEnv } from "../../src/server/deps.js";

// ---------------------------------------------------------------------------
// Test context with goalSessionStore
// ---------------------------------------------------------------------------

interface GoalSessionTestContext {
  readonly app: Hono<ServerEnv>;
  readonly tempDir: string;
  readonly cleanup: () => Promise<void>;
}

async function createGoalSessionContext(): Promise<GoalSessionTestContext> {
  const tempDir = await mkdtemp(join(tmpdir(), "grove-goals-test-"));
  const dbPath = join(tempDir, "test.db");
  const casDir = join(tempDir, "cas");

  const stores = createSqliteStores(dbPath);
  const cas = new FsCas(casDir);
  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  const deps: ServerDeps = {
    contributionStore: stores.contributionStore,
    claimStore: stores.claimStore,
    outcomeStore: stores.outcomeStore,
    cas,
    frontier,
    goalSessionStore: stores.goalSessionStore,
  };

  const app = createApp(deps);

  return {
    app,
    tempDir,
    cleanup: async () => {
      stores.close();
      cas.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let ctx: GoalSessionTestContext;

beforeEach(async () => {
  ctx = await createGoalSessionContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

describe("PUT /api/session/goal", () => {
  test("creates a goal", async () => {
    const res = await ctx.app.request("/api/session/goal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Ship feature X",
        acceptance: ["Tests pass", "Docs updated"],
        setBy: "operator",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.goal).toBe("Ship feature X");
    expect(data.acceptance).toEqual(["Tests pass", "Docs updated"]);
    expect(data.status).toBe("active");
    expect(data.setBy).toBe("operator");
  });

  test("validates input (missing goal field returns 400)", async () => {
    const res = await ctx.app.request("/api/session/goal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        acceptance: ["Something"],
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  test("accepts missing acceptance field (defaults to empty array)", async () => {
    const res = await ctx.app.request("/api/session/goal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Ship it",
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { goal: string; acceptance: string[] };
    expect(data.goal).toBe("Ship it");
    expect(data.acceptance).toEqual([]);
  });

  test("accepts empty acceptance array (goal without criteria)", async () => {
    const res = await ctx.app.request("/api/session/goal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Ship it",
        acceptance: [],
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { goal: string; acceptance: string[] };
    expect(data.goal).toBe("Ship it");
    expect(data.acceptance).toEqual([]);
  });
});

describe("GET /api/session/goal", () => {
  test("returns 404 when no goal set", async () => {
    const res = await ctx.app.request("/api/session/goal");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  test("returns the goal after it has been set", async () => {
    // Set a goal first
    await ctx.app.request("/api/session/goal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Build the widget",
        acceptance: ["Widget works"],
      }),
    });

    const res = await ctx.app.request("/api/session/goal");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.goal).toBe("Build the widget");
    expect(data.acceptance).toEqual(["Widget works"]);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("POST /api/sessions", () => {
  test("creates a session", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.sessionId).toBeTruthy();
    expect(data.status).toBe("active");
    expect(data.contributionCount).toBe(0);
  });

  test("creates a session with goal", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Fix all bugs" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.goal).toBe("Fix all bugs");
  });
});

describe("GET /api/sessions", () => {
  test("lists sessions", async () => {
    // Create two sessions
    await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Session 2" }),
    });

    const res = await ctx.app.request("/api/sessions");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toBeDefined();
    expect(data.sessions.length).toBe(2);
  });

  test("filters by status=active", async () => {
    // Create two sessions, archive one
    const res1 = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const s1 = await res1.json();

    await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Archive the first
    await ctx.app.request(`/api/sessions/${s1.sessionId}/archive`, {
      method: "PUT",
    });

    const res = await ctx.app.request("/api/sessions?status=active");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions.length).toBe(1);
  });
});

describe("GET /api/sessions/:id", () => {
  test("returns session by ID", async () => {
    const createRes = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "My session" }),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/sessions/${created.sessionId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toBe(created.sessionId);
    expect(data.goal).toBe("My session");
  });

  test("returns 404 for missing session", async () => {
    const res = await ctx.app.request("/api/sessions/nonexistent-id");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });
});

describe("PUT /api/sessions/:id/archive", () => {
  test("archives a session", async () => {
    const createRes = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/sessions/${created.sessionId}/archive`, {
      method: "PUT",
    });
    expect(res.status).toBe(204);

    // Verify archived
    const getRes = await ctx.app.request(`/api/sessions/${created.sessionId}`);
    const data = await getRes.json();
    expect(data.status).toBe("archived");
    expect(data.endedAt).toBeTruthy();
  });

  test("returns 404 for missing session", async () => {
    const res = await ctx.app.request("/api/sessions/nonexistent-id/archive", {
      method: "PUT",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/contributions", () => {
  test("adds contribution to session", async () => {
    const createRes = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/sessions/${created.sessionId}/contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid: "blake3:abc123" }),
    });
    expect(res.status).toBe(204);

    // Verify contribution count increased
    const getRes = await ctx.app.request(`/api/sessions/${created.sessionId}`);
    const data = await getRes.json();
    expect(data.contributionCount).toBe(1);
  });

  test("returns 404 for missing session", async () => {
    const res = await ctx.app.request("/api/sessions/nonexistent-id/contributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid: "blake3:abc" }),
    });
    expect(res.status).toBe(404);
  });

  test("validates input (missing cid returns 400)", async () => {
    const createRes = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const created = await createRes.json();

    const res = await ctx.app.request(`/api/sessions/${created.sessionId}/contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
