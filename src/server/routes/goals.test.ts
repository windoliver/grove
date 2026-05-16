import { describe, expect, test } from "bun:test";

import { type CasMutationResult, type CasOpts, casOk, checkIfMatch } from "../../core/cas.js";
import type { GroveContract } from "../../core/contract.js";
import { InMemorySessionStore } from "../../core/in-memory-session-store.js";
import type {
  CreateSessionInput,
  Session,
  SessionDeleteBlocker,
  SessionDeleteOptions,
  SessionDeleteResult,
  SessionQuery,
} from "../../core/session.js";
import type { GoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import type { GoalData } from "../../tui/provider.js";
import { createTestApp, TEST_AUTH_HEADERS } from "../test-helpers.js";

/**
 * Test GoalSessionStore that implements CAS semantics for `setGoal`.
 * Mirrors the SQLite store: first insert ignores ifMatch (no row to
 * compare against), subsequent updates compare-and-set on the
 * persisted goal `resourceVersion`.
 */
class TestGoalStore implements GoalSessionStore {
  private readonly sessionStore = new InMemorySessionStore();
  private goal: GoalData | undefined;
  readonly setGoalCalls: { goal: string; ifMatch: string | undefined }[] = [];

  async getGoal(): Promise<GoalData | undefined> {
    return this.goal;
  }

  async setGoal(
    goal: string,
    acceptance: readonly string[],
    setBy: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GoalData>> {
    this.setGoalCalls.push({ goal, ifMatch: opts?.ifMatch });
    if (this.goal !== undefined) {
      const mismatch = checkIfMatch(this.goal.resourceVersion, opts?.ifMatch);
      if (mismatch) return mismatch;
      this.goal = {
        goal,
        acceptance,
        status: "active",
        setAt: new Date().toISOString(),
        setBy,
        resourceVersion: (this.goal.resourceVersion ?? 1) + 1,
      };
    } else {
      this.goal = {
        goal,
        acceptance,
        status: "active",
        setAt: new Date().toISOString(),
        setBy,
        resourceVersion: 1,
      };
    }
    return casOk(this.goal);
  }

  async listSessions(query?: SessionQuery): Promise<readonly Session[]> {
    return this.sessionStore.listSessions(query);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.sessionStore.createSession(input);
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessionStore.getSession(sessionId);
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason" | "stopStatus">>,
    opts?: CasOpts,
  ): Promise<CasMutationResult<Session | undefined>> {
    return this.sessionStore.updateSession(sessionId, updates, opts);
  }

  async archiveSession(
    sessionId: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<Session | undefined>> {
    return this.sessionStore.archiveSession(sessionId, opts);
  }

  async addContributionToSession(sessionId: string, cid: string): Promise<void> {
    await this.sessionStore.addContribution(sessionId, cid);
  }

  async getSessionContributions(sessionId: string): Promise<readonly string[]> {
    return this.sessionStore.getContributions(sessionId);
  }

  async deleteSession(
    sessionId: string,
    options?: SessionDeleteOptions & CasOpts,
  ): Promise<CasMutationResult<SessionDeleteResult>> {
    return this.sessionStore.deleteSession(sessionId, options);
  }

  async listSessionDeleteBlockers(sessionId: string): Promise<readonly SessionDeleteBlocker[]> {
    return this.sessionStore.listSessionDeleteBlockers(sessionId);
  }

  async getSessionConfig(_sessionId: string): Promise<GroveContract | undefined> {
    return undefined;
  }

  getSessionConfigSync(_sessionId: string): GroveContract | undefined {
    return undefined;
  }

  gcStaleSessions(_ttlMs?: number): number {
    return 0;
  }

  close(): void {
    /* test store */
  }
}

describe("PUT /api/session/goal — @Dangerous + If-Match plumbing (C6 #304)", () => {
  test("missing If-Match → 428 and store.setGoal not called", async () => {
    const goalSessionStore = new TestGoalStore();
    // Seed an existing goal so the update path goes through CAS.
    await goalSessionStore.setGoal("seeded goal", [], "operator");
    const beforeCalls = goalSessionStore.setGoalCalls.length;

    const { app } = createTestApp({ goalSessionStore });
    const res = await app.request("/api/session/goal", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "updated goal", acceptance: [] }),
    });

    expect(res.status).toBe(428);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
    expect(goalSessionStore.setGoalCalls.length).toBe(beforeCalls);
    expect((await goalSessionStore.getGoal())?.goal).toBe("seeded goal");
  });

  test("stale If-Match → 409 with current snapshot", async () => {
    const goalSessionStore = new TestGoalStore();
    await goalSessionStore.setGoal("seeded goal", [], "operator");
    // External mutation bumps RV from 1 → 2.
    await goalSessionStore.setGoal("rev2 goal", [], "operator", { ifMatch: "1" });
    expect((await goalSessionStore.getGoal())?.resourceVersion).toBe(2);

    const { app } = createTestApp({ goalSessionStore });
    const res = await app.request("/api/session/goal", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json", "if-match": "1" },
      body: JSON.stringify({ goal: "rev3 goal", acceptance: [] }),
    });

    expect(res.status).toBe(409);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.current.resourceVersion).toBe("2");
    // Goal must not have advanced.
    expect((await goalSessionStore.getGoal())?.goal).toBe("rev2 goal");
  });

  test("fresh If-Match → 200 and store called with ifMatch", async () => {
    const goalSessionStore = new TestGoalStore();
    await goalSessionStore.setGoal("seeded goal", [], "operator");

    const { app } = createTestApp({ goalSessionStore });
    const res = await app.request("/api/session/goal", {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json", "if-match": "1" },
      body: JSON.stringify({ goal: "rev2 goal", acceptance: ["criterion"] }),
    });

    expect(res.status).toBe(200);
    expect(goalSessionStore.setGoalCalls.at(-1)).toEqual({
      goal: "rev2 goal",
      ifMatch: "1",
    });
    const after = await goalSessionStore.getGoal();
    expect(after?.goal).toBe("rev2 goal");
    expect(after?.resourceVersion).toBe(2);
  });
});
