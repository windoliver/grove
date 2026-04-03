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
    contract: { contractVersion: 3, name: "test-contract" },
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

// ---------------------------------------------------------------------------
// Topology and Preset
// ---------------------------------------------------------------------------

describe("POST /api/sessions — topology and preset", () => {
  test("creates session with preset field", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "review-loop" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.sessionId).toBeTruthy();
    expect(data.presetName).toBe("review-loop");
    // Topology should be resolved from the review-loop preset
    expect(data.topology).toBeDefined();
    expect(data.topology.structure).toBe("graph");
    expect(data.topology.roles.length).toBeGreaterThanOrEqual(2);
    // Roles should include coder and reviewer (camelCase in response)
    const roleNames = data.topology.roles.map((r: { name: string }) => r.name);
    expect(roleNames).toContain("coder");
    expect(roleNames).toContain("reviewer");
  });

  test("creates session with inline topology", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topology: {
          structure: "flat",
          roles: [{ name: "worker", description: "Does the work" }],
        },
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.sessionId).toBeTruthy();
    expect(data.topology).toBeDefined();
    expect(data.topology.structure).toBe("flat");
    expect(data.topology.roles).toHaveLength(1);
    expect(data.topology.roles[0].name).toBe("worker");
  });

  test("rejects unknown preset name", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "nonexistent-preset" }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(data.error.message).toContain("nonexistent-preset");
  });

  test("GET /:id includes topology for preset session", async () => {
    // Create with preset
    const createRes = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "review-loop" }),
    });
    const created = await createRes.json();

    // GET by ID should include topology
    const res = await ctx.app.request(`/api/sessions/${created.sessionId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.topology).toBeDefined();
    expect(data.topology.structure).toBe("graph");
    expect(data.topology.roles.length).toBeGreaterThanOrEqual(2);
  });

  test("GET / (list) omits topology", async () => {
    // Create a session with preset (which has topology)
    await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "review-loop" }),
    });

    // List should NOT include topology (it is omitted for performance)
    const res = await ctx.app.request("/api/sessions");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
    for (const session of data.sessions) {
      expect(session.topology).toBeUndefined();
    }
  });

  test("inline topology overrides preset", async () => {
    const inlineTopology = {
      structure: "flat" as const,
      roles: [{ name: "custom-worker", description: "Custom worker" }],
    };

    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "review-loop",
        topology: inlineTopology,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    // The inline topology should win over the preset
    expect(data.topology).toBeDefined();
    expect(data.topology.structure).toBe("flat");
    expect(data.topology.roles).toHaveLength(1);
    expect(data.topology.roles[0].name).toBe("custom-worker");
  });

  test("creates session with goal + preset", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Fix bugs",
        preset: "review-loop",
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.goal).toBe("Fix bugs");
    expect(data.presetName).toBe("review-loop");
    expect(data.topology).toBeDefined();
    expect(data.topology.structure).toBe("graph");
  });
});

// ---------------------------------------------------------------------------
// Session Config (server snapshots its own contract)
// ---------------------------------------------------------------------------

describe("POST /api/sessions (config snapshot)", () => {
  test("session creation snapshots server contract as config", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Config snapshot test" }),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as { sessionId: string };
    expect(data.sessionId).toBeDefined();

    // Retrieve the session and check config is stored
    const getRes = await ctx.app.request(`/api/sessions/${data.sessionId}`);
    expect(getRes.status).toBe(200);
  });

  test("session creation without server contract returns 501", async () => {
    // Create a context without contract
    const tempDir2 = await (await import("node:fs/promises")).mkdtemp(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "grove-no-contract-"),
    );
    const stores2 = createSqliteStores((await import("node:path")).join(tempDir2, "test.db"));
    const cas2 = new FsCas((await import("node:path")).join(tempDir2, "cas"));
    const frontier2 = new DefaultFrontierCalculator(stores2.contributionStore);
    const deps2: ServerDeps = {
      contributionStore: stores2.contributionStore,
      claimStore: stores2.claimStore,
      cas: cas2,
      frontier: frontier2,
      goalSessionStore: stores2.goalSessionStore,
      // No contract!
    };
    const app2 = createApp(deps2);

    const res = await app2.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Should fail" }),
    });

    expect(res.status).toBe(501);
    stores2.close();
    cas2.close();
    await (await import("node:fs/promises")).rm(tempDir2, { recursive: true, force: true });
  });

  test("GET /api/grove/contract returns configured contract", async () => {
    const res = await ctx.app.request("/api/grove/contract");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("test-contract");
  });

  test("GET /api/grove/contract returns 404 when no contract", async () => {
    const tempDir3 = await (await import("node:fs/promises")).mkdtemp(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "grove-no-contract2-"),
    );
    const stores3 = createSqliteStores((await import("node:path")).join(tempDir3, "test.db"));
    const cas3 = new FsCas((await import("node:path")).join(tempDir3, "cas"));
    const frontier3 = new DefaultFrontierCalculator(stores3.contributionStore);
    const deps3: ServerDeps = {
      contributionStore: stores3.contributionStore,
      claimStore: stores3.claimStore,
      cas: cas3,
      frontier: frontier3,
    };
    const app3 = createApp(deps3);

    const res = await app3.request("/api/grove/contract");
    expect(res.status).toBe(404);
    stores3.close();
    cas3.close();
    await (await import("node:fs/promises")).rm(tempDir3, { recursive: true, force: true });
  });

  test("session config persists through full lifecycle", async () => {
    // Create session
    const createRes = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Lifecycle test" }),
    });
    expect(createRes.status).toBe(201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Archive session
    const archiveRes = await ctx.app.request(`/api/sessions/${sessionId}/archive`, {
      method: "PUT",
    });
    expect(archiveRes.status).toBe(204);

    // Config should still be retrievable
    const getRes = await ctx.app.request(`/api/sessions/${sessionId}`);
    expect(getRes.status).toBe(200);
  });
});
