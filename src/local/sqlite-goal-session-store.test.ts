/**
 * Tests for SqliteGoalSessionStore.
 *
 * Uses real SQLite in temp directories for integration-level coverage.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroveContract } from "../core/contract.js";
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

// ---------------------------------------------------------------------------
// Session Config
// ---------------------------------------------------------------------------

/** Minimal contract for testing. */
function makeConfig(overrides: Partial<GroveContract> = {}): GroveContract {
  return {
    contractVersion: 3,
    name: "test-preset",
    ...overrides,
  };
}

/** Full contract with all sections populated. */
function makeFullConfig(): GroveContract {
  return {
    contractVersion: 3,
    name: "full-preset",
    description: "A full preset with all sections",
    mode: "evaluation",
    metrics: {
      val_bpb: { direction: "minimize", unit: "bpb", description: "Validation BPB" },
      accuracy: { direction: "maximize", unit: "%", description: "Accuracy" },
    },
    gates: [
      { type: "metric_improves", metric: "val_bpb" },
      { type: "min_score", metric: "accuracy", threshold: 0.9 },
    ],
    stopConditions: {
      maxRoundsWithoutImprovement: 5,
      targetMetric: { metric: "val_bpb", value: 1.0 },
      budget: { maxContributions: 100, maxWallClockSeconds: 3600 },
    },
    agentConstraints: {
      allowedKinds: ["work", "review"],
      requiredRelations: { review: ["reviews"] },
    },
    concurrency: { maxActiveClaims: 5, maxClaimsPerAgent: 2 },
    execution: { defaultLeaseSeconds: 300, maxLeaseSeconds: 600 },
    topology: {
      structure: "graph",
      roles: [
        {
          name: "coder",
          description: "Write code",
          prompt: "You are a coder. Write high-quality code.",
          command: "claude",
          edges: [{ target: "reviewer", edgeType: "delegates" }],
        },
        {
          name: "reviewer",
          description: "Review code",
          prompt: "You are a reviewer. Review code carefully.",
          command: "claude",
          edges: [{ target: "coder", edgeType: "feedback" }],
        },
      ],
    },
  };
}

describe("Session Config", () => {
  it("stores config on creation and retrieves on get", async () => {
    const config = makeConfig({ mode: "exploration" });
    const session = await store.createSession({ goal: "Test", config });

    const fetched = await store.getSession(session.sessionId);
    expect(fetched).toBeDefined();
    expect(fetched!.config).toBeDefined();
    expect(fetched!.config!.name).toBe("test-preset");
    expect(fetched!.config!.mode).toBe("exploration");
  });

  it("config survives archive", async () => {
    const config = makeConfig({ mode: "evaluation" });
    const session = await store.createSession({ goal: "Test", config });
    await store.archiveSession(session.sessionId);

    const fetched = await store.getSession(session.sessionId);
    expect(fetched!.status).toBe("archived");
    expect(fetched!.config).toBeDefined();
    expect(fetched!.config!.mode).toBe("evaluation");
  });

  it("backward compat: sessions without config return config undefined", async () => {
    const session = await store.createSession({ goal: "No config" });

    const fetched = await store.getSession(session.sessionId);
    expect(fetched).toBeDefined();
    expect(fetched!.config).toBeUndefined();
  });

  it("JSON round-trip preserves full GroveContract", async () => {
    const config = makeFullConfig();
    const session = await store.createSession({ goal: "Full", config });

    const fetched = await store.getSession(session.sessionId);
    expect(fetched!.config).toBeDefined();
    const c = fetched!.config!;

    expect(c.contractVersion).toBe(3);
    expect(c.name).toBe("full-preset");
    expect(c.mode).toBe("evaluation");
    expect(c.metrics!.val_bpb!.direction).toBe("minimize");
    expect(c.metrics!.accuracy!.direction).toBe("maximize");
    expect(c.gates).toHaveLength(2);
    expect(c.stopConditions!.maxRoundsWithoutImprovement).toBe(5);
    expect(c.agentConstraints!.allowedKinds).toEqual(["work", "review"]);
    expect(c.concurrency!.maxActiveClaims).toBe(5);
    expect(c.execution!.defaultLeaseSeconds).toBe(300);
    expect(c.topology!.roles).toHaveLength(2);
    expect(c.topology!.roles[0]!.name).toBe("coder");
    expect(c.topology!.roles[0]!.prompt).toBe("You are a coder. Write high-quality code.");
  });

  it("list sessions does NOT include config", async () => {
    const config = makeConfig({ mode: "evaluation" });
    await store.createSession({ goal: "Listed", config });

    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.config).toBeUndefined();
  });

  it("getSessionConfig returns config for valid session", async () => {
    const config = makeConfig({ mode: "exploration" });
    const session = await store.createSession({ goal: "Test", config });

    const retrieved = await store.getSessionConfig(session.sessionId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.mode).toBe("exploration");
    expect(retrieved!.name).toBe("test-preset");
  });

  it("getSessionConfig returns undefined for missing session", async () => {
    const retrieved = await store.getSessionConfig("nonexistent-id");
    expect(retrieved).toBeUndefined();
  });

  it("getSessionConfig returns undefined for session without config", async () => {
    const session = await store.createSession({ goal: "No config" });
    const retrieved = await store.getSessionConfig(session.sessionId);
    expect(retrieved).toBeUndefined();
  });

  it("config with deeply nested topology edges round-trips", async () => {
    const config = makeConfig({
      topology: {
        structure: "graph",
        roles: [
          {
            name: "orchestrator",
            description: "Orchestrate agents",
            edges: [
              { target: "worker-a", edgeType: "delegates" },
              { target: "worker-b", edgeType: "delegates" },
              { target: "reviewer", edgeType: "requests" },
            ],
          },
          { name: "worker-a", description: "Worker A" },
          { name: "worker-b", description: "Worker B" },
          {
            name: "reviewer",
            description: "Reviewer",
            edges: [{ target: "orchestrator", edgeType: "feedback" }],
          },
        ],
      },
    });
    const session = await store.createSession({ goal: "Nested", config });

    const fetched = await store.getSession(session.sessionId);
    const topo = fetched!.config!.topology!;
    expect(topo.roles).toHaveLength(4);
    expect(topo.roles[0]!.edges).toHaveLength(3);
    expect(topo.roles[0]!.edges![1]!.target).toBe("worker-b");
  });

  it("createSession returns config in the response", async () => {
    const config = makeConfig({ mode: "exploration" });
    const session = await store.createSession({ goal: "Inline", config });

    expect(session.config).toBeDefined();
    expect(session.config!.mode).toBe("exploration");
  });
});
