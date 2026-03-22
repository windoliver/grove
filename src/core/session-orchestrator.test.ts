import { describe, expect, test } from "bun:test";
import { MockRuntime } from "./mock-runtime.js";
import { LocalEventBus } from "./local-event-bus.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import type { GroveContract } from "./contract.js";

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

describe("SessionOrchestrator", () => {
  test("start spawns agents for all roles", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const status = await orchestrator.start();

    expect(status.started).toBe(true);
    expect(status.agents).toHaveLength(2);
    expect(runtime.spawnCalls).toHaveLength(2);
    expect(status.agents.map((a) => a.role).sort()).toEqual([
      "coder",
      "reviewer",
    ]);
    bus.close();
  });

  test("start sends goals to all agents", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();

    // Each agent gets a send call with the goal
    expect(runtime.sendCalls).toHaveLength(2);
    expect(runtime.sendCalls[0]!.message).toContain("Build auth module");
    bus.close();
  });

  test("stop closes all agents", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();
    await orchestrator.stop("Budget exceeded");

    const status = orchestrator.getStatus();
    expect(status.stopped).toBe(true);
    expect(status.stopReason).toBe("Budget exceeded");
    expect(runtime.closeCalls).toHaveLength(2);
    bus.close();
  });

  test("throws when contract has no topology", () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();

    expect(
      () =>
        new SessionOrchestrator({
          goal: "test",
          contract: { contractVersion: 2, name: "test" },
          runtime,
          eventBus: bus,
          projectRoot: "/tmp",
          workspaceBaseDir: "/tmp/workspaces",
        }),
    ).toThrow("topology");
    bus.close();
  });

  test("getStatus returns correct state", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Test goal",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const before = orchestrator.getStatus();
    expect(before.started).toBe(false);
    expect(before.stopped).toBe(false);

    await orchestrator.start();
    const after = orchestrator.getStatus();
    expect(after.started).toBe(true);
    expect(after.goal).toBe("Test goal");
    bus.close();
  });

  test("events are forwarded to agents", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Test",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();

    // Simulate a contribution event being published to the reviewer
    bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: { cid: "blake3:abc", summary: "Added auth" },
      timestamp: new Date().toISOString(),
    });

    // The reviewer agent should have received a forwarded message
    // (2 sends from start goals + 1 from event forwarding)
    expect(runtime.sendCalls.length).toBe(3);
    expect(runtime.sendCalls[2]!.message).toContain("coder");
    bus.close();
  });

  test("stop events are not forwarded to agents", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Test",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();

    // Publish a stop event to a role — should NOT be forwarded
    bus.publish({
      type: "stop",
      sourceRole: "system",
      targetRole: "coder",
      payload: { reason: "done" },
      timestamp: new Date().toISOString(),
    });

    // Only 2 sends from start goals, no forwarded stop
    expect(runtime.sendCalls.length).toBe(2);
    bus.close();
  });

  test("uses custom sessionId when provided", () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Test",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
      sessionId: "custom-id-123",
    });

    expect(orchestrator.getStatus().sessionId).toBe("custom-id-123");
    bus.close();
  });

  test("uses role prompt over description for goal", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [
          {
            name: "writer",
            description: "A writer agent",
            prompt: "Write high-quality documentation",
            command: "echo writer",
          },
        ],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Document the API",
      contract,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();

    // The prompt should be preferred over description
    expect(runtime.sendCalls[0]!.message).toContain(
      "Write high-quality documentation",
    );
    expect(runtime.sendCalls[0]!.message).not.toContain("A writer agent");
    bus.close();
  });

  test("falls back to description when no prompt", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [
          {
            name: "worker",
            description: "Do the work",
            command: "echo worker",
          },
        ],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Build it",
      contract,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();

    expect(runtime.sendCalls[0]!.message).toContain("Do the work");
    bus.close();
  });

  test("defaults command to claude when role has no command", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const contract = makeContract({
      topology: {
        structure: "flat",
        roles: [{ name: "helper", description: "Help out" }],
      },
    });

    const orchestrator = new SessionOrchestrator({
      goal: "Help",
      contract,
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();

    expect(runtime.spawnCalls[0]!.config.command).toBe("claude");
    bus.close();
  });

  test("all agents idle triggers auto-stop", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    const status = await orchestrator.start();
    expect(status.stopped).toBe(false);

    // Set all agent sessions to idle
    for (const agent of status.agents) {
      runtime.setSessionStatus(agent.session.id, "idle");
    }

    // Trigger idle check
    const stopped = await orchestrator.checkIdleCompletion();
    expect(stopped).toBe(true);

    const finalStatus = orchestrator.getStatus();
    expect(finalStatus.stopped).toBe(true);
    expect(finalStatus.stopReason).toBe("All agents idle — session complete");
    bus.close();
  });

  test("checkIdleCompletion returns false when agents are still running", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();

    // Agents are still running — should not stop
    const stopped = await orchestrator.checkIdleCompletion();
    expect(stopped).toBe(false);
    expect(orchestrator.getStatus().stopped).toBe(false);
    bus.close();
  });

  test("resumeAgent spawns new session and sends reconciliation message", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();
    const initialSpawnCount = runtime.spawnCalls.length;
    const initialSendCount = runtime.sendCalls.length;

    // Resume the coder role
    const resumed = await orchestrator.resumeAgent("coder");

    expect(resumed.role).toBe("coder");
    // Should have spawned a new session
    expect(runtime.spawnCalls.length).toBe(initialSpawnCount + 1);
    // Should have sent goal + reconciliation message
    expect(runtime.sendCalls.length).toBe(initialSendCount + 1);
    expect(runtime.sendCalls[runtime.sendCalls.length - 1]!.message).toContain(
      "resuming role 'coder'",
    );

    // The agent list should still have 2 agents (replaced, not duplicated)
    expect(orchestrator.getStatus().agents).toHaveLength(2);
    bus.close();
  });

  test("resumeAgent throws for unknown role", async () => {
    const runtime = new MockRuntime();
    const bus = new LocalEventBus();
    const orchestrator = new SessionOrchestrator({
      goal: "Build auth module",
      contract: makeContract(),
      runtime,
      eventBus: bus,
      projectRoot: "/tmp",
      workspaceBaseDir: "/tmp/workspaces",
    });

    await orchestrator.start();

    await expect(orchestrator.resumeAgent("nonexistent")).rejects.toThrow("not found in topology");
    bus.close();
  });
});
