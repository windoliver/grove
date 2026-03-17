/**
 * Tests for SqliteGoalSessionStore.
 *
 * Uses real SQLite in temp directories for integration-level coverage.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteGoalSessionStore } from "./sqlite-goal-session-store.js";
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
    expect(session.sessionId).toBeTruthy();
    expect(typeof session.sessionId).toBe("string");
    expect(session.status).toBe("active");
    expect(session.contributionCount).toBe(0);
    expect(typeof session.startedAt).toBe("string");
    expect(session.endedAt).toBeUndefined();
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
    await store.archiveSession(s1.sessionId);

    const active = await store.listSessions({ status: "active" });
    expect(active.length).toBe(1);

    const archived = await store.listSessions({ status: "archived" });
    expect(archived.length).toBe(1);
  });

  it("getSession() returns by ID", async () => {
    const created = await store.createSession({ goal: "Test goal" });
    const fetched = await store.getSession(created.sessionId);
    expect(fetched).toBeDefined();
    expect(fetched!.sessionId).toBe(created.sessionId);
    expect(fetched!.goal).toBe("Test goal");
    expect(fetched!.status).toBe("active");
  });

  it("getSession() returns undefined for missing", async () => {
    const fetched = await store.getSession("nonexistent-id");
    expect(fetched).toBeUndefined();
  });

  it("archiveSession() changes status", async () => {
    const session = await store.createSession({});
    await store.archiveSession(session.sessionId);

    const fetched = await store.getSession(session.sessionId);
    expect(fetched).toBeDefined();
    expect(fetched!.status).toBe("archived");
  });

  it("archiveSession() sets ended_at", async () => {
    const session = await store.createSession({});
    await store.archiveSession(session.sessionId);

    const fetched = await store.getSession(session.sessionId);
    expect(fetched).toBeDefined();
    expect(fetched!.endedAt).toBeDefined();
    expect(typeof fetched!.endedAt).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Session Contributions
// ---------------------------------------------------------------------------

describe("Session Contributions", () => {
  it("addContributionToSession() links a CID", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.sessionId, "blake3:abc123");

    const cids = await store.getSessionContributions(session.sessionId);
    expect(cids).toEqual(["blake3:abc123"]);
  });

  it("getSessionContributions() returns linked CIDs", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.sessionId, "blake3:aaa");
    await store.addContributionToSession(session.sessionId, "blake3:bbb");
    await store.addContributionToSession(session.sessionId, "blake3:ccc");

    const cids = await store.getSessionContributions(session.sessionId);
    expect(cids.length).toBe(3);
    expect(cids).toContain("blake3:aaa");
    expect(cids).toContain("blake3:bbb");
    expect(cids).toContain("blake3:ccc");
  });

  it("addContributionToSession() is idempotent (duplicate CID ignored)", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.sessionId, "blake3:dup");
    await store.addContributionToSession(session.sessionId, "blake3:dup");

    const cids = await store.getSessionContributions(session.sessionId);
    expect(cids.length).toBe(1);
  });

  it("SessionRecord.contributionCount reflects count", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.sessionId, "blake3:c1");
    await store.addContributionToSession(session.sessionId, "blake3:c2");

    const fetched = await store.getSession(session.sessionId);
    expect(fetched).toBeDefined();
    expect(fetched!.contributionCount).toBe(2);
  });

  it("archiving doesn't remove contributions", async () => {
    const session = await store.createSession({});
    await store.addContributionToSession(session.sessionId, "blake3:kept");
    await store.archiveSession(session.sessionId);

    const cids = await store.getSessionContributions(session.sessionId);
    expect(cids).toEqual(["blake3:kept"]);

    const fetched = await store.getSession(session.sessionId);
    expect(fetched!.contributionCount).toBe(1);
    expect(fetched!.status).toBe("archived");
  });
});
