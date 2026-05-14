/**
 * Tests for SqliteGoalSessionStore.
 *
 * Uses real SQLite in temp directories for integration-level coverage.
 * Includes the SessionStore conformance suite via an adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SESSION_FINALIZERS } from "../core/lifecycle-metadata.js";
import { LoopStopStatus } from "../core/loop-runner.js";
import type { RuntimeSkillSessionStore, SessionStore } from "../core/session.js";
import { sessionStoreConformance } from "../core/session-store.conformance.js";
import { makeClaim, makeContribution } from "../core/test-helpers.js";
import type { GoalSessionStore } from "./sqlite-goal-session-store.js";
import { SESSION_GC_TTL_MS, SqliteGoalSessionStore } from "./sqlite-goal-session-store.js";
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

    const fetched = await store.getGoal();
    expect(fetched).toBeDefined();
    expect(fetched!.goal).toBe("Goal v2");
  });

  it("goal acceptance array round-trips correctly", async () => {
    const acceptance = ["PR merged", "Tests green", "No regressions"];
    await store.setGoal("Ship it", acceptance, "ops");

    const goal = await store.getGoal();
    expect(goal).toBeDefined();
    expect(Array.isArray(goal!.acceptance)).toBe(true);
    expect(goal!.acceptance).toEqual(acceptance);
  });
});

// ---------------------------------------------------------------------------
// Sessions — basic CRUD
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

  it("listSessions() excludes archived sessions by default", async () => {
    const s1 = await store.createSession({});
    const s2 = await store.createSession({ goal: "Session 2" });
    await store.archiveSession(s1.id);

    const sessions = await store.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe(s2.id);
  });

  it("listSessions() with no args returns active sessions (up to 20)", async () => {
    await store.createSession({});
    await store.createSession({ goal: "Session 2" });

    const sessions = await store.listSessions();
    expect(sessions.length).toBe(2);
  });

  it("listSessions({ includeArchived: true }) returns all sessions", async () => {
    const s1 = await store.createSession({});
    await store.createSession({ goal: "Session 2" });
    await store.archiveSession(s1.id);

    const all = await store.listSessions({ includeArchived: true });
    expect(all.length).toBe(2);
  });

  it("listSessions({ status: 'active' }) filters to active only", async () => {
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

  it("getSession() and listSessions() expose default finalizers after reading", async () => {
    const created = await store.createSession({ goal: "Finalizer defaults" });

    const fetched = await store.getSession(created.id);
    const listed = await store.listSessions();

    expect(created.finalizers).toEqual(DEFAULT_SESSION_FINALIZERS);
    expect(fetched?.finalizers).toEqual(DEFAULT_SESSION_FINALIZERS);
    expect(listed.find((session) => session.id === created.id)?.finalizers).toEqual(
      DEFAULT_SESSION_FINALIZERS,
    );
  });

  it("getSession() returns undefined for missing", async () => {
    const fetched = await store.getSession("nonexistent-id");
    expect(fetched).toBeUndefined();
  });

  it("archiveSession() changes status and sets archived_at", async () => {
    const session = await store.createSession({});
    await store.archiveSession(session.id);

    const fetched = await store.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.status).toBe("archived");
    expect(fetched!.completedAt).toBeDefined();
    expect(typeof fetched!.completedAt).toBe("string");

    // Confirm archived_at is set in the DB
    const row = stores.db
      .prepare("SELECT archived_at FROM sessions WHERE session_id = ?")
      .get(session.id) as { archived_at: number | null };
    expect(row.archived_at).not.toBeNull();
    expect(typeof row.archived_at).toBe("number");
  });

  it("archiveSession() excludes session from default listSessions()", async () => {
    const s = await store.createSession({});
    await store.archiveSession(s.id);

    const live = await store.listSessions();
    const ids = live.map((x) => x.id);
    expect(ids).not.toContain(s.id);
  });

  it("archiveSession() preserves existing ended_at", async () => {
    const session = await store.createSession({});
    const customEndedAt = "2024-01-01T00:00:00.000Z";
    await store.updateSession(session.id, { completedAt: customEndedAt });
    await store.archiveSession(session.id);

    const fetched = await store.getSession(session.id);
    expect(fetched!.completedAt).toBe(customEndedAt);
  });
});

// ---------------------------------------------------------------------------
// updateSession — prepared-statement routing
// ---------------------------------------------------------------------------

describe("updateSession", () => {
  it("updates status only (cached prepared statement)", async () => {
    const s = await store.createSession({});
    await store.updateSession(s.id, { status: "completed" });
    const fetched = await store.getSession(s.id);
    expect(fetched!.status).toBe("completed");
  });

  it("updates all three fields together", async () => {
    const s = await store.createSession({});
    const completedAt = new Date().toISOString();
    await store.updateSession(s.id, {
      status: "completed",
      completedAt,
      stopReason: "done",
    });
    const fetched = await store.getSession(s.id);
    expect(fetched!.status).toBe("completed");
    expect(fetched!.completedAt).toBe(completedAt);
    expect(fetched!.stopReason).toBe("done");
  });

  it("persists semantic stopStatus through getSession and listSessions", async () => {
    const s = await store.createSession({});
    const completedAt = new Date().toISOString();
    await store.updateSession(s.id, {
      status: "completed",
      completedAt,
      stopReason: "No improvement for 5 rounds",
      stopStatus: LoopStopStatus.Plateau,
    });

    const fetched = await store.getSession(s.id);
    expect(fetched!.stopStatus).toBe(LoopStopStatus.Plateau);

    const listed = await store.listSessions({ includeArchived: true });
    expect(listed.find((session) => session.id === s.id)?.stopStatus).toBe(LoopStopStatus.Plateau);
  });

  it("updateSession({ status: 'archived' }) delegates to archiveSession", async () => {
    const s = await store.createSession({});
    await store.updateSession(s.id, { status: "archived" });
    const fetched = await store.getSession(s.id);
    expect(fetched!.status).toBe("archived");
    const row = stores.db
      .prepare("SELECT archived_at FROM sessions WHERE session_id = ?")
      .get(s.id) as { archived_at: number | null };
    expect(row.archived_at).not.toBeNull();
  });

  it("updates ended_at + stop_reason without status", async () => {
    const s = await store.createSession({});
    const completedAt = new Date().toISOString();
    await store.updateSession(s.id, { completedAt, stopReason: "manual" });
    const fetched = await store.getSession(s.id);
    expect(fetched!.completedAt).toBe(completedAt);
    expect(fetched!.stopReason).toBe("manual");
    expect(fetched!.status).toBe("active"); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Session Contributions — denormalized count + triggers
// ---------------------------------------------------------------------------

describe("Session Contributions", () => {
  it("addContributionToSession() links a CID", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:abc123");

    const cids = await store.getSessionContributions(session.id);
    expect(cids).toEqual(["blake3:abc123"]);
  });

  it("contribution_count is updated by trigger on insert", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:aaa");
    await store.addContributionToSession(session.id, "blake3:bbb");

    const fetched = await store.getSession(session.id);
    expect(fetched!.contributionCount).toBe(2);
  });

  it("contribution_count is updated by trigger on delete (via store.db)", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:del");
    stores.db.run("DELETE FROM session_contributions WHERE session_id = ? AND cid = ?", [
      session.id,
      "blake3:del",
    ]);
    const fetched = await store.getSession(session.id);
    expect(fetched!.contributionCount).toBe(0);
  });

  it("listSessions() contribution_count matches getSession()", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.id, "blake3:c1");
    await store.addContributionToSession(session.id, "blake3:c2");

    const list = await store.listSessions();
    const found = list.find((s) => s.id === session.id);
    expect(found).toBeDefined();
    expect(found!.contributionCount).toBe(2);

    const full = await store.getSession(session.id);
    expect(full!.contributionCount).toBe(found!.contributionCount);
  });

  it("getSessionContributions() returns linked CIDs in order", async () => {
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
    expect((await store.getSession(session.id))!.contributionCount).toBe(1);
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
// ContributionStore.list({ sessionId }) — cross-session isolation
// ---------------------------------------------------------------------------

describe("ContributionStore.list({ sessionId }) — session-scoped queries", () => {
  it("returns only contributions linked to the given session", async () => {
    const sessionA = await store.createSession({ goal: "task A" });
    const sessionB = await store.createSession({ goal: "task B" });

    const contribA = makeContribution({ summary: "A contribution" });
    const contribB = makeContribution({ summary: "B contribution" });

    await stores.contributionStore.put(contribA);
    await stores.contributionStore.put(contribB);

    // Link each contribution to its own session
    await store.addContributionToSession(sessionA.id, contribA.cid);
    await store.addContributionToSession(sessionB.id, contribB.cid);

    // Session-scoped queries return only that session's contributions
    const listA = await stores.contributionStore.list({ sessionId: sessionA.id });
    expect(listA.map((c) => c.cid)).toEqual([contribA.cid]);

    const listB = await stores.contributionStore.list({ sessionId: sessionB.id });
    expect(listB.map((c) => c.cid)).toEqual([contribB.cid]);
  });

  it("unfiltered list() returns contributions from all sessions", async () => {
    const sessionA = await store.createSession({ goal: "shared grove" });
    const sessionB = await store.createSession({ goal: "shared grove 2" });

    const c1 = makeContribution({ summary: "c1" });
    const c2 = makeContribution({ summary: "c2" });

    await stores.contributionStore.put(c1);
    await stores.contributionStore.put(c2);
    await store.addContributionToSession(sessionA.id, c1.cid);
    await store.addContributionToSession(sessionB.id, c2.cid);

    // Unfiltered: both contributions visible
    const all = await stores.contributionStore.list();
    const cids = all.map((c) => c.cid);
    expect(cids).toContain(c1.cid);
    expect(cids).toContain(c2.cid);
  });

  it("count({ sessionId }) returns only that session's count", async () => {
    const sessionA = await store.createSession({ goal: "count test" });
    const sessionB = await store.createSession({ goal: "count test 2" });

    const cA1 = makeContribution({ summary: "cA1" });
    const cA2 = makeContribution({ summary: "cA2" });
    const cB1 = makeContribution({ summary: "cB1" });

    await stores.contributionStore.put(cA1);
    await stores.contributionStore.put(cA2);
    await stores.contributionStore.put(cB1);
    await store.addContributionToSession(sessionA.id, cA1.cid);
    await store.addContributionToSession(sessionA.id, cA2.cid);
    await store.addContributionToSession(sessionB.id, cB1.cid);

    expect(await stores.contributionStore.count({ sessionId: sessionA.id })).toBe(2);
    expect(await stores.contributionStore.count({ sessionId: sessionB.id })).toBe(1);
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

  it("getSessionConfig returns undefined for malformed config_json", async () => {
    stores.db.run(
      "INSERT INTO sessions (session_id, uid, goal, config_json, status, started_at) VALUES (?, ?, ?, ?, 'active', ?)",
      ["bad-config", "bad-config-uid", "test", "not-valid-json", new Date().toISOString()],
    );
    const config = store.getSessionConfigSync("bad-config");
    expect(config).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TTL / GC — gcStaleSessions
// ---------------------------------------------------------------------------

describe("gcStaleSessions", () => {
  /** Helper: insert a session with a custom started_at timestamp. */
  function insertSessionAt(sessionId: string, startedAt: string, status = "completed"): void {
    stores.db.run(
      `INSERT INTO sessions (session_id, uid, status, started_at, config_json)
       VALUES (?, ?, ?, ?, '{}')`,
      [sessionId, `${sessionId}-uid`, status, startedAt],
    );
  }

  it("archives completed sessions older than the TTL", () => {
    const old = new Date(Date.now() - SESSION_GC_TTL_MS - 60_000).toISOString();
    insertSessionAt("old-session", old, "completed");

    const archived = store.gcStaleSessions();
    expect(archived).toBe(1);

    const row = stores.db
      .prepare("SELECT archived_at FROM sessions WHERE session_id = ?")
      .get("old-session") as { archived_at: number | null };
    expect(row.archived_at).not.toBeNull();
  });

  it("does NOT archive sessions younger than the TTL", () => {
    const fresh = new Date(Date.now() - 60_000).toISOString(); // 1 min old
    insertSessionAt("fresh-session", fresh, "completed");

    const archived = store.gcStaleSessions();
    expect(archived).toBe(0);
  });

  it("does NOT archive active sessions regardless of age", () => {
    const old = new Date(Date.now() - SESSION_GC_TTL_MS - 60_000).toISOString();
    insertSessionAt("active-old", old, "active");

    const archived = store.gcStaleSessions();
    expect(archived).toBe(0);
  });

  it("does NOT archive pending sessions regardless of age", () => {
    const old = new Date(Date.now() - SESSION_GC_TTL_MS - 60_000).toISOString();
    insertSessionAt("pending-old", old, "pending");

    const archived = store.gcStaleSessions();
    expect(archived).toBe(0);
  });

  it("is idempotent — does not double-archive already-archived sessions", () => {
    const old = new Date(Date.now() - SESSION_GC_TTL_MS - 60_000).toISOString();
    insertSessionAt("old-archived", old, "archived");
    // Manually set archived_at so it looks pre-archived
    stores.db.run("UPDATE sessions SET archived_at = strftime('%s', 'now') WHERE session_id = ?", [
      "old-archived",
    ]);

    const archived = store.gcStaleSessions();
    expect(archived).toBe(0);
  });

  it("gcStaleSessions with custom ttlMs respects the override", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    insertSessionAt("two-hours-old", twoHoursAgo, "completed");

    // With 1-hour TTL, 2-hour-old session should be archived
    const archived = store.gcStaleSessions(60 * 60 * 1000);
    expect(archived).toBe(1);
  });

  it("does NOT archive a long-running session whose ended_at is within the TTL", () => {
    // Session that ran for 26 hours (started > 24h ago) but completed just 1 minute ago.
    // Regression: old predicate used started_at < cutoff, which would archive this immediately.
    const startedAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(); // 26h ago
    const endedAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    stores.db.run(
      `INSERT INTO sessions (session_id, uid, status, started_at, ended_at, config_json)
       VALUES (?, ?, 'completed', ?, ?, '{}')`,
      ["long-running-fresh-end", "long-running-fresh-end-uid", startedAt, endedAt],
    );

    const archived = store.gcStaleSessions(); // default 24h TTL
    expect(archived).toBe(0);

    const row = stores.db
      .prepare("SELECT archived_at FROM sessions WHERE session_id = ?")
      .get("long-running-fresh-end") as { archived_at: number | null };
    expect(row.archived_at).toBeNull();
  });

  it("archived sessions are excluded from listSessions() after GC", async () => {
    const old = new Date(Date.now() - SESSION_GC_TTL_MS - 60_000).toISOString();
    insertSessionAt("stale-1", old, "completed");
    insertSessionAt("stale-2", old, "cancelled");
    // Add one fresh active session
    stores.db.run(
      `INSERT INTO sessions (session_id, uid, status, started_at, config_json)
       VALUES ('fresh-active', 'fresh-active-uid', 'active', ?, '{}')`,
      [new Date().toISOString()],
    );

    store.gcStaleSessions();

    const live = await store.listSessions();
    const ids = live.map((s) => s.id);
    expect(ids).not.toContain("stale-1");
    expect(ids).not.toContain("stale-2");
    expect(ids).toContain("fresh-active");
  });
});

// ---------------------------------------------------------------------------
// Volume — listSessions LIMIT behavior
// ---------------------------------------------------------------------------

describe("listSessions volume", () => {
  it("default listSessions() returns at most 20 non-archived sessions", async () => {
    // Create 30 active sessions
    for (let i = 0; i < 30; i++) {
      await store.createSession({ goal: `Session ${i}` });
    }

    const sessions = await store.listSessions();
    expect(sessions.length).toBeLessThanOrEqual(20);
    // All returned sessions must be non-archived
    for (const s of sessions) {
      expect(s.status).not.toBe("archived");
    }
  });

  it("listSessions({ includeArchived: true }) returns all 100 sessions", async () => {
    for (let i = 0; i < 100; i++) {
      await store.createSession({ goal: `Session ${i}` });
    }

    const all = await store.listSessions({ includeArchived: true });
    expect(all.length).toBe(100);
  });

  it("listSessions() results are ordered most-recent-first", async () => {
    for (let i = 0; i < 5; i++) {
      await store.createSession({ goal: `Session ${i}` });
    }

    const sessions = await store.listSessions();
    for (let i = 1; i < sessions.length; i++) {
      const prev = new Date(sessions[i - 1]!.createdAt).getTime();
      const curr = new Date(sessions[i]!.createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });
});

describe("session deletion finalizers", () => {
  it("deleteSession releases owned claims and removes session contribution links", async () => {
    const session = await store.createSession({ goal: "cleanup" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    const claim = makeClaim({ claimId: "owned-claim", targetRef: "owned-target", ownerRef });
    await stores.claimStore.createClaim(claim);
    const contribution = makeContribution({ summary: "owned contribution" });
    await stores.contributionStore.put(contribution);
    await store.addContributionToSession(session.id, contribution.cid);

    const result = await store.deleteSession(session.id);

    expect(result.deleted).toBe(true);
    expect(result.forced).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(await store.getSession(session.id)).toBeUndefined();
    expect(await stores.claimStore.getClaim("owned-claim")).toBeUndefined();
    expect(await store.getSessionContributions(session.id)).toEqual([]);
    expect(await stores.contributionStore.get(contribution.cid)).toBeDefined();
  });

  it("deleteSession returns blockers when close-runtime finalizer fails", async () => {
    const blocking = new SqliteGoalSessionStore(stores.db, {
      closeRuntime: async () => {
        throw new Error("runtime still flushing");
      },
    });
    const session = await blocking.createSession({ goal: "blocked" });

    const result = await blocking.deleteSession(session.id);

    expect(result.deleted).toBe(false);
    expect(result.blockers).toEqual([
      { finalizer: "grove.io/close-runtime", message: "runtime still flushing" },
    ]);
    const fetched = await blocking.getSession(session.id);
    expect(fetched?.deletionTimestamp).toBeDefined();
    expect(fetched?.finalizers).toEqual(["grove.io/close-runtime"]);
  });

  it("deleteSession keeps unknown finalizers pending after close-runtime succeeds", async () => {
    const blocking = new SqliteGoalSessionStore(stores.db, {
      closeRuntime: async () => {
        // Successful runtime cleanup still must not skip unknown finalizers.
      },
    });
    const session = await blocking.createSession({ goal: "runtime then unknown" });
    stores.db
      .prepare("UPDATE sessions SET finalizers_json = ? WHERE session_id = ?")
      .run(JSON.stringify(["grove.io/close-runtime", "grove.io/future-cleanup"]), session.id);

    const result = await blocking.deleteSession(session.id);

    expect(result.deleted).toBe(false);
    expect(result.blockers).toEqual([
      { finalizer: "grove.io/future-cleanup", message: "unknown finalizer pending" },
    ]);
    const fetched = await blocking.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched?.finalizers).toEqual(["grove.io/future-cleanup"]);
  });

  it("deleteSession force removes session and returns warning", async () => {
    const blocking = new SqliteGoalSessionStore(stores.db, {
      claimStore: stores.claimStore,
      closeRuntime: async () => {
        throw new Error("runtime still flushing");
      },
    });
    const session = await blocking.createSession({ goal: "force" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    const claim = makeClaim({
      claimId: "force-delete-claim",
      targetRef: "force-delete-target",
      ownerRef,
    });
    await stores.claimStore.createClaim(claim);
    const contribution = makeContribution({ summary: "force delete contribution" });
    await stores.contributionStore.put(contribution);
    await blocking.addContributionToSession(session.id, contribution.cid);
    const events: Array<{ op: string; claimId: string }> = [];
    stores.claimStore.onClaimWrite = (op, writtenClaim) => {
      events.push({ op, claimId: writtenClaim.claimId });
    };

    const result = await blocking.deleteSession(session.id, { force: true, actor: "test" });

    expect(result.deleted).toBe(true);
    expect(result.forced).toBe(true);
    expect(result.warning).toContain("force delete skipped finalizer waits");
    expect(await blocking.getSession(session.id)).toBeUndefined();
    expect(await stores.claimStore.getClaim(claim.claimId)).toBeUndefined();
    expect(await blocking.getSessionContributions(session.id)).toEqual([]);
    expect(events).toContainEqual({ op: "MODIFIED", claimId: claim.claimId });
    expect(events).toContainEqual({ op: "DELETED", claimId: claim.claimId });
    const auditRows = stores.db
      .prepare(
        `SELECT session_id, at, actor, force, warning, event_json
         FROM session_deletion_audits
         WHERE session_id = ?`,
      )
      .all(session.id) as readonly {
      session_id: string;
      at: string;
      actor: string;
      force: number;
      warning: string;
      event_json: string;
    }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.session_id).toBe(session.id);
    expect(auditRows[0]?.actor).toBe("test");
    expect(auditRows[0]?.force).toBe(1);
    expect(auditRows[0]?.warning).toContain("force delete skipped finalizer waits");
    expect(JSON.parse(auditRows[0]?.event_json ?? "{}")).toMatchObject({
      actor: "test",
      force: true,
      warning: result.warning,
    });
  });

  it("deleteSession force rolls back cleanup and callbacks if final session delete fails", async () => {
    const session = await store.createSession({ goal: "force rollback" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    const claim = makeClaim({
      claimId: "force-rollback-claim",
      targetRef: "force-rollback-target",
      ownerRef,
    });
    await stores.claimStore.createClaim(claim);
    const contribution = makeContribution({ summary: "force rollback contribution" });
    await stores.contributionStore.put(contribution);
    await store.addContributionToSession(session.id, contribution.cid);
    const events: Array<{ op: string; claimId: string }> = [];
    stores.claimStore.onClaimWrite = (op, writtenClaim) => {
      events.push({ op, claimId: writtenClaim.claimId });
    };
    stores.db.run(
      "CREATE TABLE force_session_delete_guard (session_id TEXT NOT NULL REFERENCES sessions(session_id))",
    );
    stores.db
      .prepare("INSERT INTO force_session_delete_guard (session_id) VALUES (?)")
      .run(session.id);

    await expect(store.deleteSession(session.id, { force: true, actor: "test" })).rejects.toThrow();

    expect(events).toEqual([]);
    expect(await store.getSession(session.id)).toBeDefined();
    expect((await stores.claimStore.getClaim(claim.claimId))?.status).toBe("active");
    expect(await store.getSessionContributions(session.id)).toEqual([contribution.cid]);
    const auditRows = stores.db
      .prepare("SELECT COUNT(*) AS count FROM session_deletion_audits WHERE session_id = ?")
      .get(session.id) as { count: number } | null;
    expect(auditRows?.count).toBe(0);
  });

  it("deleteSession emits claim write callbacks for released and deleted owned claims", async () => {
    const session = await store.createSession({ goal: "callbacks" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    const active = makeClaim({
      claimId: "callback-active",
      targetRef: "callback-target-active",
      ownerRef,
    });
    const terminal = makeClaim({
      claimId: "callback-terminal",
      targetRef: "callback-target-terminal",
      ownerRef,
    });
    await stores.claimStore.createClaim(active);
    await stores.claimStore.createClaim(terminal);
    await stores.claimStore.release(terminal.claimId);

    const events: Array<{ op: string; claimId: string }> = [];
    stores.claimStore.onClaimWrite = (op, claim) => {
      events.push({ op, claimId: claim.claimId });
    };

    const result = await store.deleteSession(session.id);

    expect(result.deleted).toBe(true);
    expect(events).toContainEqual({ op: "MODIFIED", claimId: active.claimId });
    expect(events).toContainEqual({ op: "DELETED", claimId: active.claimId });
    expect(events).toContainEqual({ op: "DELETED", claimId: terminal.claimId });
  });

  it("deleteSession treats empty legacy finalizers as defaults", async () => {
    const session = await store.createSession({ goal: "legacy finalizers" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    const claim = makeClaim({
      claimId: "legacy-finalizer-claim",
      targetRef: "legacy-finalizer-target",
      ownerRef,
    });
    await stores.claimStore.createClaim(claim);
    const contribution = makeContribution({ summary: "legacy finalizer contribution" });
    await stores.contributionStore.put(contribution);
    await store.addContributionToSession(session.id, contribution.cid);
    stores.db
      .prepare("UPDATE sessions SET finalizers_json = '[]' WHERE session_id = ?")
      .run(session.id);

    const result = await store.deleteSession(session.id);

    expect(result.deleted).toBe(true);
    expect(await store.getSession(session.id)).toBeUndefined();
    expect(await stores.claimStore.getClaim(claim.claimId)).toBeUndefined();
    expect(await store.getSessionContributions(session.id)).toEqual([]);
    expect(await stores.contributionStore.get(contribution.cid)).toBeDefined();
  });

  it("listSessionDeleteBlockers treats empty legacy finalizers as defaults for close-runtime", async () => {
    const blocking = new SqliteGoalSessionStore(stores.db, {
      closeRuntime: async () => {
        throw new Error("runtime still flushing");
      },
    });
    const session = await blocking.createSession({ goal: "legacy blockers" });
    stores.db
      .prepare("UPDATE sessions SET finalizers_json = '[]' WHERE session_id = ?")
      .run(session.id);

    const blockers = await blocking.listSessionDeleteBlockers(session.id);

    expect(blockers).toContainEqual({
      finalizer: "grove.io/close-runtime",
      message: "runtime cleanup pending",
    });
  });

  it("deleteSession keeps failed and later finalizers after an earlier finalizer fails", async () => {
    const session = await store.createSession({ goal: "blocked drain" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    const claim = makeClaim({
      claimId: "blocked-drain-claim",
      targetRef: "blocked-drain-target",
      ownerRef,
    });
    await stores.claimStore.createClaim(claim);
    const events: Array<{ op: string; claimId: string }> = [];
    stores.claimStore.onClaimWrite = (op, writtenClaim) => {
      events.push({ op, claimId: writtenClaim.claimId });
    };
    const contribution = makeContribution({ summary: "blocked drain contribution" });
    await stores.contributionStore.put(contribution);
    await store.addContributionToSession(session.id, contribution.cid);
    stores.db.run(`
      CREATE TRIGGER fail_session_drain
      BEFORE DELETE ON session_contributions
      WHEN OLD.session_id = '${session.id}'
      BEGIN
        SELECT RAISE(ABORT, 'drain still busy');
      END
    `);

    const result = await store.deleteSession(session.id);

    expect(result.deleted).toBe(false);
    expect(result.blockers).toEqual([
      { finalizer: "grove.io/drain-contribs", message: "drain still busy" },
    ]);
    expect(events).toEqual([]);
    expect((await stores.claimStore.getClaim(claim.claimId))?.status).toBe("active");
    expect(await store.getSessionContributions(session.id)).toEqual([contribution.cid]);
    const fetched = await store.getSession(session.id);
    expect(fetched?.finalizers).toEqual([
      "grove.io/release-slots",
      "grove.io/drain-contribs",
      "grove.io/close-runtime",
    ]);
    stores.db.run("DROP TRIGGER fail_session_drain");
  });

  it("deleteSession rolls back claim and link cleanup if final session delete fails", async () => {
    const session = await store.createSession({ goal: "atomic delete" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    const claim = makeClaim({
      claimId: "atomic-delete-claim",
      targetRef: "atomic-delete-target",
      ownerRef,
    });
    await stores.claimStore.createClaim(claim);
    const contribution = makeContribution({ summary: "atomic delete contribution" });
    await stores.contributionStore.put(contribution);
    await store.addContributionToSession(session.id, contribution.cid);
    stores.db.run(
      "CREATE TABLE session_delete_guard (session_id TEXT NOT NULL REFERENCES sessions(session_id))",
    );
    stores.db.prepare("INSERT INTO session_delete_guard (session_id) VALUES (?)").run(session.id);

    await expect(store.deleteSession(session.id)).rejects.toThrow();

    expect(await store.getSession(session.id)).toBeDefined();
    expect((await stores.claimStore.getClaim(claim.claimId))?.status).toBe("active");
    expect(await store.getSessionContributions(session.id)).toEqual([contribution.cid]);
  });

  it("deleteSession keeps unknown finalizers pending until force delete", async () => {
    const session = await store.createSession({ goal: "unknown finalizer" });
    stores.db
      .prepare("UPDATE sessions SET finalizers_json = ? WHERE session_id = ?")
      .run(JSON.stringify(["grove.io/future-cleanup"]), session.id);

    const result = await store.deleteSession(session.id);

    expect(result.deleted).toBe(false);
    expect(result.blockers).toEqual([
      { finalizer: "grove.io/future-cleanup", message: "unknown finalizer pending" },
    ]);
    const fetched = await store.getSession(session.id);
    expect(fetched?.finalizers).toEqual(["grove.io/future-cleanup"]);

    const forced = await store.deleteSession(session.id, { force: true, actor: "test" });

    expect(forced.deleted).toBe(true);
    expect(await store.getSession(session.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SessionStore conformance suite via adapter
// ---------------------------------------------------------------------------

/**
 * Adapt a GoalSessionStore (+ raw Database) to the SessionStore interface.
 *
 * GoalSessionStore uses different method names (addContributionToSession,
 * getSessionContributions) and has a typed updateSession. This thin adapter
 * bridges the gap so the conformance suite runs against the SQLite backend.
 */
function adaptGoalSessionStore(
  gs: GoalSessionStore & RuntimeSkillSessionStore,
): SessionStore & RuntimeSkillSessionStore {
  return {
    createSession: (input) => gs.createSession(input),
    getSession: (id) => gs.getSession(id),
    updateSession: (id, updates) => gs.updateSession(id, updates),
    listSessions: (query) => gs.listSessions(query),
    deleteSession: (id, options) => gs.deleteSession(id, options),
    listSessionDeleteBlockers: (id) => gs.listSessionDeleteBlockers(id),
    archiveSession: (id) => gs.archiveSession(id),
    addContribution: (sid, cid) => gs.addContributionToSession(sid, cid),
    getContributions: (sid) => gs.getSessionContributions(sid),
    appendSessionRoleSkill: (sessionId, roleName, skillName) =>
      gs.appendSessionRoleSkill(sessionId, roleName, skillName),
  };
}

let conformanceTempDir: string;
let conformanceStores: ReturnType<typeof createSqliteStores>;

sessionStoreConformance(
  () => {
    conformanceTempDir = mkdtempSync(join(tmpdir(), "grove-session-conformance-"));
    const dbPath = join(conformanceTempDir, "grove.db");
    conformanceStores = createSqliteStores(dbPath);
    return adaptGoalSessionStore(conformanceStores.goalSessionStore);
  },
  () => {
    conformanceStores.close();
    rmSync(conformanceTempDir, { recursive: true, force: true });
  },
);
