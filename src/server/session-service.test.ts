import { describe, expect, test } from "bun:test";
import type { GroveContract } from "../core/contract.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { MockRuntime } from "../core/mock-runtime.js";
import type { SessionEvent } from "./session-service.js";
import { SessionService } from "./session-service.js";

function makeContract(overrides?: Partial<GroveContract>): GroveContract {
  return {
    contractVersion: 2,
    name: "test",
    topology: {
      structure: "graph",
      roles: [
        {
          name: "coder",
          description: "Write code",
          command: "echo coder",
          edges: [{ target: "reviewer", edgeType: "delegates" }],
        },
        {
          name: "reviewer",
          description: "Review code",
          command: "echo reviewer",
          edges: [{ target: "coder", edgeType: "feedback" }],
        },
      ],
    },
    ...overrides,
  };
}

describe("SessionService", () => {
  test("constructor throws when contract has no topology", () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    expect(
      () =>
        new SessionService({
          contract: { contractVersion: 2, name: "test" },
          runtime,
          eventBus: bus,
          projectRoot: "/tmp",
          workspaceBaseDir: "/tmp/workspaces",
        }),
    ).toThrow("topology");
    bus.close();
  });

  test("getState returns pending before session starts", () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const state = service.getState();
    expect(state.status).toBe("pending");
    expect(state.goal).toBe("");
    expect(state.agents).toHaveLength(0);
    expect(state.contributions).toBe(0);

    service.destroy();
    bus.close();
  });

  test("startSession spawns agents and returns running state", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const state = await service.startSession("Build auth module");

    expect(state.status).toBe("running");
    expect(state.goal).toBe("Build auth module");
    expect(state.agents).toHaveLength(2);
    expect(runtime.spawnCalls).toHaveLength(2);

    service.destroy();
    bus.close();
  });

  test("startSession uses custom sessionId", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const state = await service.startSession("Test", "my-session-42");
    expect(state.id).toBe("my-session-42");

    service.destroy();
    bus.close();
  });

  test("onEvent pushes agent_spawned events during startSession", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const events: SessionEvent[] = [];
    service.onEvent((e) => events.push(e));

    await service.startSession("Build it");

    const spawnEvents = events.filter((e) => e.type === "agent_spawned");
    expect(spawnEvents).toHaveLength(2);
    expect(spawnEvents.map((e) => (e as { role: string }).role).sort()).toEqual([
      "coder",
      "reviewer",
    ]);

    service.destroy();
    bus.close();
  });

  test("onEvent returns unsubscribe function", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const events: SessionEvent[] = [];
    const unsub = service.onEvent((e) => events.push(e));

    // Unsubscribe before starting
    unsub();

    await service.startSession("Build it");

    // No events should have been received
    expect(events).toHaveLength(0);

    service.destroy();
    bus.close();
  });

  test("contribution events increment count and push to listeners", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const events: SessionEvent[] = [];
    service.onEvent((e) => events.push(e));

    await service.startSession("Test");

    // Simulate a contribution event from the coder to the reviewer
    bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: { cid: "blake3:abc", kind: "work", summary: "Added auth" },
      timestamp: new Date().toISOString(),
    });

    const contribEvents = events.filter((e) => e.type === "contribution");
    expect(contribEvents).toHaveLength(1);

    const state = service.getState();
    expect(state.contributions).toBe(1);

    service.destroy();
    bus.close();
  });

  test("stop events from all roles trigger session_complete", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const events: SessionEvent[] = [];
    service.onEvent((e) => events.push(e));

    await service.startSession("Test");

    // Simulate stop events from both roles
    bus.publish({
      type: "stop",
      sourceRole: "coder",
      targetRole: "coder",
      payload: { reason: "done" },
      timestamp: new Date().toISOString(),
    });
    bus.publish({
      type: "stop",
      sourceRole: "reviewer",
      targetRole: "reviewer",
      payload: { reason: "done" },
      timestamp: new Date().toISOString(),
    });

    const completeEvents = events.filter((e) => e.type === "session_complete");
    expect(completeEvents.length).toBeGreaterThanOrEqual(1);
    expect(service.getState().status).toBe("complete");

    service.destroy();
    bus.close();
  });

  test("stopSession closes agents and emits session_complete", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const events: SessionEvent[] = [];
    service.onEvent((e) => events.push(e));

    await service.startSession("Test");
    await service.stopSession("Budget exceeded");

    const completeEvents = events.filter((e) => e.type === "session_complete");
    expect(completeEvents).toHaveLength(1);
    expect((completeEvents[0] as { reason: string }).reason).toBe("Budget exceeded");
    expect(service.getState().status).toBe("complete");
    expect(runtime.closeCalls).toHaveLength(2);

    service.destroy();
    bus.close();
  });

  test("stopSession is a no-op before startSession", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    // Should not throw
    await service.stopSession("early stop");
    expect(service.getState().status).toBe("pending");

    service.destroy();
    bus.close();
  });

  test("destroy cleans up event subscriptions", () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    // Should not throw
    service.destroy();

    // Publishing after destroy should not cause errors
    bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    bus.close();
  });

  test("listener errors are caught and do not propagate", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const service = new SessionService({
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const goodEvents: SessionEvent[] = [];

    // Register a listener that throws
    service.onEvent(() => {
      throw new Error("bad listener");
    });

    // Register a good listener after the bad one
    service.onEvent((e) => goodEvents.push(e));

    // Should not throw despite the bad listener
    await service.startSession("Test");

    expect(goodEvents.length).toBeGreaterThan(0);

    service.destroy();
    bus.close();
  });
});
