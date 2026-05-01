import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchHub } from "../../../src/core/watch-hub.js";
import { SqliteGoalSessionStore } from "../../../src/local/sqlite-goal-session-store.js";
import { initSqliteDb } from "../../../src/local/sqlite-store.js";
import { createApp } from "../../../src/server/app.js";
import type { ServerDeps } from "../../../src/server/deps.js";
import type { KeyRegistry } from "../../../src/server/middleware/namespace-auth.js";

interface NoContractFixture {
  readonly deps: ServerDeps;
  readonly cleanup: () => Promise<void>;
}

function makeDepsWithoutContract(): NoContractFixture {
  const dir = join(
    tmpdir(),
    `grove-sessions-no-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "grove.db");
  const db = initSqliteDb(dbPath);
  const goalSessionStore = new SqliteGoalSessionStore(db);

  const deps = {
    contributionStore: {} as never,
    claimStore: {} as never,
    bountyStore: undefined,
    outcomeStore: undefined,
    goalSessionStore,
    handoffStore: {} as never,
    handoffStoreForSession: () => ({}) as never,
    cas: {} as never,
    frontier: {} as never,
    gossip: undefined,
    topology: undefined,
    contract: undefined,
    idempotencyStore: {} as never,
    watchHub: new WatchHub(),
  } as ServerDeps;

  return {
    deps,
    cleanup: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const NC_TEST_KEY = `grv_${"e".repeat(64)}`;
const NC_TEST_NAMESPACE = "no-contract-test/main";
const NC_TEST_AUTH_HEADERS = { Authorization: `Bearer ${NC_TEST_KEY}` };
const NC_TEST_REGISTRY: KeyRegistry = new Map([[NC_TEST_KEY, NC_TEST_NAMESPACE]]);

describe("POST /api/sessions without loaded contract", () => {
  let fixture: NoContractFixture;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    fixture = makeDepsWithoutContract();
    app = createApp(fixture.deps, NC_TEST_REGISTRY);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test("with preset only → 201 with snapshotted session config", async () => {
    const resp = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...NC_TEST_AUTH_HEADERS },
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
      headers: { "Content-Type": "application/json", ...NC_TEST_AUTH_HEADERS },
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
      headers: { "Content-Type": "application/json", ...NC_TEST_AUTH_HEADERS },
      body: JSON.stringify({ goal: "test goal", preset: "does-not-exist" }),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Unknown preset");
  });
});
