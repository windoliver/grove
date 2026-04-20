import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGoalSessionStore } from "../../../src/local/sqlite-goal-session-store.js";
import { initSqliteDb } from "../../../src/local/sqlite-store.js";
import { createApp } from "../../../src/server/app.js";
import type { ServerDeps } from "../../../src/server/deps.js";

function makeDepsWithoutContract(): ServerDeps {
  const dir = join(
    tmpdir(),
    `grove-sessions-no-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "grove.db");
  const db = initSqliteDb(dbPath);
  const goalSessionStore = new SqliteGoalSessionStore(db);

  return {
    contributionStore: {} as never,
    claimStore: {} as never,
    bountyStore: undefined as never,
    outcomeStore: undefined,
    goalSessionStore,
    handoffStore: {} as never,
    handoffStoreForSession: () => ({}) as never,
    cas: {} as never,
    frontier: {} as never,
    gossip: undefined,
    topology: undefined,
    contract: undefined, // <-- no GROVE.md loaded
    idempotencyStore: {} as never,
  } as ServerDeps;
}

describe("POST /api/sessions without loaded contract", () => {
  let deps: ServerDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = makeDepsWithoutContract();
    app = createApp(deps);
  });

  test("with preset only → 201 with snapshotted session config", async () => {
    const resp = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test goal", preset: "review-loop" }),
    });

    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.sessionId).toBeDefined();
    expect(body.config).toBeDefined();
    expect(body.config.topology?.structure).toBe("graph");
    expect(body.config.concurrency?.maxActiveClaims).toBe(4);
  });

  test("with neither preset nor contract → 400", async () => {
    const resp = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test goal" }),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("contract or preset required");
  });

  test("with unknown preset → 400", async () => {
    const resp = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test goal", preset: "does-not-exist" }),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Unknown preset");
  });
});
