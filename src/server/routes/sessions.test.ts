import { describe, expect, test } from "bun:test";

import { type CasMutationResult, type CasOpts, casOk } from "../../core/cas.js";
import type { GroveContract } from "../../core/contract.js";
import { InMemorySessionStore } from "../../core/in-memory-session-store.js";
import { Finalizer } from "../../core/lifecycle-metadata.js";
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

class TestGoalSessionStore implements GoalSessionStore {
  private readonly store = new InMemorySessionStore();
  private readonly blockedSessionIds = new Set<string>();
  readonly deleteCalls: {
    readonly id: string;
    readonly options: (SessionDeleteOptions & CasOpts) | undefined;
  }[] = [];
  readonly archiveCalls: {
    readonly id: string;
    readonly options: CasOpts | undefined;
  }[] = [];

  blockDelete(sessionId: string): void {
    this.blockedSessionIds.add(sessionId);
  }

  async getGoal(): Promise<GoalData | undefined> {
    return undefined;
  }

  async setGoal(
    goal: string,
    acceptance: readonly string[],
    setBy: string,
  ): Promise<CasMutationResult<GoalData>> {
    return casOk({
      goal,
      acceptance,
      status: "active",
      setAt: new Date().toISOString(),
      setBy,
      resourceVersion: 1,
    });
  }

  async listSessions(query?: SessionQuery): Promise<readonly Session[]> {
    return this.store.listSessions(query);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.store.createSession(input);
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.store.getSession(sessionId);
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason" | "stopStatus">>,
    opts?: CasOpts,
  ): Promise<CasMutationResult<Session | undefined>> {
    return this.store.updateSession(sessionId, updates, opts);
  }

  async archiveSession(
    sessionId: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<Session | undefined>> {
    this.archiveCalls.push({ id: sessionId, options: opts });
    return this.store.archiveSession(sessionId, opts);
  }

  async addContributionToSession(sessionId: string, cid: string): Promise<void> {
    await this.store.addContribution(sessionId, cid);
  }

  async getSessionContributions(sessionId: string): Promise<readonly string[]> {
    return this.store.getContributions(sessionId);
  }

  async deleteSession(
    sessionId: string,
    options?: SessionDeleteOptions & CasOpts,
  ): Promise<CasMutationResult<SessionDeleteResult>> {
    this.deleteCalls.push({ id: sessionId, options });
    if (this.blockedSessionIds.has(sessionId) && options?.force !== true) {
      const session = await this.store.getSession(sessionId);
      if (!session) return this.store.deleteSession(sessionId, options);
      return casOk({
        sessionId,
        deleted: false,
        forced: false,
        blockers: await this.listSessionDeleteBlockers(sessionId),
      });
    }
    return this.store.deleteSession(sessionId, options);
  }

  async listSessionDeleteBlockers(sessionId: string): Promise<readonly SessionDeleteBlocker[]> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }];
    }
    if (!this.blockedSessionIds.has(sessionId)) return [];
    return [{ finalizer: Finalizer.CloseRuntime, message: "runtime still active" }];
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

describe("session routes", () => {
  test("GET /api/sessions/:id exposes lifecycle metadata", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "metadata" });
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}`, {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.sessionId).toBe(session.id);
    expect(data.uid).toBe(session.uid);
    expect(data.finalizers).toEqual(session.finalizers);
    expect(data.deletionTimestamp).toBeUndefined();
    expect(data.deletionAudit).toBeUndefined();
  });

  test("GET /api/sessions/:id/delete-blockers returns blockers for an existing session", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "blocked" });
    goalSessionStore.blockDelete(session.id);
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}/delete-blockers`, {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: session.id,
      blockers: [{ finalizer: Finalizer.CloseRuntime, message: "runtime still active" }],
    });
  });

  test("GET /api/sessions/:id/delete-blockers returns 404 when the session is missing", async () => {
    const { app } = createTestApp({ goalSessionStore: new TestGoalSessionStore() });

    const res = await app.request("/api/sessions/missing/delete-blockers", {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Session not found: missing" },
    });
  });

  test("GET /api/sessions/:id/delete-blockers returns not configured without a goalSessionStore", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions/missing/delete-blockers", {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: { code: "NOT_CONFIGURED", message: "Goal/session store is not configured" },
    });
  });

  test("DELETE /api/sessions/:id deletes an unblocked session", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "delete" });
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: session.id,
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(await goalSessionStore.getSession(session.id)).toBeUndefined();
    expect(goalSessionStore.deleteCalls).toEqual([
      { id: session.id, options: { ifMatch: "1", force: false, actor: "http" } },
    ]);
  });

  test("DELETE /api/sessions/:id returns 409 when normal delete is blocked", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "blocked" });
    goalSessionStore.blockDelete(session.id);
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      sessionId: session.id,
      deleted: false,
      forced: false,
      blockers: [{ finalizer: Finalizer.CloseRuntime, message: "runtime still active" }],
    });
    expect(await goalSessionStore.getSession(session.id)).toBeDefined();
  });

  test("DELETE /api/sessions/:id?force=true passes force and actor", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "force" });
    goalSessionStore.blockDelete(session.id);
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}?force=true`, {
      method: "DELETE",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.deleted).toBe(true);
    expect(data.forced).toBe(true);
    expect(goalSessionStore.deleteCalls).toEqual([
      { id: session.id, options: { ifMatch: "1", force: true, actor: "http" } },
    ]);
  });

  test("DELETE /api/sessions/:id returns 404 when the session is missing", async () => {
    const { app } = createTestApp({ goalSessionStore: new TestGoalSessionStore() });

    const res = await app.request("/api/sessions/missing", {
      method: "DELETE",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Session not found: missing" },
    });
  });

  test("DELETE /api/sessions/:id returns not configured without a goalSessionStore", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/sessions/missing", {
      method: "DELETE",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: { code: "NOT_CONFIGURED", message: "Goal/session store is not configured" },
    });
  });

  // -----------------------------------------------------------------------
  // C6 #304: @Dangerous middleware + If-Match plumbing on DELETE
  // -----------------------------------------------------------------------

  test("DELETE /api/sessions/:id without If-Match → 428 and store.deleteSession not called", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "no-if-match" });
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(428);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
    // Critical: middleware must short-circuit before the handler/store —
    // not even getSession should have been touched, but deleteSession
    // is the surface we explicitly guard so assert on it.
    expect(goalSessionStore.deleteCalls).toHaveLength(0);
    // Session must still exist.
    expect(await goalSessionStore.getSession(session.id)).toBeDefined();
  });

  test("DELETE /api/sessions/:id with stale If-Match → 409 with current snapshot", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "stale" });
    // External mutation: bump RV so the caller's If-Match=1 becomes stale.
    await goalSessionStore.updateSession(session.id, { status: "active" });
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(409);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CONFLICT");
    // The store bumped RV from 1 → 2 on the external updateSession.
    expect(body.error.current.resourceVersion).toBe("2");
    expect(body.error.current.generation).toBe(2);
    // Session must still exist — CAS mismatch must not delete.
    expect(await goalSessionStore.getSession(session.id)).toBeDefined();
  });

  test("DELETE /api/sessions/:id with fresh If-Match → 200 and store called with ifMatch", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "fresh" });
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.deleted).toBe(true);
    // Store received the ifMatch in the options bag.
    expect(goalSessionStore.deleteCalls.at(-1)).toMatchObject({
      id: session.id,
      options: { ifMatch: "1", force: false, actor: "http" },
    });
  });

  // -----------------------------------------------------------------------
  // C6 #304: @Dangerous middleware + If-Match plumbing on PUT /:id/archive
  // -----------------------------------------------------------------------

  test("PUT /api/sessions/:id/archive without If-Match → 428 and store not called", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "no-if-match-archive" });
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}/archive`, {
      method: "PUT",
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(428);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
    expect(goalSessionStore.archiveCalls).toHaveLength(0);
    // Session must remain in original state.
    expect((await goalSessionStore.getSession(session.id))?.status).not.toBe("archived");
  });

  test("PUT /api/sessions/:id/archive with stale If-Match → 409 with current snapshot", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "stale-archive" });
    // External mutation bumps RV from 1 → 2 so the caller's If-Match=1 is stale.
    await goalSessionStore.updateSession(session.id, { status: "active" });
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}/archive`, {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(409);
    // biome-ignore lint/suspicious/noExplicitAny: test file
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.current.resourceVersion).toBe("2");
    // Session must not have been archived.
    expect((await goalSessionStore.getSession(session.id))?.status).not.toBe("archived");
  });

  test("PUT /api/sessions/:id/archive with fresh If-Match → 204 and store called with ifMatch", async () => {
    const goalSessionStore = new TestGoalSessionStore();
    const session = await goalSessionStore.createSession({ goal: "fresh-archive" });
    const { app } = createTestApp({ goalSessionStore });

    const res = await app.request(`/api/sessions/${session.id}/archive`, {
      method: "PUT",
      headers: { ...TEST_AUTH_HEADERS, "if-match": "1" },
    });

    expect(res.status).toBe(204);
    expect(goalSessionStore.archiveCalls.at(-1)).toEqual({
      id: session.id,
      options: { ifMatch: "1" },
    });
    expect((await goalSessionStore.getSession(session.id))?.status).toBe("archived");
  });
});
