/**
 * Tests for SqliteGoalSessionStore.
 *
 * Uses real SQLite in temp directories for integration-level coverage.
 * Includes the SessionStore conformance suite via an adapter.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionStore } from "../core/session.js";
import { sessionStoreConformance } from "../core/session-store.conformance.js";
import type { GoalSessionStore, SqliteGoalSessionStore } from "./sqlite-goal-session-store.js";
import { createSqliteStores } from "./sqlite-store.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let stores: ReturnType<typeof createSqliteStores>;
let store: SqliteGoalSessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-goal-session-test-"));
  const dbPath = join(tempDir, "grove.db");
  stores = createSqliteStores(dbPath);
  store = stores.goalSessionStore;
});

afterEach(() => {
  stores.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

describe("Goals", () => {
  it("getGoal() returns undefined when no goal set", async () => {
    const goal = await store.getGoal();
    expect(goal).toBeUndefined();
  });

  it("setGoal() creates and returns a goal", async () => {
    const result = await store.setGoal(
      "Ship feature X",
      ["Tests pass", "Docs updated"],
      "operator",
    );
    expect(result.goal).toBe("Ship feature X");
    expect(result.acceptance).toEqual(["Tests pass", "Docs updated"]);
    expect(result.status).toBe("active");
    expect(result.setBy).toBe("operator");
    expect(typeof result.setAt).toBe("string");
  });

  it("setGoal() upserts (second call updates)", async () => {
    await store.setGoal("Goal v1", ["Criterion A"], "user-1");
    const updated = await store.setGoal("Goal v2", ["Criterion B", "Criterion C"], "user-2");

    expect(updated.goal).toBe("Goal v2");
    expect(updated.acceptance).toEqual(["Criterion B", "Criterion C"]);
    expect(updated.setBy).toBe("user-2");

    // Verify via getGoal
    const fetched = await store.getGoal();
    expect(fetched).toBeDefined();
    expect(fetched!.goal).toBe("Goal v2");
  });

  it("Goal has correct acceptance array (parsed from JSON)", async () => {
    const acceptance = ["PR merged", "Tests green", "No regressions"];
    await store.setGoal("Ship it", acceptance, "ops");

    const goal = await store.getGoal();
    expect(goal).toBeDefined();
    expect(Array.isArray(goal!.acceptance)).toBe(true);
    expect(goal!.acceptance).toEqual(acceptance);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("Sessions", () => {
  it("createSession() creates with auto-generated ID", async () => {
    const session = await store.createSession({});
    expect(session.id).toBeTruthy();
    expect(typeof session.id).toBe("string");
    expect(session.status).toBe("active");
    expect(session.contributionCount).toBe(0);
    expect(typeof session.createdAt).toBe("string");
    expect(session.completedAt).toBeUndefined();
  });

  it("createSession() with goal parameter", async () => {
    const session = await store.createSession({ goal: "Fix all the bugs" });
    expect(session.goal).toBe("Fix all the bugs");
  });

  it("listSessions() returns all sessions", async () => {
    await store.createSession({});
    await store.createSession({ goal: "Session 2" });

    const sessions = await store.listSessions();
    expect(sessions.length).toBe(2);
  });

  it("listSessions({ status: 'active' }) filters", async () => {
    const s1 = await store.createSession({});
    await store.createSession({});
    await store.archiveSession(s1.id);

    const active = await store.listSessions({ status: "active" });
    expect(active.length).toBe(1);

    const archived = await store.listSessions({ status: "archived" });
    expect(archived.length).toBe(1);
  });

  it("getSession() returns by ID", async () => {
    const created = await store.createSession({ goal: "Test goal" });
    const fetched = await store.getSession(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.goal).toBe("Test goal");
    expect(fetched!.status).toBe("active");
  });

  it("getSession() returns undefined for missing", async () => {
    const fetched = await store.getSession("nonexistent-id");
    expect(fetched).toBeUndefined();
  });

  it("archiveSession() changes status", async () => {
    const session = await store.createSession({});
    await store.archiveSession(session.id);

    const fetched = await store.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.status).toBe("archived");
  });

  it("archiveSession() sets ended_at", async () => {
    const session = await store.createSession({});
    await store.archiveSession(session.id);

    const fetched = await store.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.completedAt).toBeDefined();
    expect(typeof fetched!.completedAt).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Session Contributions
// ---------------------------------------------------------------------------

describe("Session Contributions", () => {
  it("addContributionToSession() links a CID", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:abc123");

    const cids = await store.getSessionContributions(session.id);
    expect(cids).toEqual(["blake3:abc123"]);
  });

  it("getSessionContributions() returns linked CIDs", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:aaa");
    await store.addContributionToSession(session.id, "blake3:bbb");
    await store.addContributionToSession(session.id, "blake3:ccc");

    const cids = await store.getSessionContributions(session.id);
    expect(cids.length).toBe(3);
    expect(cids).toContain("blake3:aaa");
    expect(cids).toContain("blake3:bbb");
    expect(cids).toContain("blake3:ccc");
  });

  it("addContributionToSession() is idempotent (duplicate CID ignored)", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:dup");
    await store.addContributionToSession(session.id, "blake3:dup");

    const cids = await store.getSessionContributions(session.id);
    expect(cids.length).toBe(1);
  });

  it("SessionRecord.contributionCount reflects count", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:c1");
    await store.addContributionToSession(session.id, "blake3:c2");

    const fetched = await store.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.contributionCount).toBe(2);
  });

  it("archiving doesn't remove contributions", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:kept");
    await store.archiveSession(session.id);

    const cids = await store.getSessionContributions(session.id);
    expect(cids).toEqual(["blake3:kept"]);

    const fetched = await store.getSession(session.id);
    expect(fetched!.contributionCount).toBe(1);
    expect(fetched!.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// Session Config (config round-trip)
// ---------------------------------------------------------------------------

describe("Session Config", () => {
  const sampleConfig = {
    contractVersion: 3,
    name: "test-config",
    mode: "evaluation" as const,
    metrics: {
      accuracy: { direction: "maximize" as const },
    },
  };

  it("createSession() stores config and getSession() returns it", async () => {
    const session = await store.createSession({
      goal: "Config test",
      config: sampleConfig as import("../core/contract.js").GroveContract,
    });
    expect(session.config).toBeDefined();
    expect(session.config?.name).toBe("test-config");

    const fetched = await store.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.config).toBeDefined();
    expect(fetched!.config?.name).toBe("test-config");
    expect(fetched!.config?.mode).toBe("evaluation");
  });

  it("createSession() without config stores empty config", async () => {
    const session = await store.createSession({ goal: "No config" });
    expect(session.config).toBeUndefined();

    const fetched = await store.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.config).toBeUndefined();
  });

  it("listSessions() omits config for performance", async () => {
    await store.createSession({
      goal: "Has config",
      config: sampleConfig as import("../core/contract.js").GroveContract,
    });
    const sessions = await store.listSessions();
    expect(sessions.length).toBe(1);
    // config should not be present in list results
    expect(sessions[0]!.config).toBeUndefined();
  });

  it("getSessionConfig() returns config by ID", async () => {
    const session = await store.createSession({
      goal: "Config lookup",
      config: sampleConfig as import("../core/contract.js").GroveContract,
    });
    const config = await store.getSessionConfig(session.id);
    expect(config).toBeDefined();
    expect(config?.name).toBe("test-config");
  });

  it("getSessionConfig() returns undefined for session without config", async () => {
    const session = await store.createSession({ goal: "No config" });
    const config = await store.getSessionConfig(session.id);
    expect(config).toBeUndefined();
  });

  it("getSessionConfigSync() returns config synchronously", async () => {
    const session = await store.createSession({
      goal: "Sync config",
      config: sampleConfig as import("../core/contract.js").GroveContract,
    });
    const config = store.getSessionConfigSync(session.id);
    expect(config).toBeDefined();
    expect(config?.name).toBe("test-config");
  });

  it("getSessionConfigSync() returns undefined for missing session", () => {
    const config = store.getSessionConfigSync("nonexistent-id");
    expect(config).toBeUndefined();
  });

  it("config survives JSON round-trip with complex fields", async () => {
    const complexConfig = {
      contractVersion: 3,
      name: "complex",
      mode: "evaluation" as const,
      metrics: {
        loss: { direction: "minimize" as const, unit: "%" },
        accuracy: { direction: "maximize" as const },
      },
      gates: [{ type: "metric_improves" as const, metric: "loss" }],
      stopConditions: { maxContributions: 100 },
      topology: {
        structure: "flat" as const,
        roles: [{ name: "worker", description: "Does work", platform: "claude-code" as const }],
      },
    };
    const session = await store.createSession({
      goal: "Complex config",
      config: complexConfig as unknown as import("../core/contract.js").GroveContract,
    });
    const fetched = await store.getSession(session.id);
    expect(fetched!.config?.metrics?.loss?.direction).toBe("minimize");
    expect(fetched!.config?.topology?.roles[0]?.name).toBe("worker");
  });

  it("config with undefined fields round-trips correctly", async () => {
    const minimalConfig = {
      contractVersion: 3,
      name: "minimal",
    };
    const session = await store.createSession({
      goal: "Minimal config",
      config: minimalConfig as import("../core/contract.js").GroveContract,
    });
    const fetched = await store.getSession(session.id);
    expect(fetched!.config?.name).toBe("minimal");
    expect(fetched!.config?.metrics).toBeUndefined();
    expect(fetched!.config?.topology).toBeUndefined();
  });

  it("getSessionConfig returns undefined for malformed config_json", async () => {
    // Insert a session with malformed config_json directly
    stores.db.run(
      "INSERT INTO sessions (session_id, goal, config_json, status, started_at) VALUES (?, ?, ?, 'active', ?)",
      ["bad-config", "test", "not-valid-json", new Date().toISOString()],
    );
    const config = store.getSessionConfigSync("bad-config");
    expect(config).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SessionStore conformance suite via adapter
// ---------------------------------------------------------------------------

/**
 * Adapt a GoalSessionStore (+ raw Database) to the SessionStore interface.
 *
 * GoalSessionStore uses different method names (addContributionToSession,
 * getSessionContributions) and lacks updateSession. This thin adapter
 * bridges the gap so the conformance suite can run against it.
 * The raw `db` handle is used to implement `updateSession` via direct SQL.
 */
function adaptGoalSessionStore(gs: GoalSessionStore, db: Database): SessionStore {
  return {
    createSession: (input) => gs.createSession(input),
    getSession: (id) => gs.getSession(id),
    updateSession: async (
      id: string,
      updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason">>,
    ) => {
      const setClauses: string[] = [];
      const params: (string | null)[] = [];
      if (updates.status !== undefined) {
        setClauses.push("status = ?");
        params.push(updates.status);
      }
      if (updates.completedAt !== undefined) {
        setClauses.push("ended_at = ?");
        params.push(updates.completedAt);
      }
      if (setClauses.length === 0) return;
      params.push(id);
      db.prepare(`UPDATE sessions SET ${setClauses.join(", ")} WHERE session_id = ?`).run(
        ...params,
      );
    },
    listSessions: (query) => gs.listSessions(query),
    archiveSession: (id) => gs.archiveSession(id),
    addContribution: (sid, cid) => gs.addContributionToSession(sid, cid),
    getContributions: (sid) => gs.getSessionContributions(sid),
  };
}

let conformanceTempDir: string;
let conformanceStores: ReturnType<typeof createSqliteStores>;

sessionStoreConformance(
  () => {
    conformanceTempDir = mkdtempSync(join(tmpdir(), "grove-session-conformance-"));
    const dbPath = join(conformanceTempDir, "grove.db");
    conformanceStores = createSqliteStores(dbPath);
    return adaptGoalSessionStore(conformanceStores.goalSessionStore, conformanceStores.db);
  },
  () => {
    conformanceStores.close();
    rmSync(conformanceTempDir, { recursive: true, force: true });
  },
);
