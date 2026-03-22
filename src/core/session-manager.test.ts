import { describe, expect, test } from "bun:test";
import { InMemorySessionStore } from "./in-memory-session-store.js";
import { SessionManager } from "./session-manager.js";

describe("SessionManager", () => {
  test("createSession creates a new pending session", async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    const session = await manager.createSession({
      goal: "Build auth module",
      presetName: "review-loop",
    });

    expect(session.id).toBeTruthy();
    expect(session.goal).toBe("Build auth module");
    expect(session.presetName).toBe("review-loop");
    expect(session.status).toBe("pending");
  });

  test("startSession marks session as running", async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    const session = await manager.createSession({
      goal: "Test",
      presetName: "review-loop",
    });
    await manager.startSession(session.id);

    const updated = await store.get(session.id);
    expect(updated!.status).toBe("running");
  });

  test("completeSession marks session as completed", async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    const session = await manager.createSession({
      goal: "Test",
      presetName: "review-loop",
    });
    await manager.startSession(session.id);
    await manager.completeSession(session.id, "Target metric reached");

    const updated = await store.get(session.id);
    expect(updated!.status).toBe("completed");
    expect(updated!.stopReason).toBe("Target metric reached");
    expect(updated!.completedAt).toBeTruthy();
  });

  test("cancelSession marks session as cancelled", async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    const session = await manager.createSession({
      goal: "Test",
      presetName: "review-loop",
    });
    await manager.cancelSession(session.id);

    const updated = await store.get(session.id);
    expect(updated!.status).toBe("cancelled");
  });

  test("listSessions returns all sessions sorted by recency", async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    await manager.createSession({ goal: "First", presetName: "review-loop" });
    await manager.createSession({ goal: "Second", presetName: "review-loop" });
    await manager.createSession({
      goal: "Third",
      presetName: "research-loop",
    });

    const all = await manager.listSessions();
    expect(all).toHaveLength(3);

    const reviewOnly = await manager.listSessions("review-loop");
    expect(reviewOnly).toHaveLength(2);
  });

  test("latestSession returns most recent", async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    await manager.createSession({ goal: "First", presetName: "review-loop" });
    await manager.createSession({ goal: "Second", presetName: "review-loop" });

    const latest = await manager.latestSession("review-loop");
    expect(latest!.goal).toBe("Second");
  });

  test("hasActiveSession detects running sessions", async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    expect(await manager.hasActiveSession()).toBe(false);

    const session = await manager.createSession({
      goal: "Test",
      presetName: "p",
    });
    await manager.startSession(session.id);

    expect(await manager.hasActiveSession()).toBe(true);

    await manager.completeSession(session.id);
    expect(await manager.hasActiveSession()).toBe(false);
  });

  test("multiple sessions reuse same preset", async () => {
    const store = new InMemorySessionStore();
    const manager = new SessionManager(store);

    const s1 = await manager.createSession({
      goal: "Add auth",
      presetName: "review-loop",
    });
    await manager.startSession(s1.id);
    await manager.completeSession(s1.id);

    const s2 = await manager.createSession({
      goal: "Add validation",
      presetName: "review-loop",
    });
    await manager.startSession(s2.id);

    expect(s1.id).not.toBe(s2.id);
    expect(s1.presetName).toBe(s2.presetName);

    const all = await manager.listSessions("review-loop");
    expect(all).toHaveLength(2);
  });
});
